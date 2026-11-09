import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { remoteWorkspaceBuild } from '../src/workspace/remote-build.js';
import { commandBuild } from '../src/config/build-command.js';
import { RunnerDevelopmentInvestigation, DevelopmentExecutionError } from '../src/core/development-investigation.js';
import type { ExperimentExecutionBackend } from '../src/core/experiment-execution-backend.js';
import type { ExperimentExecutionPlan, ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import type { ValidationTestPlan } from '../src/contracts/validation-assets.js';
import { ApiClient } from '../src/client/api-client.js';
import { startWebFixture } from './web-fixture.js';
import { prepareReviewFixture } from './validation-review-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { PiOptimizationSession } from '../src/agent/pi-optimization-session.js';
import { COREPILOT_PI_PROVIDER_ID, createPiModels } from '../src/model/pi-provider.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';

const build = commandBuild('cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --target kernel -j2',
  { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 1000 });

test('target builds use a fresh CMake tree and resolve the declared output into the same tree', () => {
  const configured = remoteWorkspaceBuild({ build, cwdRelative: '.', sourceRoot: '/runner/task/candidate',
    buildRoot: '/runner/task/build', artifactPath: '/runner/task/candidate/build/lib/libkernel.so' });
  assert.match(configured.command.args.at(-1)!, /-B "\$COREPILOT_BUILD_ROOT"/);
  assert.match(configured.command.args.at(-1)!, /--target kernel -j2/);
  assert.equal(configured.command.environment.COREPILOT_SOURCE_ROOT, '/runner/task/candidate');
  assert.equal(configured.command.environment.COREPILOT_BUILD_ROOT, '/runner/task/build');
  assert.equal(configured.artifactPath, '/runner/task/build/lib/libkernel.so');
  assert.match(build.args.at(-1)!, /-B build/, 'the declared build and evaluator remain unchanged');
});

test('development benchmarks use the staged baseline, relocated candidate and saved test environment', async () => {
  let submitted: ExperimentExecutionPlan | null = null;
  const backend = {
    mode: 'rpc',
    async submitExperiment(plan: ExperimentExecutionPlan) { submitted = plan; return { experiment_id: plan.experiment.experiment_id, status: 'PENDING' }; },
    async getExperiment(id: string) { return { experiment_id: id, status: 'SUCCEEDED', failure: null } as ExperimentStatusResponse; },
    async getCommandExecutions(id: string) { return { experiment_id: id, command_executions: submitted!.steps.map(step => ({ step: step.step, args: step.command.args,
      exit_code: 0, stdout: '', stderr: '', timed_out: false, cancelled: false })) }; },
    async getMeasurements(id: string) { return { experiment_id: id, measurements: ['BASELINE', 'CANDIDATE'].map(role => ({
      kind: 'PERFORMANCE_SAMPLE', subject_id: 'small', role, sample_index: 0, value: role === 'BASELINE' ? 2 : 1, unit: 'seconds', validity: 'VALID',
    })) }; },
  } as unknown as ExperimentExecutionBackend;
  const prepared = { candidate: { candidate_id: 'candidate', commit: 'source', tree: 'tree', source_sha256: 'b'.repeat(64),
    workspace_path: '/runner/task/candidate' }, assetsRoot: '/runner/task/assets' };
  const investigation = new RunnerDevelopmentInvestigation({ backend, taskId: 'task', buildCommand: build,
    baseline: { id: 'reference', digest: 'a'.repeat(64), details: { path: '/runner/task/baseline/artifact.so', libraryPaths: ['/runner/task/baseline/lib'] } },
    candidateArtifactRelativePath: 'build/lib/libkernel.so', resources: { cpuSet: '0', numaNode: 0 },
    testPlan: { seed: 42, inner_iterations: 17, timing_scope: 'kernel' } as ValidationTestPlan,
    workloads: [{ workload_id: 'small', parameters: {}, threads: 1, critical: false, weight: 1 }],
    evaluatorSetup: { executable: 'sh', script: 'scripts/build-evaluator.sh' },
    performanceCommand: { executable: 'sh', script: 'scripts/run-performance.sh', measurement_prefix: 'COREPILOT_MEASUREMENT',
      arguments: ['phase', 'role', 'workload_id', 'artifact_path', 'iteration_index', 'threads', 'runtime_root'] },
    async prepareWorkspace() { return prepared; },
  });
  const result = await investigation.runDevBenchmark({ workloadId: 'small', samples: 1 });
  assert.equal(result.data.speedup, 2); assert.ok(submitted);
  const plan = submitted as ExperimentExecutionPlan;
  const measurement = plan.steps.at(-1)!.command;
  assert.match(measurement.args.at(-1)!, /\/runner\/task\/baseline\/artifact\.so/);
  assert.match(measurement.args.at(-1)!, /\/runner\/task\/candidate\.build\/lib\/libkernel\.so/);
  assert.equal(measurement.environment.COREPILOT_TEST_ASSETS_ROOT, '/runner/task/assets');
  assert.equal(measurement.environment.COREPILOT_TEST_SEED, '42');
  assert.equal(measurement.environment.COREPILOT_INNER_ITERATIONS, '17');
  assert.equal(measurement.environment.LD_LIBRARY_PATH, '/runner/task/baseline/lib');
  assert.equal(plan.steps[1].command.environment.COREPILOT_TEST_ASSETS_ROOT, '/runner/task/assets');
  assert.equal(plan.build_directory, '/runner/task/candidate.build');
  assert.ok(path.posix.relative(prepared.candidate.workspace_path, plan.steps[1].command.args[1]).startsWith('..'), 'generated evaluator outputs stay outside the source identity');
  await investigation.runDevBenchmark({ workloadId: 'small', samples: 1 });
  const repeated = submitted as unknown as ExperimentExecutionPlan;
  assert.notEqual(repeated.experiment.experiment_id, plan.experiment.experiment_id, 'every measurement has a fresh Experiment');
  assert.deepEqual(repeated.steps.map(step => step.step), ['PERFORMANCE'], 'successful build and evaluator are reused without reusing measurement samples');
});

test('public Package optimization stages the Control baseline before starting target investigation', async () => {
  const uploads: Array<{ local: string; remote: string }> = [];
  let expected = '';
  const f = await startWebFixture({ execute: true, rpcTransport: {
    async runRemote(argv) { return { command: argv[0], argv, exit_code: 0, stderr: '', stdout: argv.join(' ').includes('sha256sum') ? `${expected}  artifact.so\n` : '' }; },
    uploadFile(local, remote) { uploads.push({ local, remote }); return { exit_code: 0, stderr: '' }; },
  } });
  const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  let id = '';
  try {
    expected = r.record.baseline_digest;
    const review = await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    await f.projects.validationReview.approve(r.project, r.pkg, r.version, r.target, { expected_digest: review.evaluator_digest,
      expected_package_digest: review.package_digest, trial_id: r.trialId, reviewer: 'Fixture owner', confirm: true });
    const api = new ApiClient(f.url, { token: f.token });
    const start = await api.submitOptimizationWorkflow({ project_id: r.project.project_id }) as { workflow_id: string }; id = start.workflow_id;
    const deadline = Date.now() + 12_000;
    while (!f.modelRequests.agentBodies.length && f.service.activeWorkflowIds().length && Date.now() < deadline) await delay(20);
    assert.ok(f.modelRequests.agentBodies.length, f.service.get(id)?.error ?? 'Agent did not start');
    const baselineUploads = uploads.filter(item => path.basename(item.local) === 'review-baseline.so');
    assert.equal(baselineUploads.length, 1, 'the same verified target copy is reused by investigation and Formal execution');
    assert.match(baselineUploads[0].remote, /^\/tmp\/fixture\/.*\/baselines\/.*\/artifact\.so\.tmp$/);
    assert.notEqual(baselineUploads[0].remote, baselineUploads[0].local);
  } finally {
    if (id) { f.service.cancel(id); const end = Date.now() + 5000; while (f.service.activeWorkflowIds().length && Date.now() < end) await delay(20); }
    await r.close(); await f.close();
  }
});

for (const recovery of ['active', 'unlinked'] as const) {
test(`public RPC ${recovery} recovery performs no remote staging while an experiment is unresolved`, async () => {
  let remoteCalls = 0;
  const f = await startWebFixture({ rpcTransport: {
    async runRemote() { remoteCalls++; throw new Error('recovery must not restage'); },
    uploadFile() { remoteCalls++; throw new Error('recovery must not restage'); },
  } });
  const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const review = await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    await f.projects.validationReview.approve(r.project, r.pkg, r.version, r.target, { expected_digest: review.evaluator_digest,
      expected_package_digest: review.package_digest, trial_id: r.trialId, reviewer: 'Fixture owner', confirm: true });
    const seeded = await seedBlockedValidation(f);
    const record = f.service.get(seeded.workflowId)!;
    record.status = 'INTERRUPTED';
    record.candidate_evaluation_feedback = null;
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify(record));
    const previous = f.store.getExperiment(seeded.experiment.experiment_id)!;
    f.store.saveExperiment({ ...previous, status: 'RUNNING', ended_at: null, validity: 'UNKNOWN', failure_category: null, evaluation: null });
    const before = f.store.getExperiment(previous.experiment_id);
    const model = loadOptimizationConfig(f.configPath).config.model;
    const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
    const session = await PiOptimizationSession.open({ id: record.agent_session!.id, directory: record.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'Offline RPC recovery fixture.' });
    await session.checkpoint({ ...seeded.saved, phase: recovery === 'active' ? 'VALIDATION' : 'AGENT', validationOnly: true,
      activeExperimentId: recovery === 'active' ? previous.experiment_id : null, pendingDecision: null, evaluationFeedback: null });
    await session.close();
    const api = new ApiClient(f.url, { token: f.token });
    await api.resumeOptimizationWorkflow(seeded.workflowId);
    const deadline = Date.now() + 10_000;
    while (f.service.activeWorkflowIds().length && Date.now() < deadline) await delay(20);
    const result = f.service.get(seeded.workflowId)!;
    assert.equal(result.status, recovery === 'active' ? 'INTERRUPTED' : 'FAILED', result.error ?? 'unexpected status');
    assert.match(result.error ?? '', recovery === 'active' ? /execution plan is missing/ : /未确认终态/);
    assert.equal(remoteCalls, 0);
    const after = f.store.getExperiment(previous.experiment_id)!;
    assert.equal(after.experiment_id, before!.experiment_id);
    assert.equal(after.status, recovery === 'active' ? 'UNKNOWN' : 'RUNNING');
    assert.equal(after.ended_at, null);
    assert.deepEqual(after.declared_context, before!.declared_context);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 1);
    assert.equal(f.modelRequests.inference, 0, 'unknown prior work is handled before another Agent turn');
  } finally { await r.close(); await f.close(); }
});
}

test('development build failures become Candidate repair feedback while infrastructure failures remain execution errors', async () => {
  let category = 'BUILD_FAILURE';
  const backend = {
    mode: 'rpc', async submitExperiment() { return { status: 'PENDING' }; },
    async getExperiment(id: string) { return { experiment_id: id, status: 'FAILED', failure_category: category,
      failure: { code: 'COMMAND_FAILED', step: 'BUILD', message: 'CMake cannot find source file: kernel.c', command_execution_id: 'build:1' } }; },
    async getCommandExecutions() { return { command_executions: [{ command_execution_id: 'build:1', step: 'BUILD', exit_code: 1,
      stdout: '', stderr: 'CMake cannot find source file: kernel.c' }] }; },
    async getMeasurements() { return { measurements: [] }; },
  } as unknown as ExperimentExecutionBackend;
  const controller = new RunnerDevelopmentInvestigation({ backend, taskId: 'repair', buildCommand: build,
    candidateArtifactRelativePath: 'build/libkernel.so', baseline: { id: 'reference', details: { path: '/runner/baseline.so' } },
    resources: { cpuSet: '0', numaNode: 0 }, workloads: [{ workload_id: 'small', parameters: {}, threads: 1, weight: 1, critical: false }],
    evaluatorSetup: { executable: 'sh', script: 'scripts/build-evaluator.sh' },
    performanceCommand: { executable: 'sh', script: 'scripts/run-performance.sh', arguments: [], measurement_prefix: 'COREPILOT_MEASUREMENT' },
    async prepareWorkspace() { return { candidate: { candidate_id: 'candidate', commit: 'commit', tree: 'tree', source_sha256: 'a'.repeat(64),
      workspace_path: '/runner/development/source' }, assetsRoot: '/runner/development/assets' }; },
  });
  const failed = await controller.runDevelopmentGate(['small']);
  assert.equal(failed.passed, false); assert.equal(failed.failure?.failure_origin, 'CANDIDATE');
  assert.equal(failed.failure?.step, 'BUILD'); assert.match(failed.failure!.experiment_id, /^development:/);
  assert.deepEqual(failed.failure?.raw_command_execution_ids, ['build:1']); assert.match(failed.failure!.command_output, /kernel.c/);
  assert.deepEqual(failed.workloads, [], 'a build failure produces no invented timing or regression result');
  category = 'INFRASTRUCTURE_FAILURE';
  await assert.rejects(controller.runDevelopmentGate(['small']), error => error instanceof DevelopmentExecutionError && error.failure.failure_origin === 'EXECUTION');
});
