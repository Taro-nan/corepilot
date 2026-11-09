import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskHost } from '../src/core/task-host.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { createHttpServer } from '../src/http/server.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { sourceOptimizationFixture } from './source-optimization-fixture.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { approveFixture, seedApprovalFacts } from './workflow-approval-fixture.js';
import type { OptimizationTaskStatus } from '../src/contracts/optimization-domain.js';
import type { OptimizationWorkflowRecord } from '../src/contracts/workflow.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-workflow-recovery-'));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite')); store.init();
  const runtime = new OptimizationRuntime(store);
  function seed(id: string, status: OptimizationWorkflowRecord['status'], taskStatus: OptimizationTaskStatus, session = true) {
    const task = runtime.createTask({ workflowId: id, target: { kind: 'software_function', name: 'kernel', scope: {} },
      sourceBaseline: { id: 'fixture-source' }, performanceBaseline: null, evaluator: null, declaredContext: {} });
    runtime.setTaskStatus(task.task_id, taskStatus);
    const record = initialOptimizationWorkflowRecord(id, { functionName: 'kernel', entryFile: 'kernel.c', configPath: 'fixture.yaml', repositoryRoot: root });
    record.status = status; record.optimization_task_id = task.task_id;
    if (session) record.agent_session = { id, directory: root, turns: 1, tool_calls: 1, compactions: 0, reported_tokens: null };
    store.saveOptimizationWorkflowJson(id, JSON.stringify(record));
    return record;
  }
  function service() {
    return new OptimizationWorkflowService({ store, transportFactory: () => { throw new Error('startup recovery must not contact a Runner'); } });
  }
  function close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
  return { root, store, seed, service, close };
}

test('startup recovers older detached sessions and reproduction jobs without altering remote facts', async () => {
  const f = fixture();
  let service: OptimizationWorkflowService | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    const generating = f.seed('a-old-generating', 'GENERATING', 'RUNNING');
    generating.verification_mode = 'source_only';
    f.store.saveOptimizationWorkflowJson(generating.workflow_id, JSON.stringify(generating));
    const reproducing = f.seed('a-old-reproducing', 'WAITING_APPROVAL', 'WAITING_APPROVAL');
    reproducing.reproduction = { experiment_id: 'remote-original-id', original_experiment_id: 'formal-id', status: 'RUNNING',
      phase: '采样中', created_at: reproducing.created_at, updated_at: reproducing.updated_at, error: null,
      source_commit: 'fixture', evaluator_digest: 'fixture', remote_root: '/fixture', machine_identity: 'fixture' };
    f.store.saveOptimizationWorkflowJson(reproducing.workflow_id, JSON.stringify(reproducing));
    const beforeSession = f.seed('a-old-before-session', 'GENERATING', 'RUNNING', false);
    const duringStartup = f.seed('a-old-during-startup', 'CREATED', 'RUNNING', false);
    const incomplete = f.seed('a-old-partial-write', 'INTERRUPTED', 'RUNNING');
    const alreadyDone = f.seed('a-old-completed', 'CANDIDATE_READY', 'CANDIDATE_READY');
    const priorTerminal = f.seed('a-old-terminal-task', 'GENERATING', 'COMPLETED');
    const draft = f.seed('a-old-created', 'CREATED', 'CREATED', false);
    const missing = initialOptimizationWorkflowRecord('a-old-missing-task', { functionName: 'kernel', entryFile: 'kernel.c', configPath: 'fixture.yaml', repositoryRoot: f.root });
    missing.status = 'GENERATING'; missing.optimization_task_id = 'missing-task';
    f.store.saveOptimizationWorkflowJson(missing.workflow_id, JSON.stringify(missing));
    const noIdentity = initialOptimizationWorkflowRecord('a-old-no-task-id', { functionName: 'kernel', entryFile: 'kernel.c', configPath: 'fixture.yaml', repositoryRoot: f.root });
    noIdentity.status = 'GENERATING'; f.store.saveOptimizationWorkflowJson(noIdentity.workflow_id, JSON.stringify(noIdentity));
    const foreign = f.seed('a-foreign-owner', 'CANDIDATE_READY', 'RUNNING');
    const mismatched = initialOptimizationWorkflowRecord('a-old-mismatched-task', { functionName: 'kernel', entryFile: 'kernel.c', configPath: 'fixture.yaml', repositoryRoot: f.root });
    mismatched.status = 'GENERATING'; mismatched.optimization_task_id = foreign.optimization_task_id;
    f.store.saveOptimizationWorkflowJson(mismatched.workflow_id, JSON.stringify(mismatched));
    for (let i = 0; i < 205; i++) {
      const id = `z-other-${String(i).padStart(3, '0')}`;
      const record = initialOptimizationWorkflowRecord(id, { functionName: 'other', entryFile: null, configPath: 'fixture.yaml', repositoryRoot: f.root });
      record.status = 'FAILED'; f.store.saveOptimizationWorkflowJson(id, JSON.stringify(record));
    }
    assert.equal(f.store.listOptimizationWorkflowJson(200).some(json => JSON.parse(json).workflow_id === generating.workflow_id), false);
    service = f.service();
    const saved = service.get(generating.workflow_id)!;
    assert.equal(saved.status, 'INTERRUPTED');
    const savedReproduction = service.get(reproducing.workflow_id)!;
    assert.equal(savedReproduction.status, 'WAITING_APPROVAL');
    assert.equal(savedReproduction.reproduction?.status, 'UNKNOWN');
    assert.equal(savedReproduction.reproduction?.experiment_id, 'remote-original-id');
    assert.equal(savedReproduction.reproduction?.phase, '采样中');
    assert.equal(f.store.getOptimizationTask(reproducing.optimization_task_id!)?.status, 'WAITING_APPROVAL');
    assert.equal(f.store.getOptimizationTask(generating.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.match(service.get(beforeSession.workflow_id)!.progress!.last_event!, /会话尚未保存/);
    assert.equal(f.store.getOptimizationTask(beforeSession.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.equal(service.get(duringStartup.workflow_id)!.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(incomplete.optimization_task_id!)?.status, 'INTERRUPTED');
    assert.equal(service.get(priorTerminal.workflow_id)!.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(priorTerminal.optimization_task_id!)?.status, 'COMPLETED');
    assert.equal(service.get(missing.workflow_id)!.status, 'INTERRUPTED');
    assert.match(service.get(missing.workflow_id)!.error!, /领域任务记录不存在/);
    assert.equal(f.store.getOptimizationTask('missing-task'), null);
    assert.match(service.get(noIdentity.workflow_id)!.error!, /缺少领域任务身份/);
    assert.match(service.get(mismatched.workflow_id)!.error!, /属于其他工作流/);
    assert.equal(f.store.getOptimizationTask(foreign.optimization_task_id!)?.status, 'RUNNING');
    assert.deepEqual(service.get(alreadyDone.workflow_id), alreadyDone);
    assert.deepEqual(service.get(draft.workflow_id), draft);

    server = createHttpServer(new TaskHost(f.store), { host: '127.0.0.1', port: 0, workflowService: service });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/workflows/${generating.workflow_id}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { workflow: OptimizationWorkflowRecord; execution_attached: boolean };
    assert.equal(body.workflow.status, 'INTERRUPTED'); assert.equal(body.execution_attached, false);
    const reproductionResponse = await fetch(`http://127.0.0.1:${address.port}/v1/workflows/${reproducing.workflow_id}`);
    const reproductionBody = await reproductionResponse.json() as { workflow: OptimizationWorkflowRecord };
    assert.equal(reproductionBody.workflow.reproduction?.status, 'UNKNOWN');

    const once = f.store.getOptimizationWorkflowJson(generating.workflow_id);
    await service.stop(); service = f.service();
    assert.equal(f.store.getOptimizationWorkflowJson(generating.workflow_id), once, 'repeated startup is idempotent');
    assert.equal(f.store.listRecoverableWorkflowJson().length, 0);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    await service?.stop(); f.close();
  }
});

test('startup preserves a saved candidate and human approval when the task is already awaiting approval', async () => {
  const f = await startWebFixture();
  let recovered: OptimizationWorkflowService | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId);
    await approveFixture(f, seeded.workflowId);
    const workflow = f.service.get(seeded.workflowId)!;
    const task = f.store.getOptimizationTask(workflow.optimization_task_id!)!;
    f.store.saveOptimizationTask({ ...task, status: 'WAITING_APPROVAL' });
    const candidate = f.store.getCandidate(workflow.candidate_id!)!;
    const approval = f.store.getCandidateApproval(candidate.candidate_id)!;
    assert.equal(candidate.status, 'APPROVED');
    assert.equal(approval.approval_status, 'APPROVED');
    assert.ok(workflow.review_evidence);
    workflow.status = 'GENERATING';
    f.store.saveOptimizationWorkflowJson(workflow.workflow_id, JSON.stringify(workflow));
    await f.service.stop();
    recovered = new OptimizationWorkflowService({ store: f.store, transportFactory: () => { throw new Error('startup must not contact the Runner'); } });
    const saved = recovered.get(workflow.workflow_id)!;
    assert.equal(saved.status, 'INTERRUPTED');
    assert.match(saved.progress!.last_event!, /WAITING_APPROVAL/);
    assert.equal(f.store.getOptimizationTask(task.task_id)!.status, 'WAITING_APPROVAL');
    assert.deepEqual(f.store.getCandidate(candidate.candidate_id), candidate);
    assert.deepEqual(f.store.getCandidateApproval(candidate.candidate_id), approval);
    assert.deepEqual(saved.review_evidence, workflow.review_evidence);
  } finally { await recovered?.stop(); await f.close(); }
});

test('failed recovery rolls back both the workflow and its domain task', async () => {
  const f = fixture();
  const savedWrite = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    const record = f.seed('workflow:atomic-recovery', 'GENERATING', 'RUNNING');
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('fixture write failure after task update'); };
    assert.throws(() => f.service(), /fixture write failure/);
    assert.equal(JSON.parse(f.store.getOptimizationWorkflowJson(record.workflow_id)!).status, 'GENERATING');
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'RUNNING');
    f.store.saveOptimizationWorkflowJson = savedWrite;
    const recovered = f.service();
    assert.equal(recovered.get(record.workflow_id)!.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'INTERRUPTED');
    await recovered.stop();
  } finally { f.store.saveOptimizationWorkflowJson = savedWrite; f.close(); }
});

test('an older recovered source session can continue through the public API', async () => {
  const f = await sourceOptimizationFixture();
  try {
    const id = await f.start();
    const saved = await f.wait('CANDIDATE_READY');
    const firstCandidate = saved.candidate_id;
    // Model the durable records left when a continuation was interrupted.
    saved.status = 'GENERATING';
    f.store.saveOptimizationWorkflowJson(id, JSON.stringify(saved));
    const task = f.store.getOptimizationTask(saved.optimization_task_id!)!;
    f.store.saveOptimizationTask({ ...task, status: 'RUNNING' });
    for (let i = 0; i < 205; i++) {
      const otherId = `z-other-${String(i).padStart(3, '0')}`;
      const other = initialOptimizationWorkflowRecord(otherId, { functionName: 'other', entryFile: null, configPath: 'fixture.yaml', repositoryRoot: f.root });
      other.status = 'FAILED'; f.store.saveOptimizationWorkflowJson(otherId, JSON.stringify(other));
    }
    assert.equal(f.store.listOptimizationWorkflowJson(200).some(json => JSON.parse(json).workflow_id === id), false);
    await f.restart();
    assert.equal(f.service.get(id)!.status, 'INTERRUPTED');
    await f.api.resumeOptimizationWorkflow(id, { message: 'Continue the saved source-only session.' });
    const continued = await f.wait('CANDIDATE_READY');
    assert.notEqual(continued.candidate_id, firstCandidate);
    assert.equal(f.store.listCandidates(saved.optimization_task_id!).at(-1)?.parent_candidate_id, firstCandidate);
    assert.equal(f.store.listExperiments(saved.optimization_task_id!).length, 0);
  } finally { await f.close(); }
});
