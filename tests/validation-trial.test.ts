import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { ValidationTrialService } from '../src/application/validation-trial-service.js';
import { ApiClient } from '../src/client/api-client.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';
import type { ExperimentExecutionPlan } from '../src/contracts/runner-rpc.js';
import type { ValidationAssetDraft } from '../src/contracts/validation-assets.js';
import { isolateCmakeBuildCommand, isolatedCmakeArtifact, commandBuild } from '../src/config/build-command.js';
import { fixtureRunnerStoreId, guardFixtureRunnerRequest } from './guarded-runner-fixture.js';

test('CMake build isolation preserves flags, quoting, subdirectory source roots and separate build trees', () => {
  const command = '# build fixture\ncmake -S. -B"build output" -G "Unix Makefiles" \\\n  \'-DCMAKE_CXX_FLAGS=-O2 -DNAME=cmake -B keep\' && cmake --build "build output" --target kernel -j8\ncmake --install "build output"';
  const expected = '# build fixture\ncmake -S"$COREPILOT_SOURCE_ROOT" -B"$COREPILOT_BUILD_ROOT" -G "Unix Makefiles" \\\n  \'-DCMAKE_CXX_FLAGS=-O2 -DNAME=cmake -B keep\' && cmake --build "$COREPILOT_BUILD_ROOT" --target kernel -j8\ncmake --install "$COREPILOT_BUILD_ROOT"';
  assert.equal(isolateCmakeBuildCommand(command), expected);
  assert.equal(isolateCmakeBuildCommand(expected), expected, 'reloading an isolated command is idempotent');
  assert.equal(isolateCmakeBuildCommand('cmake -S . -B build\ncmake --build ./build', 'native'),
    'cmake -S . -B "$COREPILOT_BUILD_ROOT"\ncmake --build "$COREPILOT_BUILD_ROOT"');
  assert.equal(isolateCmakeBuildCommand('cmake -S a -B build-a; cmake -S b -B build-b; cmake --build build-b'),
    'cmake -S a -B "$COREPILOT_BUILD_ROOT"; cmake -S b -B "$COREPILOT_BUILD_ROOT/tree-2"; cmake --build "$COREPILOT_BUILD_ROOT/tree-2"');
  for (const custom of ["printf '%s' 'cmake -S . -B build'", 'bash build-library.sh', 'cmake -P build.cmake',
    'cmake -S src -B "$MY_BUILD_ROOT"', 'cmake -S src -B /opt/custom/build', "cat <<'EOF'\ncmake -S . -B build\nEOF"])
    assert.equal(isolateCmakeBuildCommand(custom), custom, 'custom scripts and explicit external build paths remain literal');
  const build = commandBuild(command, { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 1000 });
  assert.equal(isolatedCmakeArtifact(build, 'build output/libkernel.so'), 'libkernel.so');
  assert.equal(isolatedCmakeArtifact(build, 'prebuilt/libkernel.so'), null);
  assert.equal(isolatedCmakeArtifact(commandBuild('cmake -S . -B build', { ...build, cwd: 'native' }), 'native/build/libkernel.so'), 'libkernel.so');
  assert.equal(isolatedCmakeArtifact(commandBuild('cmake -S a -B ba; cmake -S b -B bb', build), 'bb/libkernel.so'), 'tree-2/libkernel.so');
});

test('trial returns its ID before staging finishes, recovers via API and freezes branch bytes once', async () => {
  const f = await startWebFixture();
  let release!: () => void;
  const staging = new Promise<void>(resolve => { release = resolve; });
  let submitted = 0;
  let remoteId = '';
  let submittedPlan: ExperimentExecutionPlan | null = null;
  const bytes = Buffer.from('Runner-built fixture artifact');
  const rawCommand = 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build -j2';
  const isolatedCommand = 'cmake -S "$COREPILOT_SOURCE_ROOT" -B "$COREPILOT_BUILD_ROOT" -DCMAKE_BUILD_TYPE=Release\ncmake --build "$COREPILOT_BUILD_ROOT" -j2';
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = http.createServer((req, res) => {
    if (!guardFixtureRunnerRequest(req, res)) return;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ runner_id: 'trial-fixture', protocol_version: RUNNER_PROTOCOL_VERSION,
      store_instance_id: fixtureRunnerStoreId, status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { controlled_validation: 1, source_archive_upload: 1, store_identity_guard: 1, artifact_path_check: 1 } }));
    else if (req.url === '/machine') res.end(JSON.stringify({ hostname: 'fixture', architecture: 'aarch64', cpu_count: 2,
      machine_identity_sha256: 'a'.repeat(64) }));
    else if (req.url?.startsWith('/source-archives?') && req.method === 'PUT') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => { await staging; const query = new URL(req.url!, 'http://runner').searchParams;
        const body = Buffer.concat(chunks); const sha = createHash('sha256').update(body).digest('hex');
        assert.equal(sha, query.get('sha256'));
        res.end(JSON.stringify({ workspace_path: query.get('workspace_path'), archive_sha256: sha, archive_bytes: body.length, source_sha256: 'b'.repeat(64) })); });
    } else if (req.url?.endsWith('/output')) res.end(JSON.stringify({ stdout: '', stderr: '', artifacts: submittedPlan ? [{
      relative_path: 'build/libfixture.so', source_path: submittedPlan.build_directory + '/libfixture.so',
      path: submittedPlan.output_directory!.replace(/\/logs$/, '/artifacts/build/libfixture.so'), sha256: digest, bytes: bytes.length }] : [] }));
    else if (req.url === '/experiments' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const plan = JSON.parse(Buffer.concat(chunks).toString());
        submittedPlan = plan;
        submitted++;
        remoteId = plan.experiment.experiment_id;
        res.end(JSON.stringify({ experiment_id: remoteId, status: 'PENDING' }));
      });
    } else if (req.url?.endsWith('/commands')) res.end(JSON.stringify({ command_executions: [] }));
    else if (req.url?.endsWith('/measurements')) res.end(JSON.stringify({ measurements: [] }));
    else res.end(JSON.stringify({ experiment_id: remoteId, status: 'SUCCEEDED', failure: null }));
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const address = runner.address(); assert.ok(address && typeof address === 'object');
    const project = f.projects.add({ name: 'Trial', repository_root: f.repo });
    const discovery = await f.projects.discover(project.project_id, 'kernel', { command: rawCommand, cwd: '.' });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: { mode: 'rpc',
      endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture', request_timeout_ms: 10_000, poll_interval_ms: 100 } });
    const trials = new ValidationTrialService(f.dataDir, f.projects.machines, () => ({
      async runRemote(argv) {
        if (argv[0] === 'sha256sum') return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: `${digest}  artifact.so\n` };
        await staging;
        return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: '' };
      },
      uploadFile() { return { exit_code: 0, stderr: '' }; },
      downloadFile(_remote, local) { fs.writeFileSync(local, bytes); return { exit_code: 0, stderr: '' }; },
    }));
    (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
    const api = new ApiClient(f.url, { token: f.token });
    const input = { package_id: discovery.evidence.generated.package_id, package_version: discovery.evidence.generated.version,
      target_id: discovery.targets[0].target_id, source_branch: 'main', purpose: 'BASELINE_BUILD',
      build: { command: rawCommand, cwd: '.' } };
    const contextUrl = `validation-assets/${input.package_id}/${input.package_version}/${input.target_id}/context`;
    const before = await api.projectAction(project.project_id, contextUrl) as { package_digest: string; build: unknown };
    await assert.rejects(api.projectAction(project.project_id, 'validation-trials', { ...input, build: { ...input.build, cwd: '../escape' } }), /相对路径/);
    await assert.rejects(api.projectAction(project.project_id, 'validation-trials', { ...input, expected_package_digest: '0'.repeat(64) }), /已变化/);
    const start = await api.projectAction(project.project_id, 'validation-trials', input) as { trial_id: string; status: string };
    assert.equal(start.status, 'PREPARING');
    assert.equal(submitted, 0);
    const preparing = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(start.trial_id)}`) as { status: { status: string } };
    assert.equal(preparing.status.status, 'PREPARING');
    release();
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await trials.status(project, start.trial_id);
      if (status.status.status === 'SUCCEEDED') break;
      await delay(20);
    }
    assert.equal((await trials.status(project, start.trial_id)).status.status, 'SUCCEEDED');
    assert.equal(trials.list(project)[0].trial_id, start.trial_id);
    const saved = trials.list(project)[0];
    assert.equal(saved.runner_store_instance_id, fixtureRunnerStoreId);
    assert.match(saved.remote_workspace!.run_root, /projects\/Trial-.*\/branches\/main-.*\/runs\/.*-baseline-/);
    assert.equal(saved.build_definition!.args.at(-1), isolatedCommand);
    assert.equal(saved.requested_build_definition!.args.at(-1), rawCommand);
    assert.equal(saved.build!.environment.COREPILOT_BUILD_ROOT, saved.remote_workspace!.build_root);
    assert.ok(submittedPlan);
    assert.equal((submittedPlan as ExperimentExecutionPlan).experiment.declared_context.runner_store_instance_id, fixtureRunnerStoreId);
    assert.equal((submittedPlan as ExperimentExecutionPlan).steps[0].command.args.at(-1), isolatedCommand);
    assert.equal((submittedPlan as ExperimentExecutionPlan).build_directory, saved.remote_workspace!.build_root);
    const after = await api.projectAction(project.project_id, contextUrl) as typeof before;
    assert.equal(after.package_digest, before.package_digest, 'baseline overrides never rewrite the shared package');
    assert.deepEqual(after.build, before.build);
    const frozen = await f.projects.freezeBranchBaseline(project.project_id, start.trial_id);
    assert.equal(frozen.baseline.sha256, digest);
    assert.equal(fs.readFileSync(frozen.artifact_path).equals(bytes), true);
    const second = await f.projects.freezeBranchBaseline(project.project_id, start.trial_id);
    assert.equal(second.baseline.sha256, digest);
    assert.equal(submitted, 1);
    assert.equal(f.git('status', '--porcelain'), '');
    fs.writeFileSync(frozen.artifact_path, 'changed bytes');
    await assert.rejects(f.projects.freezeBranchBaseline(project.project_id, start.trial_id), /副本发生变化/);
    f.git('branch', 'fix/cmake-cache');
    const cli = await runFixtureCli(f.url, f.token, ['project', 'baseline-branch', project.project_id, input.package_id,
      input.package_version, input.target_id, '--branch', 'fix/cmake-cache']);
    assert.equal(cli.code, 0, cli.stderr);
    const nextId = JSON.parse(cli.stdout).trial_id;
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await trials.status(project, nextId)).status.status === 'SUCCEEDED') break;
      await delay(20);
    }
    const next = trials.list(project)[0];
    assert.equal(next.source_branch, 'fix/cmake-cache');
    assert.equal(next.build_definition!.args.at(-1), isolatedCommand, 'a new branch submitted by CLI isolates the package command without a UI conversion');
    assert.notEqual(next.remote_workspace!.build_root, saved.remote_workspace!.build_root);
    assert.equal((submittedPlan as ExperimentExecutionPlan).steps[0].command.args.at(-1), isolatedCommand);
    assert.equal(submitted, 2);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { release(); await f.close(); await new Promise<void>(resolve => runner.close(() => resolve())); }
});

for (const matrix of [false, true]) test(`comparison pins ${matrix ? 'matrix' : 'legacy'} conditions before staging and retains separate raw samples`, async () => {
  const f = await startWebFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let submitted: ExperimentExecutionPlan | null = null;
  let runnerStatus = 'RUNNING';
  let completedMeasurements = 1;
  const bytes = Buffer.from('frozen comparison bytes');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const runner = http.createServer((req, res) => {
    if (!guardFixtureRunnerRequest(req, res)) return;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ runner_id: 'comparison-fixture', protocol_version: RUNNER_PROTOCOL_VERSION, store_instance_id: fixtureRunnerStoreId, status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { controlled_validation: 1, source_archive_upload: 1, resource_matrix: 1, store_identity_guard: 1, artifact_path_check: 1 } }));
    else if (req.url === '/machine') res.end(JSON.stringify({ hostname: 'fixture', architecture: 'aarch64', cpu_count: 4, machine_identity_sha256: 'a'.repeat(64), cpu_topology: { online_cpus: '0-3', node_cpu_lists: { node0: '0-3' } } }));
    else if (req.url?.startsWith('/source-archives?') && req.method === 'PUT') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => { await gate; const query = new URL(req.url!, 'http://runner').searchParams;
        const body = Buffer.concat(chunks); const sha = createHash('sha256').update(body).digest('hex');
        res.end(JSON.stringify({ workspace_path: query.get('workspace_path'), archive_sha256: sha, archive_bytes: body.length, source_sha256: 'b'.repeat(64) })); });
    } else if (req.url?.endsWith('/output')) res.end(JSON.stringify({ stdout: '', stderr: '', artifacts: [] }));
    else if (req.url === '/experiments' && req.method === 'POST') {
      const chunks: Buffer[] = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { submitted = JSON.parse(Buffer.concat(chunks).toString()); res.end(JSON.stringify({ experiment_id: submitted!.experiment.experiment_id, status: 'PENDING' })); });
    } else if (req.url?.endsWith('/commands')) res.end(JSON.stringify({ command_executions: [] }));
    else if (req.url?.endsWith('/measurements')) {
      const contexts = submitted!.steps.map(item => item.formal_context).filter(item => item && item.phase !== 'PERFORMANCE_WARMUP');
      res.end(JSON.stringify({ measurements: contexts.slice(0, completedMeasurements).map(item => ({ experiment_id: submitted!.experiment.experiment_id, kind: item!.phase === 'CORRECTNESS_CASE' ? 'CORRECTNESS_CASE' : 'PERFORMANCE_SAMPLE',
        role: item!.role, subject_id: item!.subject_id, sample_index: item!.iteration_index,
        value: item!.phase === 'CORRECTNESS_CASE' ? 'PASS' : item!.role === 'BASELINE' ? 2 : 1,
        unit: item!.phase === 'CORRECTNESS_CASE' ? null : 'seconds', validity: 'VALID' })) }));
    } else res.end(JSON.stringify({ experiment_id: submitted?.experiment.experiment_id, status: runnerStatus, current_step: runnerStatus === 'RUNNING' ? 'CORRECTNESS' : null, failure: null }));
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const address = runner.address(); assert.ok(address && typeof address === 'object');
    const project = f.projects.add({ name: 'Controlled comparison', repository_root: f.repo });
    const discovery = await f.projects.discover(project.project_id, 'kernel', { command: 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --target kernel -j2', cwd: '.' });
    const packageId = discovery.evidence.generated.package_id, version = discovery.evidence.generated.version, targetId = discovery.targets[0].target_id;
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture' } });
    const baseline = path.join(f.root, 'baseline.so'); fs.writeFileSync(baseline, bytes);
    await f.projects.validationAssets.bindSingleBaseline(project, packageId, version, targetId, { artifactPath: baseline, sha256: digest,
      library: 'Reference', versionLabel: '1', source: { kind: 'upload', detail: 'comparison test fixture' } });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
      library_package: { package_id: packageId, package_version: version, target_id: targetId }, baseline_artifact: baseline } });
    const original = f.projects.validationAssets.get(project, packageId, version, targetId);
    const saved = f.projects.validationAssets.save(project, packageId, version, targetId, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
      candidate_artifact: 'build/lib/libfixture.so',
      test_plan: { ...original.test_plan, resources: { cpu_set: '0-1', numa_node: 0 }, seed: 42, inner_iterations: 17,
        sampling: { warmup_count: 1, sample_count: 2, order: 'alternating' },
        ...(matrix ? { execution_matrix: { thread_counts: [1, 2], profiles: [
          { id: 'pool0', name: '按线程分配', cpu_set: '0-1', numa_node: 0, cpu_allocation: 'per_thread', omp_proc_bind: 'close' },
          { id: 'pool1', name: '固定 CPU 池', cpu_set: '2-3', numa_node: 0, cpu_allocation: 'shared', omp_proc_bind: 'spread' },
        ] } } : {}) },
      cases: [{ case_id: 'check', threads: 1, parameters: { length: 64 } }],
      workloads: [{ workload_id: 'length-64', threads: 1, parameters: { length: 64 }, critical: true, weight: 1 }] });
    const trials = new ValidationTrialService(f.dataDir, f.projects.machines, () => ({
      async runRemote(argv) { await gate; return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: argv[2]?.includes('sha256sum') ? `${digest}  artifact.so\n` : '' }; },
      uploadFile() { return { exit_code: 0, stderr: '' }; },
    }));
    (f.projects as unknown as { validationTrials: ValidationTrialService }).validationTrials = trials;
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(trials.start(project, packageId, version, targetId, undefined, 'VALIDATION_DRAFT', { mode: 'comparison', expected_digest: '0'.repeat(64) }), /已变化/);
    const start = await trials.start(project, packageId, version, targetId, undefined, 'VALIDATION_DRAFT', { mode: 'comparison', expected_digest: saved.evaluator_digest });
    assert.equal(submitted, null);
    const newer = f.projects.validationAssets.save(project, packageId, version, targetId, { ...saved, source: 'edited', expected_digest: saved.evaluator_digest,
      test_plan: { ...saved.test_plan, seed: 999 } });
    assert.notEqual(newer.evaluator_digest, saved.evaluator_digest);
    release();
    for (let i = 0; i < 100 && !submitted; i++) await delay(20);
    assert.ok(submitted);
    const plan = submitted as ExperimentExecutionPlan;
    assert.equal(plan.experiment.type, 'DEVELOPMENT_FEEDBACK');
    assert.equal(plan.experiment.evaluator.digest, saved.evaluator_digest);
    assert.equal(plan.experiment.baseline.digest, digest);
    const record = trials.list(project)[0];
    assert.match(plan.steps[0].command.args.at(-1)!, /cmake --build "\$COREPILOT_BUILD_ROOT" --target kernel -j2/);
    assert.equal(record.artifact_path, record.remote_workspace!.build_root + '/lib/libfixture.so');
    assert.equal(record.requested_build_definition!.args.at(-1), 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --target kernel -j2');
    for (const step of plan.steps.filter(item => item.formal_context && item.formal_context.role !== 'BASELINE')) {
      assert.equal(step.formal_context!.artifact.path, record.artifact_path);
      assert.ok(step.command.args.includes(record.artifact_path));
    }
    const samples = plan.steps.filter(item => item.formal_context?.phase === 'PERFORMANCE_SAMPLE');
    assert.deepEqual(samples.map(item => item.formal_context!.role), Array.from({ length: matrix ? 4 : 1 }, () => ['BASELINE', 'CANDIDATE', 'CANDIDATE', 'BASELINE']).flat());
    assert.equal(plan.steps.filter(item => item.formal_context?.phase === 'PERFORMANCE_WARMUP').length, matrix ? 8 : 2);
    for (const sample of samples) {
      const context = sample.formal_context!;
      const isShared = context.subject_id.includes('--pool1-');
      assert.deepEqual(context.resources, matrix ? { threads: context.parameters.threads,
        cpu_set: isShared ? '2-3' : context.resources.threads === 1 ? '0' : '0-1', numa_node: 0,
        omp_proc_bind: isShared ? 'spread' : 'close' } : { threads: 1, cpu_set: '0-1', numa_node: 0 });
      assert.equal(sample.command.environment.COREPILOT_TEST_SEED, '42');
      assert.equal(sample.command.environment.COREPILOT_INNER_ITERATIONS, '17');
      assert.equal(sample.formal_context!.parameters.length, 64);
    }
    let running = await trials.status(project, start.trial_id);
    for (let i = 0; i < 100 && running.status.status === 'PREPARING'; i++) {
      await delay(20); running = await trials.status(project, start.trial_id);
    }
    assert.equal(running.status.status, 'RUNNING');
    assert.equal(running.summary.correctness.passed, 1, 'completed measurements appear before the experiment ends');
    assert.equal(running.summary.correctness.planned, matrix ? 4 : 1);
    assert.equal(running.summary.performance.measured, 0);
    assert.equal(running.passed, false, 'partial results never mark an active trial as passed');
    runnerStatus = 'SUCCEEDED'; completedMeasurements = Infinity;
    const result = await trials.status(project, start.trial_id);
    assert.equal(result.formal_evidence, false);
    assert.equal(result.passed, true);
    assert.equal(result.summary.performance.planned, matrix ? 16 : 4);
    assert.equal(result.summary.comparisons.length, matrix ? 4 : 1);
    for (const row of result.summary.comparisons) { assert.deepEqual(row.baseline_samples, [2, 2]); assert.deepEqual(row.candidate_samples, [1, 1]); }
    if (matrix) assert.deepEqual(result.summary.comparisons.map(row => [row.profile_name, row.threads, row.cpu_set]), [['按线程分配', 1, '0'], ['按线程分配', 2, '0-1'], ['固定 CPU 池', 1, '2-3'], ['固定 CPU 池', 2, '2-3']]);
    assert.equal(result.summary.comparisons[0].speedup, 2);
    assert.deepEqual(result.summary.comparisons[0].baseline_samples, [2, 2]);
    const snapshot = await api.downloadProjectTests(project.project_id, `validation-trials/${encodeURIComponent(start.trial_id)}/download`);
    assert.ok(snapshot.length > 0);
    const files = await api.projectAction(project.project_id, `validation-trials/${encodeURIComponent(start.trial_id)}/files`) as { evaluator_digest: string; files: Array<{ path: string; content: string }> };
    assert.equal(files.evaluator_digest, saved.evaluator_digest);
    assert.equal(JSON.parse(files.files.find(file => file.path === 'test-plan.json')!.content).seed, 42);
    assert.equal((f.projects.validationAssets.get(project, packageId, version, targetId) as ValidationAssetDraft).qualification, 'DRAFT');
    if (!matrix) {
      const current = f.projects.validationAssets.get(project, packageId, version, targetId);
      await assert.rejects(trials.start(project, packageId, version, targetId, undefined, 'VALIDATION_DRAFT', { mode: 'calibration' }), /重复测量/);
      const calibration = f.projects.validationAssets.save(project, packageId, version, targetId, { ...current, expected_digest: current.evaluator_digest,
        test_plan: { ...current.test_plan, statistics: DEFAULT_STATISTICS, sampling: { ...current.test_plan.sampling, sample_count: 9 } } });
      submitted = null;
      const command = await runFixtureCli(f.url, f.token, ['project', 'trial', project.project_id, packageId, version, targetId, '--calibrate']);
      assert.equal(command.code, 0, command.stderr);
      const started = JSON.parse(command.stdout) as { trial_id: string };
      for (let i = 0; i < 100 && !submitted; i++) await delay(20);
      assert.ok(submitted);
      const aa = submitted as ExperimentExecutionPlan;
      assert.equal(aa.experiment.declared_context.calibration, 'AA_SAME_ARTIFACT');
      assert.equal(aa.experiment.baseline.id, 'none', 'external comparison baseline is not used for A/A');
      const identities = aa.steps.filter(s => s.step === 'PERFORMANCE').map(s => s.formal_context!.artifact.path);
      assert.equal(new Set(identities).size, 1, 'both roles load exactly the same built artifact');
      const calibrated = await trials.status(project, started.trial_id);
      assert.equal(calibrated.summary.calibration?.status, 'BIAS_DETECTED', 'role-biased fixture measurements must be detected');
      assert.equal(calibrated.formal_evidence, false);
      assert.equal(f.projects.validationAssets.get(project, packageId, version, targetId).qualification, 'DRAFT');
    }
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { release(); await f.close(); await new Promise<void>(resolve => runner.close(() => resolve())); }
});
