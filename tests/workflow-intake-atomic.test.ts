import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { startWebFixture } from './web-fixture.js';

const modes = ['source_only', 'verified'] as const;

function input(f: Awaited<ReturnType<typeof startWebFixture>>, mode: typeof modes[number]) {
  return { verification_mode: mode, function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath, repository_root: f.repo,
    ...(mode === 'source_only' ? { candidate_scope: { include: ['kernel.c'], exclude: [] } } : {}) };
}

function counts(db: DatabaseSync) {
  const count = (table: 'optimization_tasks' | 'optimization_workflows') =>
    (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
  return { tasks: count('optimization_tasks'), workflows: count('optimization_workflows') };
}

test('HTTP intake rolls back task and workflow together after the second write fails, for both modes', async () => {
  for (const mode of modes) {
    const f = await startWebFixture();
    const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
    try {
      const api = new ApiClient(f.url, { token: f.token });
      const body = input(f, mode), key = `failure-${mode}`;
      const before = counts(db);
      f.store.saveOptimizationWorkflowJson = () => { throw new Error('injected second write failure'); };
      await assert.rejects(api.submitOptimizationWorkflow(body, { requestId: key }), /injected second write failure/);
      assert.deepEqual(counts(db), before);
      assert.equal(f.store.getOptimizationWorkflowByRequestId(key), null);
      assert.equal(f.service.activeWorkflowIds().length, 0);
      assert.equal(f.modelRequests.inference, 0);
      f.store.saveOptimizationWorkflowJson = save;
      const first = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string };
      const repeat = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string };
      assert.equal(repeat.workflow_id, first.workflow_id);
      assert.deepEqual(counts(db), { tasks: before.tasks + 1, workflows: before.workflows + 1 });
      const record = f.service.get(first.workflow_id)!;
      assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.workflow_id, first.workflow_id);
      assert.equal(f.modelRequests.inference, 0);
    } finally { f.store.saveOptimizationWorkflowJson = save; db.close(); await f.close(); }
  }
});

test('the transaction handles a stale idempotency lookup without duplicating either optimization mode', async () => {
  for (const mode of modes) {
    const f = await startWebFixture();
    const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    const lookup = f.store.getOptimizationWorkflowByRequestId.bind(f.store);
    let racing: OptimizationWorkflowService | undefined;
    try {
      const api = new ApiClient(f.url, { token: f.token });
      const body = input(f, mode), key = `race-${mode}`;
      const original = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string };
      const before = counts(db);
      let stale = true;
      f.store.getOptimizationWorkflowByRequestId = requestId => {
        if (stale) { stale = false; return null; }
        return lookup(requestId);
      };
      const replay = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string };
      assert.equal(replay.workflow_id, original.workflow_id);
      assert.deepEqual(counts(db), before);
      racing = new OptimizationWorkflowService({ store: f.store, publicExecution: true, transportFactory: () => { throw new Error('a replay must not contact Runner'); } });
      stale = true;
      assert.equal(racing.submitPublic(body, { requestId: key }).workflowId, original.workflow_id);
      assert.equal(racing.activeWorkflowIds().length, 0, 'the transaction loser must not launch another execution');
      assert.deepEqual(counts(db), before);
      stale = true;
      await assert.rejects(api.submitOptimizationWorkflow({ ...body, budget: { max_candidates: 2 } }, { requestId: key }), /different optimization inputs/);
      assert.deepEqual(counts(db), before);
      assert.equal(f.modelRequests.inference, 0);
    } finally { f.store.getOptimizationWorkflowByRequestId = lookup; await racing?.stop(); db.close(); await f.close(); }
  }
});

test('a restart after intake commit but before launch records an interrupted task and retains the request ID', async () => {
  for (const mode of modes) {
    const f = await startWebFixture({ execute: true });
    const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    const create = f.store.createOptimizationIntake.bind(f.store);
    let recovered: OptimizationWorkflowService | undefined;
    try {
      const api = new ApiClient(f.url, { token: f.token });
      const body = input(f, mode), key = `restart-${mode}`;
      let workflowId = '';
      f.store.createOptimizationIntake = (task, workflow) => {
        const saved = create(task, workflow);
        workflowId = saved.workflowId;
        throw new Error('injected crash after committed intake');
      };
      await assert.rejects(api.submitOptimizationWorkflow(body, { requestId: key }), /injected crash after committed intake/);
      f.store.createOptimizationIntake = create;
      assert.ok(workflowId);
      const pending = f.service.get(workflowId)!;
      assert.equal(pending.status, 'GENERATING');
      assert.equal(pending.progress?.phase, 'PUBLIC_INTAKE_STARTING');
      assert.equal(f.store.getOptimizationTask(pending.optimization_task_id!)?.status, 'CREATED');
      assert.equal(f.service.activeWorkflowIds().length, 0);
      const before = counts(db);
      recovered = new OptimizationWorkflowService({ store: f.store, publicExecution: true, transportFactory: () => { throw new Error('restart must not contact Runner'); } });
      const interrupted = recovered.get(workflowId)!;
      assert.equal(interrupted.status, 'INTERRUPTED');
      assert.match(interrupted.progress?.last_event ?? '', /会话尚未保存/);
      assert.equal(f.store.getOptimizationTask(interrupted.optimization_task_id!)?.status, 'INTERRUPTED');
      const replay = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string; status: string };
      assert.equal(replay.workflow_id, workflowId);
      assert.equal(replay.status, 'INTERRUPTED');
      assert.deepEqual(counts(db), before);
      assert.equal(f.modelRequests.inference, 0);
    } finally { f.store.createOptimizationIntake = create; await recovered?.stop(); db.close(); await f.close(); }
  }
});

test('ambiguous historical request keys and orphan tasks are preserved without selecting or deleting records', async () => {
  const f = await startWebFixture();
  const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const body = input(f, 'source_only'), key = 'duplicate-history';
    const first = await api.submitOptimizationWorkflow(body, { requestId: key }) as { workflow_id: string };
    const existing = f.service.get(first.workflow_id)!;
    const duplicate = { ...existing, workflow_id: 'workflow:historical-duplicate' };
    f.store.saveOptimizationWorkflowJson(duplicate.workflow_id, JSON.stringify(duplicate));
    const runtime = new OptimizationRuntime(f.store);
    const orphan = runtime.createTask({ workflowId: 'workflow:historical-orphan', target: { kind: 'kernel', name: 'orphan', scope: {} },
      sourceBaseline: { id: 'historical' }, performanceBaseline: null, evaluator: null, declaredContext: {} });
    const before = counts(db);
    await assert.rejects(api.submitOptimizationWorkflow(body, { requestId: key }), /对应多条历史工作流记录/);
    assert.deepEqual(counts(db), before);
    assert.deepEqual(f.store.getOptimizationTask(orphan.task_id), orphan);
    assert.deepEqual(f.service.get(first.workflow_id), existing);
    assert.deepEqual(f.service.get(duplicate.workflow_id), duplicate);
    assert.equal(f.modelRequests.inference, 0);
  } finally { db.close(); await f.close(); }
});
