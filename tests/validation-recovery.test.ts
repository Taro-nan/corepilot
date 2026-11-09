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
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath, repository_root: f.repo });
    let modelCalls = 0; let completed = 0;
    const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'unused'), runId: 'recovery',
      resumeFrom: { ...seeded.saved, phase: 'VALIDATION', pendingDecision: null, evaluationFeedback: null },
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
