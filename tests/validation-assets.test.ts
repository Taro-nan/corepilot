import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiClient } from '../src/client/api-client.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import type { ValidationAssetDraft } from '../src/contracts/validation-assets.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { stageRemoteBaseline } from '../src/workspace/validation-runner.js';
import { execFileSync } from 'node:child_process';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { BaselineBundleService } from '../src/application/baseline-bundle-service.js';
import { evaluatorContentSha256 } from '../src/evaluator/formal-evaluator.js';

test('shared save API inherits omitted workload policy and reports invalid rows without changing the draft', async () => {
  const fixture = await startWebFixture();
  try {
    const project = fixture.projects.add({ name: 'Workload inputs', repository_root: fixture.repo });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, targetId = discovered.targets[0].target_id;
    const endpoint = `validation-assets/${packageId}/${version}/${targetId}`, api = new ApiClient(fixture.url, { token: fixture.token });
    const original = await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft;
    const prepared = await api.projectAction(project.project_id, endpoint, { ...original, source: 'edited', expected_digest: original.evaluator_digest,
      workloads: [{ workload_id: 'large', parameters: { length: 128 }, threads: 4, critical: true, weight: 3 }] }, 'PUT') as ValidationAssetDraft;
    const saved = await api.projectAction(project.project_id, endpoint, { ...prepared, source: 'edited', expected_digest: prepared.evaluator_digest,
      workloads: [{ workload_id: 'large', parameters: { length: 256 } }, { workload_id: 'small', parameters: { length: 16 } }] }, 'PUT') as ValidationAssetDraft;
    assert.deepEqual(saved.workloads, [{ workload_id: 'large', parameters: { length: 256 }, threads: 4, critical: true, weight: 3 },
      { workload_id: 'small', parameters: { length: 16 }, threads: 1, critical: false, weight: 1 }]);
    for (const [workloads, message] of [
      [[{ ...saved.workloads[0], weight: 0 }], /第 1 行性能负载.*weight/],
      [[saved.workloads[0], saved.workloads[0]], /第 2 行性能负载.*第 1 行重复/],
      [[{ ...saved.workloads[0], parameters: { alpha: [1, 0] } }], /参数“alpha”.*数组/],
    ] as const) {
      const response = await fetch(`${fixture.url}/v1/projects/${project.project_id}/${endpoint}`, { method: 'PUT',
        headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...saved, expected_digest: saved.evaluator_digest, source: 'edited', workloads }) });
      assert.equal(response.status, 422);
      const error = (await response.json()).error;
      assert.equal(error.code, 'INVALID_VALIDATION_INPUT'); assert.match(error.message, message);
      assert.equal((await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft).evaluator_digest, saved.evaluator_digest);
    }
  } finally { await fixture.close(); }
});

test('saving a prior draft moves scripts, supporting files and manifest to one protocol while preserving its snapshot', async () => {
  const fixture = await startWebFixture();
  try {
    const project = fixture.projects.add({ name: 'Previous draft', repository_root: fixture.repo });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, targetId = discovered.targets[0].target_id;
    const selected = fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
    const root = selected.bundle.root;
    for (const relative of ['manifest.json', 'scripts/run-correctness.sh', 'scripts/run-performance.sh', 'benchmark/output-schema.json']) {
      const filename = path.join(root, relative);
      fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replaceAll('COREPILOT_', 'ARCHIVE_').replaceAll('corepilot-evaluator-content-sha256-v1', 'archive-evaluator-content-sha256-v1'));
    }
    const manifestPath = path.join(root, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.digest = evaluatorContentSha256(root); fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const qualificationPath = path.join(root, 'qualification.json'), qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
    qualification.subject_digest = manifest.digest; fs.writeFileSync(qualificationPath, JSON.stringify(qualification, null, 2) + '\n');
    const packagePath = path.join(selected.loaded.root, 'package.json'), packageManifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    packageManifest.formal_evaluators.find((item: { evaluator_id: string }) => item.evaluator_id === manifest.evaluator_id).digest = manifest.digest;
    fs.writeFileSync(packagePath, JSON.stringify(packageManifest, null, 2) + '\n');
    const endpoint = `validation-assets/${packageId}/${version}/${targetId}`, api = new ApiClient(fixture.url, { token: fixture.token });
    const previous = await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft;
    const saved = await api.projectAction(project.project_id, endpoint, { ...previous, expected_digest: previous.evaluator_digest,
      source: 'edited', supporting_files: [{ path: 'support/check.py', content: 'print("ARCHIVE_MEASUREMENT {}")\n' }] }, 'PUT') as ValidationAssetDraft;
    const current = fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId }).bundle;
    assert.equal(current.manifest.correctness.command.measurement_prefix, 'COREPILOT_MEASUREMENT');
    assert.equal(current.manifest.performance.command.measurement_prefix, 'COREPILOT_MEASUREMENT');
    assert.equal(current.manifest.digest_algorithm, 'corepilot-evaluator-content-sha256-v1');
    assert.match(saved.supporting_files[0].content, /COREPILOT_MEASUREMENT/);
    assert.doesNotMatch(saved.correctness_script + saved.performance_script, /ARCHIVE_ARGUMENT_CONTRACT/);
    assert.notEqual(saved.evaluator_digest, previous.evaluator_digest);
    assert.equal(saved.qualification, 'DRAFT');
    const history = await api.projectAction(project.project_id, endpoint + `/files?digest=${previous.evaluator_digest}`) as { evaluator_digest: string; files: Array<{ path: string; content: string }> };
    assert.equal(history.evaluator_digest, previous.evaluator_digest);
    assert.match(history.files.find(file => file.path === 'scripts/run-performance.sh')!.content, /ARCHIVE_ARGUMENT_CONTRACT/);
  } finally { await fixture.close(); }
});

test('browser and CLI edit one project-owned evaluator draft through shared API without qualification', async () => {
  const fixture = await startWebFixture();
  try {
    const project = fixture.projects.add({ name: 'Draft', repository_root: fixture.repo });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id;
    const version = discovered.evidence.generated.version;
    const targetId = discovered.targets[0].target_id;
    const endpoint = `validation-assets/${packageId}/${version}/${targetId}`;
    const api = new ApiClient(fixture.url, { token: fixture.token });
    const original = await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft;
    assert.equal(original.qualification, 'DRAFT');
    const cli = await runFixtureCli(fixture.url, fixture.token,
      ['project', 'validation', project.project_id, packageId, version, targetId]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal((JSON.parse(cli.stdout) as ValidationAssetDraft).evaluator_digest, original.evaluator_digest);
    const edited = await api.projectAction(project.project_id, endpoint, {
      ...original, expected_digest: original.evaluator_digest, source: 'uploaded',
      correctness_script: '#!/bin/sh\nexit 0\n', performance_script: '#!/bin/sh\nexit 0\n',
      cases: [{ case_id: 'small', parameters: { width: 8 }, threads: 1 }],
      workloads: [{ workload_id: 'small', parameters: { width: 8 }, threads: 1, critical: true, weight: 1 }],
      oracle_description: 'Independent reference to be reviewed', benchmark_description: 'Latency in seconds',
      tolerance_rule: 'absolute', tolerance_absolute: 0.01, tolerance_relative: 0,
      candidate_artifact: 'build/libkernel.so',
      test_plan: { ...original.test_plan, resources: { cpu_set: '2-3', numa_node: 0 },
        sampling: { warmup_count: 2, sample_count: 7, order: 'alternating' }, seed: 1234, inner_iterations: 50 },
      supporting_files: [{ path: 'support/oracle.c', content: 'int original_oracle(void) { return 2; }\n' }],
    }, 'PUT') as ValidationAssetDraft;
    assert.equal(edited.qualification, 'DRAFT');
    assert.notEqual(edited.evaluator_digest, original.evaluator_digest);
    assert.match(edited.correctness_script, /COREPILOT_ARGUMENT_CONTRACT/);
    assert.equal(edited.source, 'uploaded');
    assert.equal(edited.cases[0].case_id, 'small');
    assert.equal(edited.candidate_artifact, 'build/libkernel.so');
    const resolved = fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId });
    assert.equal(resolved.bundle.manifest.performance.sampling.sample_count, 7);
    assert.equal(resolved.bundle.manifest.resource_requirements.cpu_set, '2-3');
    assert.deepEqual(edited.test_plan, { ...original.test_plan, resources: { cpu_set: '2-3', numa_node: 0 },
      sampling: { warmup_count: 2, sample_count: 7, order: 'alternating' }, seed: 1234, inner_iterations: 50 });
    const archive = path.join(fixture.root, 'tests.tar.gz');
    const downloaded = await runFixtureCli(fixture.url, fixture.token, ['project', 'validation', project.project_id, packageId, version, targetId, '--download', archive]);
    assert.equal(downloaded.code, 0, downloaded.stderr);
    assert.match(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }), /support\/oracle.c/);
    assert.match(execFileSync('tar', ['-xOzf', archive, './evaluator/README.md'], { encoding: 'utf8' }), /COREPILOT_TEST_SEED/);
    const newer = await api.projectAction(project.project_id, endpoint, { ...edited, source: 'edited', expected_digest: edited.evaluator_digest,
      supporting_files: [{ path: 'support/oracle.c', content: 'int newer_oracle(void) { return 2; }\n' }] }, 'PUT') as ValidationAssetDraft;
    assert.notEqual(newer.evaluator_digest, edited.evaluator_digest);
    fs.writeFileSync(archive, await api.downloadProjectTests(project.project_id, endpoint + `/download?digest=${edited.evaluator_digest}`));
    assert.match(execFileSync('tar', ['-xOzf', archive, './evaluator/support/oracle.c'], { encoding: 'utf8' }), /original_oracle/);
    const oldFiles = await api.projectAction(project.project_id, endpoint + `/files?digest=${edited.evaluator_digest}`) as { files: Array<{ path: string; content: string }> };
    assert.match(oldFiles.files.find(file => file.path === 'support/oracle.c')!.content, /original_oracle/);
    await assert.rejects(api.projectAction(project.project_id, endpoint, { ...newer, expected_digest: newer.evaluator_digest, source: 'edited',
      cases: [{ case_id: 'invalid', parameters: { threads: 99 }, threads: 1 }],
      supporting_files: [{ path: 'support/new-file.c', content: 'must be rolled back' }] }, 'PUT'), /reserved|conflicts/);
    assert.equal((await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft).evaluator_digest, newer.evaluator_digest);
    assert.equal(fs.existsSync(path.join(resolved.bundle.root, 'support/new-file.c')), false);
    await assert.rejects(api.projectAction(project.project_id, endpoint, {
      ...edited, expected_digest: original.evaluator_digest, source: 'edited',
    }, 'PUT'), /changed; reload/);
  } finally { await fixture.close(); }
});

test('AI returns an editable validation proposal without saving or granting qualification', async () => {
  const fixture = await startWebFixture();
  try {
    const project = fixture.projects.add({ name: 'AI draft', repository_root: fixture.repo, config_path: fixture.configPath });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id;
    const version = discovered.evidence.generated.version;
    const targetId = discovered.targets[0].target_id;
    const endpoint = `validation-assets/${packageId}/${version}/${targetId}`;
    const api = new ApiClient(fixture.url, { token: fixture.token });
    fixture.readyValidation(project, packageId, version, targetId);
    const before = await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft;
    const proposed = await api.projectAction(project.project_id, endpoint + '/generate', {}) as {
      source: string; expected_digest: string; cases: Array<{ case_id: string }> };
    assert.equal(proposed.source, 'ai');
    assert.equal(proposed.expected_digest, before.evaluator_digest);
    assert.deepEqual(proposed.cases, before.cases);
    const editable = proposed as unknown as ValidationAssetDraft;
    assert.deepEqual(editable.test_plan, before.test_plan);
    assert.equal(editable.performance_script, before.performance_script);
    assert.equal(editable.tolerance_rule, before.tolerance_rule);
    assert.equal(editable.candidate_artifact, before.candidate_artifact);
    assert.equal(editable.supporting_files[0].path, 'support/reference.c');
    const prompt = JSON.stringify(fixture.modelRequests.validationBodies[0]);
    assert.match(prompt, /USER-OWNED/);
    assert.match(prompt, /inner_iterations/);
    assert.equal((fixture.modelRequests.validationBodies[0] as { tool_choice: string }).tool_choice, 'required');
    await assert.rejects(api.projectAction(project.project_id, endpoint + '/generate', { scope: 'performance' }), /先准备并保存比较基线/);
    assert.equal((await api.projectAction(project.project_id, endpoint) as ValidationAssetDraft).evaluator_digest, before.evaluator_digest);
    assert.equal(fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId }).bundle.qualification.status, 'DRAFT');
  } finally { await fixture.close(); }
});

test('test code generation uses Pi native follow-up after a text-only progress response', async () => {
  const fixture = await startWebFixture({ validationTextFirst: true });
  try {
    const project = fixture.projects.add({ name: 'Pi follow-up', repository_root: fixture.repo, config_path: fixture.configPath });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, targetId = discovered.targets[0].target_id;
    fixture.readyValidation(project, packageId, version, targetId);
    const original = fixture.projects.validationAssets.get(project, packageId, version, targetId);
    const result = await fixture.projects.validationAssets.generate(project, loadOptimizationConfig(project.config_path).config, packageId, version, targetId);
    assert.equal(result.expected_digest, original.evaluator_digest);
    assert.equal(fixture.modelRequests.validationBodies.length, 2);
    assert.match(JSON.stringify(fixture.modelRequests.validationBodies[1]), /Submit the actual code/);
    assert.deepEqual(result.cases, original.cases);
    assert.equal(fixture.projects.validationAssets.get(project, packageId, version, targetId).evaluator_digest, original.evaluator_digest);
  } finally { await fixture.close(); }
});

test('Control-side baseline is hashed before upload and checked again after Runner staging', async () => {
  const fixture = await startWebFixture();
  try {
    const source = path.join(fixture.root, 'baseline.so');
    fs.writeFileSync(source, 'immutable baseline bytes');
    const digest = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const uploaded: string[] = [];
    const remote = await stageRemoteBaseline({ sourceArtifact: source, sourceLocation: 'control', expectedDigest: digest,
      remoteWorkspace: '/runner/baselines/demo', transport: {
        runRemote(argv) { return { command: argv[0], argv, exit_code: 0, stderr: '',
          stdout: argv[2]?.startsWith('sha256sum') ? `${digest}  /runner/baselines/demo/artifact.so\n` : '' }; },
        uploadFile(local, destination) { uploaded.push(`${local} -> ${destination}`); return { exit_code: 0, stderr: '' }; },
      } });
    assert.equal(remote.digest, digest);
    assert.equal(uploaded.length, 1);
    assert.match(uploaded[0], /artifact\.so\.tmp/);
    await assert.rejects(stageRemoteBaseline({ sourceArtifact: source, sourceLocation: 'control',
      expectedDigest: '0'.repeat(64), remoteWorkspace: '/runner/baselines/demo', transport: {
        runRemote() { throw new Error('digest mismatch must stop before network work'); },
      } }), /digest mismatch/);
  } finally { await fixture.close(); }
});

test('CLI uploads an external baseline through the same project API and freezes its real digest', async () => {
  const fixture = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'external-fixture',
    dbPath: path.join(fixture.root, 'external-runner.sqlite'), workspaceRoot: fixture.root });
  try {
    const project = fixture.projects.add({ name: 'External baseline', repository_root: fixture.repo });
    const discovered = await fixture.projects.discover(project.project_id, 'kernel');
    const packageId = discovered.evidence.generated.package_id;
    const version = discovered.evidence.generated.version;
    const targetId = discovered.targets[0].target_id;
    const machine = fixture.projects.machines.save({ name: 'External fixture CPU', runner: { mode: 'rpc', endpoint: runner.url, token: 'external-fixture' },
      target: { ssh_alias: 'fixture', workspace_root: '/fixture' } });
    fixture.projects.bindMachine(project.project_id, machine.machine_id);
    const hardware = await (await fetch(runner.url + '/machine', { headers: { authorization: 'Bearer external-fixture' } })).json();
    (fixture.projects as unknown as { baselineBundles: BaselineBundleService }).baselineBundles = new BaselineBundleService(fixture.dataDir,
      fixture.projects.machines, fixture.projects.validationAssets, async input => ({ ok: true,
        machine_identity_sha256: hardware.machine_identity_sha256, checked_at: new Date().toISOString(),
        entry_sha256: input.files[0].sha256, issues: [], resolved_libraries: [{ soname: 'external.so', path: path.join(input.localRoot, input.entryPath), sha256: input.files[0].sha256 }], libraries: [{ path: input.entryPath, sha256: input.files[0].sha256,
          soname: 'external.so', elf: { class: 'ELF64', endian: 'little', machine: 'AArch64', build_id: 'fixture' }, needed: [] }] }));
    const source = path.join(fixture.root, 'external.so');
    fs.writeFileSync(source, Buffer.from('external baseline fixture'));
    const result = await runFixtureCli(fixture.url, fixture.token, ['project', 'baseline-upload', project.project_id,
      packageId, version, targetId, '--file', source, '--library-name', 'HMPPI fixture', '--library-version', '2.0']);
    assert.equal(result.code, 0, result.stderr);
    const imported = JSON.parse(result.stdout) as { baseline: { sha256: string }; artifact_path: string };
    const expected = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    assert.equal(fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId })
      .loaded.binary_baselines[targetId].libraries[0].sha256, expected);
    assert.equal(fs.readFileSync(imported.artifact_path, 'utf8'), 'external baseline fixture');
    const config = loadOptimizationConfig(project.config_path).config;
    assert.equal(config.validation.baseline_artifact, imported.artifact_path);
    assert.equal(config.validation.library_package?.target_id, targetId);
    assert.equal(fixture.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId })
      .target.artifacts.baseline.sha256, imported.baseline.sha256);
    const displayed = fixture.projects.validationAssets.get(project, packageId, version, targetId);
    assert.equal(displayed.comparison_baseline?.library, 'HMPPI fixture');
    assert.equal(displayed.comparison_baseline?.version, '2.0');
    assert.equal(displayed.comparison_baseline?.sha256, imported.baseline.sha256);
  } finally { await runner.close(); await fixture.close(); }
});
