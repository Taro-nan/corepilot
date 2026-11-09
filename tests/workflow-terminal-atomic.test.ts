import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import type { WorkflowExecutionOutcome } from '../src/contracts/workflow.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { finishWorkflowExecution, initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { sourceOptimizationFixture } from './source-optimization-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts, approveFixture } from './workflow-approval-fixture.js';
import { startWebFixture } from './web-fixture.js';

async function waitDetached(service: OptimizationWorkflowService, id: string) {
  for (let i = 0; i < 800; i++) {
    const record = service.get(id);
    if (record && !service.activeWorkflowIds().includes(id)) return record;
    await delay(25);
  }
  assert.fail(JSON.stringify(service.get(id)));
}

test('source terminal write fault rolls back both statuses, preserves candidate, and startup reconciles', async () => {
  const f = await sourceOptimizationFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      const status = JSON.parse(json).status;
      if (status === 'CANDIDATE_READY' || status === 'INTERRUPTED') throw new Error('fixture terminal write unavailable');
      save(id, json);
    };
    const id = await f.start();
    const before = await waitDetached(f.service, id);
    assert.equal(before.status, 'GENERATING');
    assert.equal(before.progress?.phase, 'PERSISTENCE_ERROR');
    assert.match(before.error!, /保存优化结束状态失败/);
    assert.equal(f.store.getOptimizationTask(before.optimization_task_id!)?.status, 'RUNNING');
    assert.ok(before.candidate_id);
    const candidate = f.store.getCandidate(before.candidate_id)!;
    assert.equal(candidate.source.commit, before.candidate_commit);
    assert.equal(f.store.listExperiments(before.optimization_task_id!).length, 0);
    f.store.saveOptimizationWorkflowJson = save;
    await f.restart();
    const response = await f.api.getOptimizationWorkflow(id) as { workflow: typeof before; execution_attached: boolean };
    assert.equal(response.workflow.status, 'INTERRUPTED');
    assert.equal(response.execution_attached, false);
    assert.equal(f.store.getOptimizationTask(before.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.equal(response.workflow.candidate_id, candidate.candidate_id);
    assert.deepEqual(f.store.getCandidate(candidate.candidate_id), candidate);
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('a transient source terminal write fault is recorded as interruption, not Candidate failure', async () => {
  const f = await sourceOptimizationFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  let failed = false;
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (!failed && JSON.parse(json).status === 'CANDIDATE_READY') { failed = true; throw new Error('fixture transient persistence error'); }
      save(id, json);
    };
    const id = await f.start();
    const result = await f.wait('INTERRUPTED');
    assert.equal(failed, true);
    assert.match(result.error!, /保存优化结束状态失败/);
    assert.equal(f.store.getOptimizationTask(result.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.ok(result.candidate_id);
    assert.equal(f.store.getCandidate(result.candidate_id)?.source.commit, result.candidate_commit);
    assert.equal(f.store.listExperiments(result.optimization_task_id!).length, 0);
    const response = await f.api.getOptimizationWorkflow(id) as { workflow: { candidate_id: string } };
    assert.equal(response.workflow.candidate_id, result.candidate_id);
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('source execution failure persists FAILED to both records through HTTP', async () => {
  const f = await sourceOptimizationFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (JSON.parse(json).progress?.phase === 'PUBLIC_WORKSPACE_STARTING') throw new Error('fixture workspace failure');
      save(id, json);
    };
    const id = await f.start();
    const result = await f.wait('FAILED');
    assert.match(result.error!, /fixture workspace failure/);
    assert.equal(f.store.getOptimizationTask(result.optimization_task_id!)?.status, 'FAILED');
    const response = await f.api.getOptimizationWorkflow(id) as { workflow: { status: string } };
    assert.equal(response.workflow.status, 'FAILED');
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('verified execution failure persists FAILED to both records through HTTP without model or Runner calls', async () => {
  const f = await startWebFixture({ execute: true });
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (JSON.parse(json).progress?.phase === 'PUBLIC_WORKSPACE_STARTING') throw new Error('fixture workspace failure');
      save(id, json);
    };
    const api = new ApiClient(f.url, { token: f.token });
    const submitted = await api.submitOptimizationWorkflow({ function_name: 'kernel', entry_file: 'kernel.c',
      config_path: f.configPath, repository_root: f.repo }) as { workflow_id: string };
    const record = await waitDetached(f.service, submitted.workflow_id);
    assert.equal(record.status, 'FAILED');
    assert.match(record.error!, /fixture workspace failure/);
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'FAILED');
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 0);
    assert.equal(f.modelRequests.inference, 0);
    const response = await api.getOptimizationWorkflow(submitted.workflow_id) as { workflow: { status: string } };
    assert.equal(response.workflow.status, 'FAILED');
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('verified terminal write fault keeps the same candidate and experiments through restart', async () => {
  const f = await startWebFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const seeded = await seedBlockedValidation(f);
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      const status = JSON.parse(json).status;
      if (id === seeded.workflowId && (status === 'WAITING_APPROVAL' || status === 'INTERRUPTED')) throw new Error('fixture terminal write unavailable');
      save(id, json);
    };
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    const before = await waitDetached(f.service, seeded.workflowId);
    assert.equal(before.status, 'GENERATING');
    assert.equal(before.progress?.phase, 'PERSISTENCE_ERROR');
    assert.equal(f.store.getOptimizationTask(before.optimization_task_id!)?.status, 'RUNNING');
    assert.equal(before.candidate_id, seeded.candidate.candidate_id);
    const candidate = f.store.getCandidate(seeded.candidate.candidate_id);
    const experiments = f.store.listExperiments(before.optimization_task_id!);
    assert.equal(experiments.length, 3);
    f.store.saveOptimizationWorkflowJson = save;
    await f.service.stop();
    restarted = new OptimizationWorkflowService({ store: f.store, transportFactory: () => { throw new Error('startup must not contact Runner'); } });
    const response = await api.getOptimizationWorkflow(seeded.workflowId) as { workflow: typeof before };
    assert.equal(response.workflow.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(before.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.equal(response.workflow.candidate_id, seeded.candidate.candidate_id);
    assert.deepEqual(f.store.getCandidate(seeded.candidate.candidate_id), candidate);
    assert.deepEqual(f.store.listExperiments(before.optimization_task_id!), experiments);
    assert.equal(f.modelRequests.inference, 0);
  } finally { f.store.saveOptimizationWorkflowJson = save; await restarted?.stop(); await f.close(); }
});

test('atomic outcome mapping covers failure, cancellation, budget and candidate states', async () => {
  const f = await startWebFixture();
  try {
    const runtime = new OptimizationRuntime(f.store);
    const cases: Array<[WorkflowExecutionOutcome, string]> = [
      ['WAITING_APPROVAL', 'WAITING_APPROVAL'], ['CANDIDATE_READY', 'CANDIDATE_READY'], ['FAILED', 'FAILED'],
      ['CANCELLED', 'CANCELLED'], ['BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED'], ['INTERRUPTED', 'INTERRUPTED'],
      ['VALIDATION_BLOCKED', 'VALIDATION_BLOCKED'], ['NO_CANDIDATE', 'COMPLETED'], ['PERFORMANCE_THRESHOLD_NOT_MET', 'COMPLETED'],
    ];
    for (const [status, taskStatus] of cases) {
      const id = `workflow:outcome-${status}`;
      const task = runtime.createTask({ workflowId: id, target: { kind: 'kernel', name: 'fixture', scope: {} },
        sourceBaseline: { id: 'fixture' }, performanceBaseline: null, evaluator: null, declaredContext: {} });
      runtime.setTaskStatus(task.task_id, 'RUNNING');
      const workflow = initialOptimizationWorkflowRecord(id, { functionName: 'fixture', entryFile: null, configPath: 'fixture', repositoryRoot: f.repo });
      workflow.optimization_task_id = task.task_id; workflow.status = 'GENERATING';
      f.store.saveOptimizationWorkflowJson(id, JSON.stringify(workflow));
      f.store.finishOptimizationWorkflow(id, task.task_id, { status, error: null, progress: { phase: status } });
      assert.equal(f.service.get(id)?.status, status);
      assert.equal(f.store.getOptimizationTask(task.task_id)?.status, taskStatus);
      assert.throws(() => f.store.finishOptimizationWorkflow(id, task.task_id, { status: 'FAILED' }), /no longer running/);
    }
  } finally { await f.close(); }
});

test('a lost acknowledgement after commit does not replace the saved outcome with an interruption', async () => {
  const f = await startWebFixture();
  const finish = f.store.finishOptimizationWorkflow.bind(f.store);
  const diagnose = f.store.recordWorkflowPersistenceFailure.bind(f.store);
  const stderr = console.error; const logs: string[] = [];
  try {
    const runtime = new OptimizationRuntime(f.store);
    const id = 'workflow:lost-finish-ack';
    const task = runtime.createTask({ workflowId: id, target: { kind: 'kernel', name: 'fixture', scope: {} },
      sourceBaseline: { id: 'fixture' }, performanceBaseline: null, evaluator: null, declaredContext: {} });
    runtime.setTaskStatus(task.task_id, 'RUNNING');
    const record = initialOptimizationWorkflowRecord(id, { functionName: 'fixture', entryFile: null, configPath: 'fixture', repositoryRoot: f.repo });
    record.optimization_task_id = task.task_id; record.status = 'GENERATING';
    f.store.saveOptimizationWorkflowJson(id, JSON.stringify(record));
    f.store.finishOptimizationWorkflow = (...args) => { finish(...args); throw new Error('fixture lost response after commit'); };
    f.store.recordWorkflowPersistenceFailure = () => { throw new Error('fixture diagnostic unavailable'); };
    console.error = (...args) => { logs.push(args.join(' ')); };
    finishWorkflowExecution(f.store, id, task.task_id, { status: 'CANDIDATE_READY', error: null,
      progress: { phase: 'CANDIDATE_READY', last_event: 'saved outcome' } }, text => text);
    assert.equal(f.service.get(id)?.status, 'CANDIDATE_READY');
    assert.equal(f.service.get(id)?.progress?.last_event, 'saved outcome');
    assert.equal(f.store.getOptimizationTask(task.task_id)?.status, 'CANDIDATE_READY');
    assert.deepEqual(logs, []);
  } finally { f.store.finishOptimizationWorkflow = finish; f.store.recordWorkflowPersistenceFailure = diagnose; console.error = stderr; await f.close(); }
});

test('when all persistence attempts fail, the workflow ID is logged without raw exception secrets', async () => {
  const f = await startWebFixture();
  const finish = f.store.finishOptimizationWorkflow.bind(f.store);
  const diagnose = f.store.recordWorkflowPersistenceFailure.bind(f.store);
  const stderr = console.error; const logs: string[] = [];
  try {
    const runtime = new OptimizationRuntime(f.store), id = 'workflow:persistence-down';
    const task = runtime.createTask({ workflowId: id, target: { kind: 'kernel', name: 'fixture', scope: {} },
      sourceBaseline: { id: 'fixture' }, performanceBaseline: null, evaluator: null, declaredContext: {} });
    runtime.setTaskStatus(task.task_id, 'RUNNING');
    const record = initialOptimizationWorkflowRecord(id, { functionName: 'fixture', entryFile: null, configPath: 'fixture', repositoryRoot: f.repo });
    record.optimization_task_id = task.task_id; record.status = 'GENERATING';
    f.store.saveOptimizationWorkflowJson(id, JSON.stringify(record));
    f.store.finishOptimizationWorkflow = () => { throw new Error('password=fixture-raw-secret'); };
    f.store.recordWorkflowPersistenceFailure = () => { throw new Error('Bearer fixture-raw-secret'); };
    console.error = (...args) => { logs.push(args.join(' ')); };
    finishWorkflowExecution(f.store, id, task.task_id, { status: 'FAILED' }, text => text);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /workflow:persistence-down/);
    assert.doesNotMatch(logs[0], /fixture-raw-secret|password|Bearer/);
    assert.ok(logs[0].length < 512);
    assert.equal(f.service.get(id)?.status, 'GENERATING');
    assert.equal(f.store.getOptimizationTask(task.task_id)?.status, 'RUNNING');
  } finally { f.store.finishOptimizationWorkflow = finish; f.store.recordWorkflowPersistenceFailure = diagnose; console.error = stderr; await f.close(); }
});

test('an interrupted outcome leaves approval, evidence, candidate and UNKNOWN remote experiment untouched', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId);
    await approveFixture(f, seeded.workflowId);
    const record = f.service.get(seeded.workflowId)!;
    const approval = f.store.getCandidateApproval(seeded.candidate.candidate_id)!;
    const candidate = f.store.getCandidate(seeded.candidate.candidate_id)!;
    const evidence = structuredClone(record.review_evidence);
    const runtime = new OptimizationRuntime(f.store);
    const started = runtime.startExperiment({ taskId: candidate.task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'PENDING' });
    const unknown = runtime.markRemoteStateUnknown(started.experiment_id, 'fixture connection lost');
    f.store.saveOptimizationTask({ ...runtime.getTask(candidate.task_id), status: 'RUNNING' });
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify({ ...record, status: 'GENERATING' }));
    assert.throws(() => f.store.finishOptimizationWorkflow(record.workflow_id, candidate.task_id,
      { status: 'WAITING_APPROVAL', candidate_commit: '0'.repeat(40) }), /candidate identity mismatch/);
    assert.equal(f.store.getOptimizationTask(candidate.task_id)?.status, 'RUNNING');
    f.store.finishOptimizationWorkflow(record.workflow_id, candidate.task_id, { status: 'INTERRUPTED', error: 'remote state unknown',
      progress: { phase: 'INTERRUPTED', last_event: 'inspect original experiment' } });
    assert.throws(() => f.store.finishOptimizationWorkflow(record.workflow_id, candidate.task_id, { status: 'FAILED' }), /no longer running/);
    assert.deepEqual(f.store.getExperiment(started.experiment_id), unknown);
    assert.deepEqual(f.store.getCandidateApproval(candidate.candidate_id), approval);
    assert.deepEqual(f.store.getCandidate(candidate.candidate_id), candidate);
    assert.deepEqual(f.service.get(record.workflow_id)?.review_evidence, evidence);
    assert.equal(f.store.getOptimizationTask(candidate.task_id)?.status, 'INTERRUPTED');
    const api = new ApiClient(f.url, { token: f.token });
    const response = await api.getOptimizationWorkflow(record.workflow_id) as { workflow: { candidate_id: string; status: string } };
    assert.equal(response.workflow.status, 'INTERRUPTED');
    assert.equal(response.workflow.candidate_id, candidate.candidate_id);
  } finally { await f.close(); }
});
