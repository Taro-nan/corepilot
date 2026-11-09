import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { startWebFixture } from './web-fixture.js';

test('recovery returns the original task even when project defaults change', async () => {
  const f = await startWebFixture();
  try {
    f.git('branch', 'alternate');
    const project = f.projects.add({ name: 'Request recovery', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    f.projects.updateDefaults(project.project_id, { function_name: 'kernel' });
    const api = new ApiClient(f.url, { token: f.token });
    const input = { project_id: project.project_id, verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] } };
    const first = await api.submitOptimizationWorkflow(input, { requestId: 'original-request', apiKey: 'fixture-transient-secret' }) as { workflow_id: string };
    f.projects.updateDefaults(project.project_id, { source_branch: 'alternate', function_name: 'different' });
    const offlineConfig = f.configPath + '.offline';
    fs.renameSync(f.configPath, offlineConfig);
    let replay: { workflow_id: string; function_name: string };
    try {
      replay = await api.submitOptimizationWorkflow({ candidate_scope: { exclude: [], include: ['kernel.c'] }, verification_mode: 'source_only', project_id: project.project_id }, { requestId: 'original-request' }) as { workflow_id: string; function_name: string };
    } finally { fs.renameSync(offlineConfig, f.configPath); }
    assert.equal(replay.workflow_id, first.workflow_id);
    assert.equal(replay.function_name, 'kernel');
    const lookup = f.service.replayIntake.bind(f.service);
    f.service.replayIntake = () => null; // A concurrent request won after an initially empty lookup.
    try {
      const later = await api.submitOptimizationWorkflow(input, { requestId: 'original-request' }) as { workflow_id: string; function_name: string };
      assert.equal(later.workflow_id, first.workflow_id);
      assert.equal(later.function_name, 'kernel');
    } finally { f.service.replayIntake = lookup; }
    assert.equal(f.service.get(first.workflow_id)?.source_branch, 'main');
    assert.doesNotMatch(JSON.stringify(f.service.get(first.workflow_id)), /fixture-transient-secret/);
    assert.deepEqual(await api.getOptimizationIntake('original-request'), { status: 'CREATED', workflow_id: first.workflow_id });
    assert.deepEqual(await api.closeOptimizationIntake('original-request'), { status: 'CREATED', workflow_id: first.workflow_id });
    await assert.rejects(api.submitOptimizationWorkflow({ ...input, source_branch: 'alternate' }, { requestId: 'original-request' }),
      (error: ApiClientError) => error.status === 409 && error.code === 'WORKFLOW_REQUEST_CONFLICT');
    assert.equal(f.service.list().length, 1);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('not found is not final; atomically closing prevents a delayed submission', async () => {
  const f = await startWebFixture();
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const input = { verification_mode: 'source_only', function_name: 'kernel', entry_file: null, config_path: f.configPath,
      repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } };
    assert.deepEqual(await api.getOptimizationIntake('delayed'), { status: 'NOT_FOUND' });
    assert.deepEqual(await api.closeOptimizationIntake('delayed'), { status: 'CLOSED' });
    assert.deepEqual(await api.closeOptimizationIntake('delayed'), { status: 'CLOSED' });
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'delayed' }),
      (error: ApiClientError) => error.status === 409 && error.code === 'WORKFLOW_REQUEST_CLOSED');
    assert.equal(f.service.list().length, 0);
    const created = await api.submitOptimizationWorkflow(input, { requestId: 'new-request' }) as { workflow_id: string };
    assert.ok(f.service.get(created.workflow_id));
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('legacy request digests retain their original semantics and existing records', async () => {
  const f = await startWebFixture();
  try {
    f.git('branch', 'alternate');
    const project = f.projects.add({ name: 'Historical request', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    f.projects.updateDefaults(project.project_id, { function_name: 'kernel' });
    const api = new ApiClient(f.url, { token: f.token });
    const input = { project_id: project.project_id, verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] } };
    const first = await api.submitOptimizationWorkflow(input, { requestId: 'historical' }) as { workflow_id: string };
    const historical = f.service.get(first.workflow_id)!;
    delete historical.request_input_digest;
    f.store.saveOptimizationWorkflowJson(first.workflow_id, JSON.stringify(historical));
    assert.equal((await api.submitOptimizationWorkflow(input, { requestId: 'historical' }) as { workflow_id: string }).workflow_id, first.workflow_id);
    f.projects.updateDefaults(project.project_id, { source_branch: 'alternate' });
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'historical' }),
      (error: ApiClientError) => error.status === 409 && error.code === 'WORKFLOW_REQUEST_CONFLICT');
    assert.deepEqual(await api.closeOptimizationIntake('historical'), { status: 'CREATED', workflow_id: first.workflow_id });
    assert.equal(f.service.list().length, 1);
  } finally { await f.close(); }
});

test('ambiguous historical keys cannot be queried or closed as a single task', async () => {
  const f = await startWebFixture();
  const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const first = await api.submitOptimizationWorkflow({ verification_mode: 'source_only', function_name: 'kernel', entry_file: null,
      config_path: f.configPath, repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } }, { requestId: 'ambiguous' }) as { workflow_id: string };
    const record = f.service.get(first.workflow_id)!;
    f.store.saveOptimizationWorkflowJson('workflow:duplicate', JSON.stringify({ ...record, workflow_id: 'workflow:duplicate' }));
    const ambiguous = (error: ApiClientError) => error.status === 409 && error.code === 'WORKFLOW_REQUEST_AMBIGUOUS';
    await assert.rejects(api.getOptimizationIntake('ambiguous'), ambiguous);
    await assert.rejects(api.closeOptimizationIntake('ambiguous'), ambiguous);
    assert.equal(f.service.list().length, 2);
    assert.equal((db.prepare('SELECT count(*) AS count FROM optimization_intake_closures').get() as { count: number }).count, 0);
  } finally { db.close(); await f.close(); }
});

test('exclusive database contention reports unknown and retains the request', async () => {
  const f = await startWebFixture();
  const blocker = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    const api = new ApiClient(f.url, { token: f.token });
    blocker.exec('BEGIN EXCLUSIVE');
    const busy = (error: ApiClientError) => error.status === 503 && error.code === 'WORKFLOW_REQUEST_BUSY';
    const ownershipUnknown = (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_UNKNOWN';
    await assert.rejects(api.getOptimizationIntake('locked'), busy);
    // Writes must fail before changing the intake when the lease cannot be checked.
    await assert.rejects(api.closeOptimizationIntake('locked'), ownershipUnknown);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: 'any' }, { requestId: 'locked' }), ownershipUnknown);
    blocker.exec('ROLLBACK');
    assert.deepEqual(await api.getOptimizationIntake('locked'), { status: 'NOT_FOUND' });
    assert.deepEqual(await api.closeOptimizationIntake('locked'), { status: 'CLOSED' });
    assert.equal(f.service.list().length, 0);
  } finally { blocker.close(); await f.close(); }
});

const workerScript = `
import { SqliteTaskStore } from './src/storage/sqlite-task-store.ts';
import fs from 'node:fs';
const store = new SqliteTaskStore(process.env.TEST_DB);
const task = JSON.parse(process.env.TEST_TASK), workflow = JSON.parse(process.env.TEST_WORKFLOW);
const action = process.env.TEST_ACTION;
if (process.env.TEST_HOLD === 'yes') {
  const name = action === 'create' ? 'saveOptimizationTask' : 'getOptimizationWorkflowByRequestId';
  const original = store[name].bind(store);
  let held = false;
  store[name] = (...args) => {
    if (!held) {
      held = true; process.stdout.write('LOCKED\\n');
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(process.env.TEST_RELEASE)) {
        if (Date.now() > deadline) throw new Error('test did not release the lock');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    return original(...args);
  };
}
process.stdout.write('READY\\n');
process.stdin.once('data', () => {
  try { const result = action === 'create' ? store.createOptimizationIntake(task, workflow) : store.closeOptimizationIntake(workflow.request_id);
    process.stdout.write('RESULT ' + JSON.stringify({ ok: true, result }) + '\\n'); }
  catch (error) { process.stdout.write('RESULT ' + JSON.stringify({ ok: false, code: error.code, message: error.message }) + '\\n'); }
  store.close(); process.stdin.destroy();
});`;

/** Real processes contend on the same on-disk SQLite database, not a mocked lookup. */
test('same-key creates and closes serialize across processes; a busy loser must retry the same key', async () => {
  for (const scenario of ['create-close', 'close-create', 'create-create'] as const) {
    const f = await startWebFixture();
    try {
      const api = new ApiClient(f.url, { token: f.token });
      const seed = await api.submitOptimizationWorkflow({ verification_mode: 'source_only', function_name: 'kernel', entry_file: null,
        config_path: f.configPath, repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } }, { requestId: 'seed' }) as { workflow_id: string };
      const original = f.service.get(seed.workflow_id)!;
      const task = f.store.getOptimizationTask(original.optimization_task_id!)!;
      const workflow = { ...original, workflow_id: 'workflow:race', optimization_task_id: 'task:race', request_id: 'race' };
      const candidate = { ...task, task_id: 'task:race', workflow_id: 'workflow:race' };
      function worker(action: 'create' | 'close', hold: boolean) {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerScript], {
          cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
            TEST_DB: path.join(f.root, 'db.sqlite'), TEST_TASK: JSON.stringify(candidate), TEST_WORKFLOW: JSON.stringify(workflow), TEST_ACTION: action,
            TEST_HOLD: hold ? 'yes' : 'no', TEST_RELEASE: path.join(f.root, 'release-intake-lock') },
        });
        let output = '', errors = '';
        child.stdout.on('data', chunk => { output += String(chunk); });
        child.stderr.on('data', chunk => { errors += String(chunk); });
        const exited = once(child, 'exit');
        const until = async (marker: string) => {
          const deadline = Date.now() + 15_000;
          while (!output.includes(marker)) {
            if (child.exitCode !== null || Date.now() > deadline) throw new Error(`worker exited/timed out: ${output} ${errors}`);
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        };
        return { child, exited, until, result: () => JSON.parse(output.split('RESULT ')[1].split('\n')[0]) as { ok: boolean; result?: unknown; message?: string } };
      }
      const winnerAction = scenario === 'close-create' ? 'close' : 'create';
      const loserAction = scenario === 'create-close' ? 'close' : 'create';
      const winner = worker(winnerAction, true), loser = worker(loserAction, false);
      try {
        await Promise.all([winner.until('READY'), loser.until('READY')]);
        winner.child.stdin.end('go'); await winner.until('LOCKED');
        loser.child.stdin.end('go');
        await loser.until('RESULT ');
        fs.writeFileSync(path.join(f.root, 'release-intake-lock'), 'release');
        await winner.until('RESULT ');
        await Promise.all([winner.exited, loser.exited]);
        assert.equal(winner.result().ok, true);
        assert.equal(loser.result().ok, false);
        assert.match(loser.result().message ?? '', /database is locked/);
        if (scenario === 'create-close') {
          assert.deepEqual(f.store.closeOptimizationIntake('race'), { status: 'CREATED', workflow_id: 'workflow:race' });
          assert.equal(f.service.list().length, 2);
        } else if (scenario === 'close-create') {
          assert.throws(() => f.store.createOptimizationIntake(candidate, workflow), /该创建请求已关闭/);
          assert.equal(f.service.list().length, 1);
        } else {
          assert.deepEqual(f.store.createOptimizationIntake(candidate, workflow), { workflowId: 'workflow:race', created: false });
          assert.throws(() => f.store.createOptimizationIntake(candidate, { ...workflow, request_input_digest: 'different' }), /different optimization inputs/);
          assert.equal(f.service.list().length, 2);
        }
      } finally { winner.child.kill(); loser.child.kill(); }
    } finally { await f.close(); }
  }
});
