import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { ApiClient } from '../src/client/api-client.js';
import { executeWorkflowCommand, isWorkflowFinished } from '../src/client/workflow-commands.js';
import { runPublicAgentWorkflow } from '../src/workflow/public-agent-workflow.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import type { RpcExperimentTransitionAdapter } from '../src/core/rpc-experiment-transition-adapter.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import type { RemoteValidationTransport } from '../src/workspace/validation-runner.js';
import { PiOptimizationSession } from '../src/agent/pi-optimization-session.js';
import { createPiModels, COREPILOT_PI_PROVIDER_ID } from '../src/model/pi-provider.js';
import http from 'node:http';
import { packageValidationTestpack, resolveLibraryPackageTask } from '../src/library-package/task-definition.js';
import { prepareReviewFixture } from './validation-review-fixture.js';
import { fixtureRunnerStoreId } from './guarded-runner-fixture.js';
import { RUNNER_PROTOCOL_VERSION } from '../src/contracts/runner-rpc.js';

test('insufficient statistical evidence stops the workflow with its frozen candidate and no additional model turn', async () => {
  const f = await startWebFixture();
  try {
    const filename = loadOptimizationConfig(f.configPath).config.validation.testpack;
    const pack = JSON.parse(fs.readFileSync(filename, 'utf8'));
    pack.performance.statistics = DEFAULT_STATISTICS;
    fs.writeFileSync(filename, JSON.stringify(pack));
    const seeded = await seedBlockedValidation(f, true);
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const record = f.service.get(seeded.workflowId)!;
    assert.equal(record.status, 'VALIDATION_BLOCKED', record.error ?? JSON.stringify(record.progress));
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'VALIDATION_BLOCKED');
    assert.match(record.stop_reason!, /证据不足/);
    assert.equal(record.candidate_id, seeded.candidate.candidate_id);
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.store.listCandidates(seeded.candidate.task_id).length, 1);
    const latest = f.store.listExperiments(seeded.candidate.task_id).at(-1)!;
    assert.equal(latest.evaluation?.performance, 'INCONCLUSIVE');
    assert.equal(latest.evaluation?.correctness, 'PASSED');
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 2);
  } finally { await f.close(); }
});

test('evaluator failure stops before another Agent turn and never counts rejected command output as a pass', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath, repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } });
    let modelCalls = 0; let completed = 0;
    const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'unused'), runId: 'recovery',
      resumeFrom: { ...seeded.saved, phase: 'VALIDATION', activeExperimentId: seeded.experiment.experiment_id, pendingDecision: null, evaluationFeedback: null },
      maxRounds: 8, runAgent: async () => { modelCalls++; throw new Error('No candidate repair is justified by evaluator failure'); },
      lifecycle: { candidateCheckpointed: () => { throw new Error('No new Candidate'); }, experimentStarted: () => seeded.experiment.experiment_id,
        experimentCompleted: () => { completed++; }, revalidationStarted: () => { throw new Error('No revalidation on invalid correctness'); },
        revalidationCompleted: () => {}, experimentFailed: () => {} },
      experimentExecution: { executeValidation: async () => seeded.validation } as unknown as RpcExperimentTransitionAdapter,
    });
    assert.equal(result.status, 'VALIDATION_BLOCKED'); assert.equal(modelCalls, 0); assert.equal(completed, 1);
    assert.match(result.error!, /EVALUATOR_IDENTITY_MISMATCH/);
    const persisted = f.store.getExperiment(seeded.experiment.experiment_id)!;
    assert.equal(persisted.evaluation!.correctness, 'INVALID');
    assert.equal(persisted.evaluation!.correctness_coverage!.passed, 0);
    assert.equal(f.store.listMeasurements(seeded.experiment.experiment_id).length, 0);
    assert.equal(isWorkflowFinished({ ...f.service.get(seeded.workflowId)!, status: result.status }), true);
    const runtime = new OptimizationRuntime(f.store);
    const revalidation = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION' });
    const invalid = { ...seeded.validation, runner_status: { ...seeded.validation.runner_status!, experiment_id: revalidation.experiment_id, type: 'REVALIDATION' as const } };
    runtime.synchronizeRemoteExperiment(invalid.runner_status);
    const completedRevalidation = runtime.completeRevalidationExperiment({ experimentId: revalidation.experiment_id,
      revalidation: { formal: invalid, independent: null, performance_gate: null, passed: false }, factsAlreadyPersisted: true });
    assert.equal(completedRevalidation.evaluation!.correctness, 'INVALID');
    assert.equal(completedRevalidation.evaluation!.correctness_coverage!.passed, 0);
    assert.equal(completedRevalidation.evaluation!.correctness_coverage!.complete, false);
  } finally { await f.close(); }
});

for (const phase of ['VALIDATION', 'REVALIDATION'] as const) {
  test(`unconfirmed legacy ${phase} is interrupted before any remote staging`, async () => {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f);
      const runtime = new OptimizationRuntime(f.store);
      const experiment = phase === 'VALIDATION' ? seeded.experiment : runtime.startExperiment({ taskId: seeded.candidate.task_id,
        candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'RUNNING' });
      const before = f.store.getExperiment(experiment.experiment_id);
      const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath, repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } });
      let transportCalls = 0, failedCalls = 0;
      const transport = { runRemote() { transportCalls++; throw new Error('unconfirmed work must not be staged'); } } as unknown as RemoteValidationTransport;
      const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'unused'), runId: 'recovery',
        resumeFrom: { ...seeded.saved, phase, activeExperimentId: experiment.experiment_id, pendingDecision: null, evaluationFeedback: null },
        remote: { transport, workspace_root: '/fixture' }, maxRounds: 8,
        runAgent: async () => { throw new Error('model should not run'); },
        lifecycle: { candidateCheckpointed: () => { throw new Error('candidate should not change'); },
          experimentStarted: () => { throw new Error('experiment should not be created'); }, experimentCompleted: () => {},
          revalidationStarted: () => { throw new Error('revalidation should not be created'); }, revalidationCompleted: () => {},
          experimentFailed: () => { failedCalls++; } },
      });
      assert.equal(result.status, 'INTERRUPTED');
      assert.match(result.error!, /进程状态未确认/);
      assert.equal(transportCalls, 0);
      assert.equal(failedCalls, 0, 'an unknown execution must not be marked failed');
      assert.deepEqual(f.store.getExperiment(experiment.experiment_id), before);
    } finally { await f.close(); }
  });
}

test('reconciling a successful original formal experiment does not start independent revalidation', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, false, true);
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath,
      repository_root: f.repo }, { allowUnscopedHistorical: true });
    const { runner_status: _oldStatus, ...withoutStatus } = seeded.validation;
    const successful = { ...withoutStatus, passed: true };
    let completed = 0, revalidations = 0, model = 0;
    let savedPhase = '';
    const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'unused'), runId: 'reconcile-only',
      resumeFrom: { ...seeded.saved, phase: 'VALIDATION', activeExperimentId: seeded.experiment.experiment_id,
        validationOnly: true, pendingDecision: null, evaluationFeedback: null }, reconcileOnly: true,
      saveCheckpoint: async saved => { savedPhase = saved.phase; },
      runAgent: async () => { model++; throw new Error('reconciliation must not call Agent'); },
      lifecycle: { candidateCheckpointed: () => { throw new Error('candidate should not change'); },
        experimentStarted: () => { throw new Error('original experiment already exists'); }, experimentCompleted: () => { completed++; },
        revalidationStarted: () => { revalidations++; throw new Error('reconciliation must not create a new experiment'); },
        revalidationCompleted: () => {}, experimentFailed: () => {} },
      experimentExecution: { executeValidation: async () => successful } as unknown as RpcExperimentTransitionAdapter });
    assert.equal(result.status, 'INTERRUPTED');
    assert.match(result.error!, /独立复验尚未启动/);
    assert.equal(savedPhase, 'REVALIDATION');
    assert.equal(completed, 1); assert.equal(revalidations, 0); assert.equal(model, 0);
  } finally { await f.close(); }
});

for (const checkpointLink of ['active-id', 'intent-only', 'intent-no-plan', 'intent-no-store'] as const) test(`legacy unscoped RPC ${checkpointLink} reconciliation queries only a provable original ID and never submits a new job`, async () => {
  const f = await startWebFixture();
  const review = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  const requests: Array<{ method: string; url: string }> = [];
  const runner = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    if (req.url?.endsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runner_id: 'scope-fixture', protocol_version: RUNNER_PROTOCOL_VERSION, store_instance_id: fixtureRunnerStoreId,
        status: 'READY', resource_enforcement: 'REQUIRED', capabilities: { store_identity_guard: 1, artifact_path_check: 1 } })); return;
    }
    if (req.url?.endsWith('/machine')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ hostname: 'fixture', architecture: 'aarch64', cpu_count: 2, machine_identity_sha256: 'a'.repeat(64) })); return;
    }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'TEMPORARY', message: 'fixture Runner unavailable' } }));
  });
  await new Promise<void>(resolve => runner.listen(0, '127.0.0.1', resolve));
  try {
    const inspected = await f.projects.validationReview.preview(review.project, review.pkg, review.version, review.target);
    await f.projects.validationReview.approve(review.project, review.pkg, review.version, review.target, { expected_digest: inspected.evaluator_digest,
      expected_package_digest: inspected.package_digest, trial_id: review.trialId, reviewer: 'Fixture owner', confirm: true });
    const current = f.projects.config(review.project.project_id);
    const packageRef = current.validation.library_package!;
    const resolved = resolveLibraryPackageTask(packageRef, { requireQualified: true, loader: f.projects.packageLoader });
    const file = path.join(f.root, 'standalone-testpack.json');
    const testpack = packageValidationTestpack(resolved, current.validation.baseline_artifact!).testpack;
    testpack.performance.key_cases = [testpack.performance.cases[0].case_id];
    fs.writeFileSync(file, JSON.stringify(testpack));
    const address = runner.address(); assert.ok(address && typeof address === 'object');
    f.projects.saveConfig(review.project.project_id, { ...current, build: resolved.build,
      validation: { testpack: file }, runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'fixture-runner' } });
    const seeded = await seedBlockedValidation(f, false, true);
    const credentiallessConfig = loadOptimizationConfig(f.configPath).config;
    credentiallessConfig.model.api_key = '${COREPILOT_MISSING_RECOVERY_FIXTURE_KEY}';
    assert.equal(process.env.COREPILOT_MISSING_RECOVERY_FIXTURE_KEY, undefined);
    fs.writeFileSync(f.configPath, JSON.stringify(credentiallessConfig));
    const original = f.store.getExperiment(seeded.experiment.experiment_id)!;
    const intent = { schema_version: 1 as const, experiment_id: original.experiment_id, candidate_id: seeded.candidate.candidate_id,
      type: 'FORMAL_EVALUATION' as const, round: seeded.saved.round };
    f.store.saveExperiment({ ...original, status: 'RUNNING', validity: 'UNKNOWN', ended_at: null, failure_category: null, evaluation: null,
      declared_context: { ...original.declared_context,
        ...(checkpointLink === 'intent-no-plan' ? {} : { runner_execution_plan: { steps: [] } }),
        ...(checkpointLink === 'intent-no-store' ? {} : { runner_store_instance_id: fixtureRunnerStoreId }),
        ...(checkpointLink !== 'active-id' ? { workflow_experiment_intent: intent } : {}) } });
    const record = f.service.get(seeded.workflowId)!;
    record.status = 'INTERRUPTED'; record.candidate_evaluation_feedback = null;
    if (checkpointLink !== 'active-id') record.experiment_creation_intent = intent;
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
    const model = loadOptimizationConfig(f.configPath).config.model;
    const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
    const session = await PiOptimizationSession.open({ id: record.agent_session!.id, directory: record.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'RPC recovery fixture.' });
    await session.checkpoint({ ...seeded.saved, phase: 'VALIDATION', activeExperimentId: checkpointLink === 'active-id' ? original.experiment_id : null,
      ...(checkpointLink !== 'active-id' ? { experimentIntent: intent } : {}),
      pendingDecision: null, evaluationFeedback: null }); await session.close();
    const api = new ApiClient(f.url, { token: f.token });
    await api.resumeOptimizationWorkflow(record.workflow_id);
    for (let i = 0; i < 500 && f.service.activeWorkflowIds().length; i++) await delay(20);
    assert.equal(f.service.get(record.workflow_id)!.status, 'INTERRUPTED');
    assert.equal(f.service.get(record.workflow_id)!.source_scope_authorization, undefined);
    assert.ok(requests.every(request => request.method === 'GET'), JSON.stringify(requests));
    const experimentRequests = requests.filter(request => request.url.includes('/experiments/'));
    if (checkpointLink === 'intent-no-plan' || checkpointLink === 'intent-no-store') {
      assert.equal(requests.length, 0, JSON.stringify(requests));
      assert.equal(experimentRequests.length, 0);
    } else {
      assert.equal(experimentRequests.length, 1, JSON.stringify(requests));
      assert.match(experimentRequests[0].url, new RegExp(`${fixtureRunnerStoreId}/experiments/${encodeURIComponent(original.experiment_id)}`));
    }
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 1);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await new Promise<void>(resolve => runner.close(() => resolve())); await review.close(); await f.close(); }
});

for (const mismatch of ['candidate', 'task', 'type', 'intent'] as const) {
test(`public resume refuses an active experiment with a mismatched ${mismatch}`, async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    const record = f.service.get(seeded.workflowId)!;
    record.status = 'INTERRUPTED';
    record.candidate_evaluation_feedback = null;
    if (mismatch === 'type') record.revalidation_experiment_id = seeded.experiment.experiment_id;
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify(record));
    if (mismatch === 'task') {
      const experiment = f.store.getExperiment(seeded.experiment.experiment_id)!;
      f.store.saveExperiment({ ...experiment, task_id: 'task:other' });
    }
    const model = loadOptimizationConfig(f.configPath).config.model;
    const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
    const session = await PiOptimizationSession.open({ id: record.agent_session!.id, directory: record.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'Offline corrupted checkpoint fixture.' });
    await session.checkpoint({ ...seeded.saved, phase: mismatch === 'type' ? 'REVALIDATION' : 'VALIDATION',
      activeExperimentId: seeded.experiment.experiment_id,
      candidateId: mismatch === 'candidate' ? 'candidate:other' : seeded.candidate.candidate_id,
      ...(mismatch === 'intent' ? { experimentIntent: { schema_version: 1 as const, experiment_id: seeded.experiment.experiment_id,
        candidate_id: seeded.candidate.candidate_id, type: 'FORMAL_EVALUATION' as const, round: seeded.saved.round } } : {}),
      pendingDecision: null, evaluationFeedback: null });
    await session.close();
    const before = JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id));
    const api = new ApiClient(f.url, { token: f.token });
    await api.resumeOptimizationWorkflow(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const failed = f.service.get(seeded.workflowId)!;
    assert.equal(failed.status, 'FAILED');
    assert.match(failed.error!, /原实验.*任务、候选或阶段不一致/);
    assert.equal(JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id)), before);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 1);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
}

test('public CLI/API retries the same frozen candidate with new experiments, no model request and no stale ABANDON replay', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    const api = new ApiClient(f.url, { token: f.token });
    const before = JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id));
    const source = fs.readFileSync(path.join(seeded.workspace.editing, 'kernel.c'), 'utf8');
    await assert.rejects(api.resumeOptimizationWorkflow(seeded.workflowId), /retry-validation/);
    await assert.rejects(api.retryOptimizationValidation(seeded.workflowId, 'candidate:stale'), /候选已改变/);
    const cli = await executeWorkflowCommand(api, ['retry-validation', seeded.workflowId, '--json']);
    assert.equal(cli.ok, true);
    const duplicate = await api.retryOptimizationValidation(seeded.workflowId) as { status: string };
    assert.equal(duplicate.status, 'GENERATING');
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const record = f.service.get(seeded.workflowId)!;
    assert.equal(record.status, 'WAITING_APPROVAL', record.error ?? JSON.stringify(record.progress));
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'WAITING_APPROVAL');
    assert.equal(record.validation_retry_count, 1);
    assert.equal(record.candidate_id, seeded.candidate.candidate_id);
    assert.equal(record.candidate_commit, seeded.candidate.source.commit);
    assert.equal(record.candidate_evaluation_decision, null);
    assert.equal(f.store.listCandidates(record.optimization_task_id!).length, 1);
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 3);
    assert.equal(JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id)), before);
    assert.equal(fs.readFileSync(path.join(seeded.workspace.editing, 'kernel.c'), 'utf8'), source);
    assert.equal(f.store.getHypothesis(seeded.hypothesis.hypothesis_id)!.status, 'ABANDONED');
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
    assert.equal(f.git('rev-parse', 'HEAD'), seeded.workspace.baseline_commit);
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.store.listHypothesisOutcomes(record.optimization_task_id!).length, 3);
  } finally { await f.close(); }
});

test('a real threshold miss during frozen retry stops with fresh measurements rather than replaying the old Agent summary', async () => {
  const f = await startWebFixture();
  try {
    const filename = loadOptimizationConfig(f.configPath).config.validation.testpack;
    const pack = JSON.parse(fs.readFileSync(filename, 'utf8'));
    pack.performance.command.args = ['-e', 'console.log(JSON.stringify([{case_id:"p1",baseline_samples:[10,11,9],candidate_samples:[20,21,19]}]))'];
    fs.writeFileSync(filename, JSON.stringify(pack));
    const seeded = await seedBlockedValidation(f, true);
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const record = f.service.get(seeded.workflowId)!;
    assert.equal(record.status, 'PERFORMANCE_THRESHOLD_NOT_MET');
    assert.match(record.stop_reason!, /performance thresholds not satisfied/);
    assert.doesNotMatch(record.stop_reason!, /Frozen fixture candidate|ABANDON/);
    assert.equal(f.modelRequests.inference, 0);
    assert.equal(f.store.listCandidates(seeded.candidate.task_id).length, 1);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 2);
    await api.resumeOptimizationWorkflow(seeded.workflowId);
    for (let count = 0; count < 200 && !f.modelRequests.inference; count++) await delay(20);
    assert.ok(f.modelRequests.inference > 0, 'continue optimization must reopen the Agent, rather than silently repeat a frozen validation');
    await f.service.stop();
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 2);
  } finally { await f.close(); }
});

test('retry rejects an unresolved revalidation even when the last feedback points at an older completed experiment', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    const runtime = new OptimizationRuntime(f.store);
    runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'PENDING' });
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.retryOptimizationValidation(seeded.workflowId), /未确认终态/);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 2);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

for (const phase of ['VALIDATION', 'REVALIDATION'] as const) {
  test(`legacy unscoped ${phase} can reconcile only its original unknown experiment without calling Agent`, async () => {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f, false, true);
      const runtime = new OptimizationRuntime(f.store);
      const original = phase === 'VALIDATION' ? seeded.experiment : runtime.startExperiment({ taskId: seeded.candidate.task_id,
        candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'RUNNING' });
      const unresolved = { ...f.store.getExperiment(original.experiment_id)!, status: 'RUNNING' as const, validity: 'UNKNOWN' as const,
        ended_at: null, failure_category: null, evaluation: null };
      f.store.saveExperiment(unresolved);
      const record = f.service.get(seeded.workflowId)!;
      record.status = 'INTERRUPTED'; record.candidate_evaluation_feedback = null;
      if (phase === 'REVALIDATION') record.revalidation_experiment_id = original.experiment_id;
      f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
      const model = loadOptimizationConfig(f.configPath).config.model;
      const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
      const session = await PiOptimizationSession.open({ id: record.agent_session!.id, directory: record.agent_session!.directory,
        models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'Legacy recovery fixture.' });
      await session.checkpoint({ ...seeded.saved, phase, activeExperimentId: original.experiment_id, validationOnly: false,
        pendingDecision: null, evaluationFeedback: null });
      await session.close();
      const before = f.store.getExperiment(original.experiment_id);
      const count = f.store.listExperiments(seeded.candidate.task_id).length;
      const api = new ApiClient(f.url, { token: f.token });
      await api.resumeOptimizationWorkflow(seeded.workflowId);
      for (let index = 0; index < 500 && f.service.activeWorkflowIds().length; index++) await delay(20);
      const after = f.service.get(seeded.workflowId)!;
      assert.equal(after.status, 'INTERRUPTED');
      assert.match(after.error!, /本地进程状态未确认/);
      assert.equal(after.source_scope_authorization, undefined);
      assert.deepEqual(f.store.getExperiment(original.experiment_id), before);
      assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, count);
      assert.equal(f.modelRequests.inference, 0);
    } finally { await f.close(); }
  });
}
