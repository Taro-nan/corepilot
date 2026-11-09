import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { isolatedWorkspaceBuild } from '../src/config/build-command.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';
import type { startWebFixture } from './web-fixture.js';

/** Deterministic RPC receipts for review UX/identity tests; no hardware or performance claim. */
export async function prepareReviewFixture(f: Awaited<ReturnType<typeof startWebFixture>>, multiple = false) {
  if (multiple) {
    fs.writeFileSync(path.join(f.repo, 'helper.c'), 'int helper(void) { return 3; }\n');
    fs.writeFileSync(path.join(f.repo, 'include', 'helper.h'), 'int helper(void);\n');
    f.git('add', 'helper.c', 'include/helper.h'); f.git('commit', '-m', 'Add another review target');
  }
  const machine = { hostname: 'review-fixture', architecture: 'aarch64', cpu_count: 2, machine_identity_sha256: 'a'.repeat(64) };
  const resource = { validity: 'VALID', declared: { threads: 1, cpu_set: '0', numa_node: 0 },
    applied: { cpu_affinity: { mechanism: 'taskset', cpu_set: '0' }, numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: '0', memory_nodes: '0' } },
    observed: { cpu_set: '0', max_runtime_threads: 1, numa_policy: { policy: 'bind', cpu_nodes: '0', memory_nodes: '0' } },
    enforcement: { cpu_set: 'ENFORCED', numa_node: 'ENFORCED', threads: 'ENFORCED' }, errors: [] };
  const now = new Date().toISOString();
  const trialId = `validation:${randomUUID()}`;
  const state = { status: 'SUCCEEDED', commandValidity: 'VALID', measurements: [
    { experiment_id: trialId, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'kernel-check', sample_index: null, value: 'PASS', unit: null, validity: 'VALID' },
    ...(['BASELINE', 'CANDIDATE'] as const).flatMap(role => [0, 1].map(index => ({ experiment_id: trialId, kind: 'PERFORMANCE_SAMPLE', role,
      subject_id: 'small', sample_index: index, value: role === 'BASELINE' ? 2 : 1, unit: 'seconds', validity: 'VALID' }))),
  ] };
  const runner = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') res.end(JSON.stringify({ runner_id: 'review-fixture', protocol_version: RUNNER_PROTOCOL_VERSION,
      status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { controlled_validation: 1 } }));
    else if (req.url === '/machine') res.end(JSON.stringify(machine));
    else if (req.url?.endsWith('/commands')) res.end(JSON.stringify({ command_executions: ['BUILD', 'EVALUATOR_SETUP', 'CORRECTNESS', ...Array(4).fill('PERFORMANCE')].map((step, sequence) => ({
      step, sequence, command: 'fixture-test', args: [], exit_code: 0, stdout: '', stderr: '', duration_ms: 1,
      resource_context: { ...resource, validity: state.commandValidity },
    })) }));
    else if (req.url?.endsWith('/measurements')) res.end(JSON.stringify({ measurements: state.measurements }));
    else if (req.url?.endsWith('/output')) res.end(JSON.stringify({ stdout: '', stderr: '', truncated: false }));
    else res.end(JSON.stringify({ experiment_id: trialId, status: state.status, current_step: null, started_at: now,
      ended_at: state.status === 'SUCCEEDED' ? now : null, failure: null, observed_context: { machine } }));
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  const address = runner.address(); if (!address || typeof address !== 'object') throw new Error('missing fixture address');
  try {
    const project = f.projects.add({ name: 'Review flow', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const d = await f.projects.discover(project.project_id, 'kernel', { command: 'cc -shared -fPIC kernel.c -o libfixture.so', cwd: '.' }, multiple ? ['kernel', 'helper'] : undefined);
    const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
    const original = f.readyValidation(project, pkg, version, target);
    f.projects.validationAssets.save(project, pkg, version, target, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
      candidate_artifact: 'libfixture.so', workloads: [{ workload_id: 'small', parameters: { length: 64 }, threads: 1, critical: false, weight: 1 }],
      test_plan: { ...original.test_plan, resources: { cpu_set: '0', numa_node: 0 }, sampling: { warmup_count: 0, sample_count: 2, order: 'alternating' } } });
    const baseline = path.join(f.root, 'review-baseline.so'); fs.writeFileSync(baseline, 'frozen reference fixture');
    const sha256 = createHash('sha256').update(fs.readFileSync(baseline)).digest('hex');
    await f.projects.validationAssets.bindSingleBaseline(project, pkg, version, target, { artifactPath: baseline, sha256,
      library: 'Reference fixture', versionLabel: '1', source: { kind: 'upload', detail: 'Offline review fixture' } });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'review-fixture' },
      validation: { testpack: '', library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: baseline } });
    const resolved = f.projects.packageLoader.resolveSelection({ package_id: pkg, package_version: version, target_id: target });
    const record = { schema_version: 1, trial_id: trialId, purpose: 'VALIDATION_DRAFT', project_id: project.project_id,
      package_id: pkg, package_version: version, target_id: target, evaluator_digest: resolved.bundle.content_digest,
      source_commit: f.git('rev-parse', 'HEAD'), source_branch: 'main', machine_id: null, machine_name: 'Review fixture CPU',
      case_ids: ['kernel-check'], workload_ids: ['small'], artifact_path: '/fixture/libfixture.so', created_at: now,
      mode: 'comparison', test_plan: f.projects.validationAssets.get(project, pkg, version, target).test_plan,
      baseline_digest: sha256, build_definition: isolatedWorkspaceBuild(resolved.build), preparation: { state: 'READY', phase: 'SUBMITTED', message: null } };
    const directory = path.join(f.dataDir, 'projects', project.project_id, 'validation-trials'); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, trialId.slice('validation:'.length) + '.json'), JSON.stringify(record));
    return { project, pkg, version, target, trialId, state, record, resolved,
      endpoint: `validation-assets/${pkg}/${version}/${target}/review`,
      close: () => new Promise<void>(resolve => runner.close(() => resolve())) };
  } catch (error) { await new Promise<void>(resolve => runner.close(() => resolve())); throw error; }
}
