import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ValidationTestPlan } from '../src/contracts/validation-assets.js';
import type { ExperimentExecutionPlan } from '../src/contracts/runner-rpc.js';
import { parseValidationTestPlan } from '../src/evaluator/validation-test-plan.js';
import { entryResources, expandValidationInputs, validationInputRows } from '../src/evaluator/execution-matrix.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { evaluatorContentSha256, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';

const conditions = (): ValidationTestPlan => ({ schema_version: 1, resources: { cpu_set: '0-3', numa_node: 0 },
  sampling: { warmup_count: 1, sample_count: 2, order: 'alternating' }, seed: 42, inner_iterations: 17,
  timing_scope: 'kernel', candidate_api: 'kernel', baseline_api: 'kernel', execution_matrix: {
    thread_counts: [1, 2], profiles: [
      { id: 'node0', name: '节点 0 按线程', cpu_set: '0-3', numa_node: 0, cpu_allocation: 'per_thread', omp_proc_bind: 'close' },
      { id: 'node1', name: '节点 1 固定池', cpu_set: '4-7', numa_node: 1, cpu_allocation: 'shared', omp_proc_bind: 'spread' },
    ] } });

test('matrix conditions reject impossible resources and preserve legacy plans', () => {
  const plan = conditions();
  assert.deepEqual(parseValidationTestPlan(plan), plan);
  const { execution_matrix: _matrix, ...legacy } = plan;
  assert.deepEqual(parseValidationTestPlan(legacy), legacy);
  for (const mutate of [
    (p: ValidationTestPlan) => { p.execution_matrix!.thread_counts = [1, 1]; },
    (p: ValidationTestPlan) => { p.execution_matrix!.thread_counts = [1, 8]; },
    (p: ValidationTestPlan) => { p.execution_matrix!.profiles[1].id = 'node0'; },
    (p: ValidationTestPlan) => { p.execution_matrix!.profiles[0].cpu_set = '3-1'; },
    (p: ValidationTestPlan) => { p.execution_matrix!.profiles[0].numa_node = -1; },
  ]) { const invalid = conditions(); mutate(invalid); assert.throws(() => parseValidationTestPlan(invalid)); }
});

test('saved matrix inventories expand once, survive CLI/API reads and fix AI inputs and both-side resources', async () => {
  const f = await startWebFixture();
  try {
    const project = f.projects.add({ name: 'Matrix', repository_root: f.repo, config_path: f.configPath });
    const discovered = await f.projects.discover(project.project_id, 'kernel');
    const pkg = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, target = discovered.targets[0].target_id;
    const service = f.projects.validationAssets;
    const original = service.get(project, pkg, version, target);
    const saved = service.save(project, pkg, version, target, { ...original, expected_digest: original.evaluator_digest, source: 'edited',
      oracle_description: 'Independent scalar reference returning 2 for the fixture kernel', tolerance_rule: 'exact integer equality',
      test_plan: conditions(), cases: [{ case_id: 'check', parameters: { n: 16 }, threads: 1 }],
      workloads: [{ workload_id: 'small', parameters: { n: 16 }, threads: 1, critical: true, weight: 1 }] });
    assert.equal(saved.workloads.length, 1);
    assert.equal(saved.workloads[0].workload_id, 'small');
    const cli = await runFixtureCli(f.url, f.token, ['project', 'validation', project.project_id, pkg, version, target]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).test_plan.execution_matrix, saved.test_plan.execution_matrix);
    const resolved = f.projects.packageLoader.resolveSelection({ package_id: pkg, package_version: version, target_id: target });
    assert.equal(resolved.bundle.workloads.workloads.length, 4);
    assert.equal(new Set(resolved.bundle.workloads.workloads.map(x => x.workload_id)).size, 4);
    const inputs = validationInputRows(resolved.bundle.workloads.workloads);
    assert.deepEqual(expandValidationInputs(inputs, conditions()), resolved.bundle.workloads.workloads);
    const reloaded = service.save(project, pkg, version, target, { ...saved, source: 'edited', expected_digest: saved.evaluator_digest });
    assert.equal(reloaded.evaluator_digest, saved.evaluator_digest, 'saving unmodified input rows does not expand again');
    const steps = createFormalEvaluatorSteps({ bundle: resolved.bundle, stagedEvaluatorRoot: '/assets', runtimeRoot: '/runtime',
      candidateArtifact: { artifactId: 'candidate', path: '/candidate.so', sha256: null },
      baselineArtifact: { artifactId: 'baseline', path: '/baseline.so', sha256: null },
      correctnessTimeoutMs: 1000, performanceTimeoutMs: 1000, includePerformance: true });
    assert.equal(steps.length, 29);
    for (const workload of resolved.bundle.workloads.workloads) {
      const samples = steps.filter(x => x.formal_context?.subject_id === workload.workload_id);
      assert.equal(samples.length, 6);
      assert.deepEqual(samples.slice(-4).map(x => x.formal_context!.role), ['BASELINE', 'CANDIDATE', 'CANDIDATE', 'BASELINE']);
      for (const step of samples) {
        const resources = entryResources(workload, conditions(), resolved.bundle.manifest);
        assert.deepEqual(step.formal_context!.resources, resources);
        assert.equal(resources.cpu_set, workload.execution!.profile_id === 'node0' ? (workload.threads === 1 ? '0' : '0-1') : '4-7');
        assert.equal(step.command.environment.OMP_PROC_BIND, resources.omp_proc_bind);
        assert.equal(step.command.environment.COREPILOT_TEST_SEED, '42');
      }
    }
    const generated = await service.generate(project, f.projects.config(project.project_id), pkg, version, target, 'correctness');
    assert.deepEqual(generated.workloads, saved.workloads);
    assert.match(JSON.stringify(f.modelRequests.validationBodies.at(-1)), /LOGICAL_INPUTS/);
    assert.doesNotMatch(JSON.stringify(f.modelRequests.validationBodies.at(-1)), /small--node1-t2/);
    const tooLarge = { ...conditions(), sampling: { warmup_count: 100, sample_count: 100, order: 'paired' } };
    assert.throws(() => service.save(project, pkg, version, target, { ...reloaded, source: 'edited', expected_digest: reloaded.evaluator_digest, test_plan: tooLarge,
      workloads: [...reloaded.workloads, { ...reloaded.workloads[0], workload_id: 'large' }] }), /2048/);
    assert.equal(service.get(project, pkg, version, target).evaluator_digest, reloaded.evaluator_digest);
  } finally { await f.close(); }
});

test('formal Runner rejects tampered matrix CPU, thread and placement policies before executing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-matrix-'));
  const evaluatorRoot = path.join(root, 'evaluator');
  const fixture = createFormalEvaluatorFixture(evaluatorRoot, { domain: 'saxpy', sampleCount: 2 });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(evaluatorRoot, name), JSON.stringify(value));
  const plan = conditions();
  const base = loadFormalEvaluatorBundle(evaluatorRoot);
  const cases = expandValidationInputs(base.correctness.cases, plan), workloads = expandValidationInputs(base.workloads.workloads, plan);
  write('test-plan.json', plan); write('correctness/cases.json', { schema_version: 1, cases }); write('benchmark/workloads.json', { schema_version: 1, workloads });
  const manifest = { ...fixture.manifest, correctness: { ...fixture.manifest.correctness, case_ids: cases.map(x => x.case_id) },
    performance: { ...fixture.manifest.performance, workload_ids: workloads.map(x => x.workload_id) },
    resource_requirements: { ...fixture.manifest.resource_requirements, thread_counts: [1, 2] } };
  write('manifest.json', manifest); manifest.digest = evaluatorContentSha256(evaluatorRoot); write('manifest.json', manifest);
  const qualification = JSON.parse(fs.readFileSync(path.join(evaluatorRoot, 'qualification.json'), 'utf8'));
  write('qualification.json', { ...qualification, subject_digest: manifest.digest });
  const bundle = loadFormalEvaluatorBundle(evaluatorRoot, { requireQualified: true });
  const server = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'matrix-fixture', dbPath: path.join(root, 'runner.sqlite'), workspaceRoot: root });
  const client = new RunnerClient({ baseUrl: server.url, token: 'matrix-fixture' });
  const candidateRoot = path.join(root, 'candidate'); fs.mkdirSync(candidateRoot);
  fs.writeFileSync(path.join(candidateRoot, 'source.txt'), 'candidate fixture');
  try {
    for (const [index, patch] of [{ cpu_set: '2' }, { threads: 3 }, { omp_proc_bind: 'spread' }].entries()) {
      const now = new Date().toISOString();
      const execution: ExperimentExecutionPlan = { experiment: { schema_version: 1, experiment_id: `matrix:${index}`, task_id: 'matrix', candidate_id: 'candidate',
        type: 'FORMAL_EVALUATION', status: 'PENDING', validity: 'UNKNOWN', failure_category: null, evaluator: { id: 'evaluator:test', version: '1.0.0', digest: manifest.digest },
        baseline: { id: 'baseline' }, declared_context: {}, observed_context: null, evaluation: null, started_at: null, ended_at: null, created_at: now, updated_at: now },
        candidate: { candidate_id: 'candidate', commit: 'fixture', tree: 'fixture', workspace_path: candidateRoot, source_sha256: sourceTreeSha256(candidateRoot) },
        evaluator: { evaluator_id: 'evaluator:test', version: '1.0.0', digest: manifest.digest, workspace_path: evaluatorRoot },
        steps: createFormalEvaluatorSteps({ bundle, stagedEvaluatorRoot: evaluatorRoot, runtimeRoot: path.join(root, 'runtime'),
          candidateArtifact: { artifactId: 'candidate', path: path.join(root, 'candidate.so'), sha256: null }, baselineArtifact: { artifactId: 'baseline', path: '/baseline', sha256: null },
          correctnessTimeoutMs: 1000, performanceTimeoutMs: 1000, includePerformance: false }) };
      Object.assign(execution.steps[1].formal_context!.resources, patch);
      await assert.rejects(client.submitExperiment(execution), /formal resource declaration differs/);
    }
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
