import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BackendManager, BackendError } from '../src/backend/backend-manager.js';
import { probeBackend } from '../src/backend/health.js';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { CONTROL_GUARD_HEADER } from '../src/contracts/control-identity.js';
import { TestingStore } from '../src/storage/testing-store.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { sourceOptimizationFixture } from './source-optimization-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('an expired lease cannot be revived by its former owner', async () => {
  const f = await startWebFixture();
  const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1').run('2000-01-01T00:00:00.000Z');
    assert.equal(f.store.renewLease(f.host.ownerId, 30_000), false);
    assert.equal(f.host.executionOwnership(), 'LOST');
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.health(), (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_LOST');
    assert.equal((await api.listOptimizationWorkflows()).workflows.length, 0);
    assert.ok(await api.getControlIdentity());
  } finally { db.close(); await f.close(); }
});

test('a temporarily unreadable lease is unknown, rather than reported as a confirmed loss', async () => {
  const f = await startWebFixture();
  const lookup = f.store.getActiveLease.bind(f.store);
  try {
    f.store.getActiveLease = () => { throw new Error('fixture read unavailable'); };
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.health(), (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_UNKNOWN');
    await assert.rejects(api.submitOptimizationWorkflow({ function_name: 'kernel' }),
      (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_UNKNOWN');
    assert.equal(f.service.list().length, 0);
    f.store.getActiveLease = lookup;
    assert.equal((await api.health() as { status: string }).status, 'ok');
  } finally { f.store.getActiveLease = lookup; await f.close(); }
});

test('a second process taking the lease blocks new work while saved testing facts remain local', async () => {
  const testing = createTestingFixture();
  const f = await startWebFixture({ testingService: testing.service });
  const sql = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const input = { verification_mode: 'source_only', function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath,
      repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } };
    const existing = await api.submitOptimizationWorkflow(input, { requestId: 'existing' }) as { workflow_id: string };
    const beforeWorkflow = f.service.get(existing.workflow_id)!;
    let cancelCalls = 0;
    const factory = testing.options.runnerFactory!;
    testing.options.runnerFactory = machine => {
      const runner = factory(machine);
      return { ...runner, async cancelExperiment(id) { cancelCalls++; return runner.cancelExperiment(id); } };
    };
    const candidate = await testing.binary('candidate'), baseline = await testing.binary('baseline');
    const preview = testing.service.plan(testingPlanRef);
    const testInput = { machine_id: testing.machine.identity.machine_id, plan: testingPlanRef, mode: 'performance' as const, candidate, baseline,
      expected_evaluator_digest: preview.evaluator.digest, expected_package_digest: preview.package_digest };
    const { task } = await api.testing.start(testInput, 'existing-testing');
    await waitTestingPreparation(testing.service, task.task_id);
    assert.equal(testing.plans.length, 1);
    const testingStore = new TestingStore(testing.root);
    testingStore.updateTask(task.task_id, item => { item.execution.cancel_requested = true; });
    const taskPath = path.join(testingStore.taskRoot(task.task_id), 'task.json');
    const beforeTask = fs.readFileSync(taskPath);
    const runnerReads = testing.getCalls;
    const identity = await api.getControlIdentity();
    const body = Buffer.from(JSON.stringify(input));
    const midpoint = Math.floor(body.length / 2);
    let accept!: (value: { status: number; body: string }) => void, reject!: (reason: Error) => void;
    const delayedResponse = new Promise<{ status: number; body: string }>((resolve, fail) => { accept = resolve; reject = fail; });
    const delayed = http.request(`${f.url}/v1/control-identities/${identity.database_id}/${identity.data_root_id}/workflows`, {
      method: 'POST', headers: { authorization: `Bearer ${f.token}`, [CONTROL_GUARD_HEADER]: '1', 'idempotency-key': 'slow-lease',
        'content-type': 'application/json', 'content-length': String(body.length) },
    }, response => { let value = ''; response.on('data', chunk => { value += String(chunk); }); response.on('end', () => accept({ status: response.statusCode ?? 0, body: value })); });
    delayed.on('error', reject);
    await new Promise<void>((resolve, fail) => delayed.write(body.subarray(0, midpoint), error => error ? fail(error) : resolve()));
    sql.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1').run('2000-01-01T00:00:00.000Z');
    const source = `
import { SqliteTaskStore } from './src/storage/sqlite-task-store.ts';
import { TaskHost } from './src/core/task-host.ts';
const host = new TaskHost(new SqliteTaskStore(process.env.TEST_DB));
await host.start(); process.stdout.write('ACQUIRED\\n');
process.stdin.once('data', async () => { await host.stop(); process.stdin.destroy(); });`;
    worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TEST_DB: path.join(f.root, 'db.sqlite') } });
    let output = '', stderr = '';
    worker.stdout!.on('data', chunk => { output += String(chunk); }); worker.stderr!.on('data', chunk => { stderr += String(chunk); });
    const workerExit = once(worker, 'exit');
    const deadline = Date.now() + 15_000;
    while (!output.includes('ACQUIRED')) {
      if (worker.exitCode !== null || Date.now() > deadline) throw new Error(`takeover worker failed: ${output} ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    delayed.end(body.subarray(midpoint));
    const slow = await delayedResponse;
    assert.equal(slow.status, 503); assert.equal(JSON.parse(slow.body).error.code, 'CONTROL_LEASE_LOST');
    assert.equal(f.host.executionOwnership(), 'LOST');
    await assert.rejects(api.health(), (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_LOST');
    const probe = await probeBackend(f.url); assert.equal(probe.kind, 'unhealthy');
    let spawned = 0;
    const manager = new BackendManager({ url: f.url, allowSpawn: true, spec: { host: '127.0.0.1', port: Number(new URL(f.url).port),
      dbPath: path.join(f.root, 'db.sqlite'), runner: 'workflow', transport: 'mock', sshAlias: null },
      spawn: () => { spawned++; throw new Error('must not spawn'); } });
    await assert.rejects(manager.ensure(), (error: BackendError) => error.code === 'CONTROL_UNAVAILABLE');
    assert.equal(spawned, 0);
    const lost = (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_LOST';
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'new-opt' }), lost);
    await assert.rejects(api.resumeOptimizationWorkflow(existing.workflow_id), lost);
    await assert.rejects(api.retryOptimizationValidation(existing.workflow_id), lost);
    await assert.rejects(api.cancelOptimizationWorkflow(existing.workflow_id), lost);
    await assert.rejects(api.cancelReproduction(existing.workflow_id), lost);
    const oldCancel = await fetch(`${f.url}/v1/tasks/not-owned/cancel`, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command_id: 'cancel' }) });
    assert.equal(oldCancel.status, 503); assert.equal((await oldCancel.json()).error.code, 'CONTROL_LEASE_LOST');
    await assert.rejects(api.testing.start(testInput, 'new-testing'), lost);
    await assert.rejects(api.testing.cancel(task.task_id), lost);
    assert.deepEqual(f.service.get(existing.workflow_id), beforeWorkflow);
    assert.equal(f.service.list().length, 1); assert.equal(testing.plans.length, 1);
    const list = await api.testing.list();
    assert.equal(list.observation?.status, 'LOCAL_ONLY');
    const details = await api.testing.get(task.task_id);
    assert.equal(details.observation?.status, 'LOCAL_ONLY');
    assert.equal(testing.getCalls, runnerReads); assert.equal(cancelCalls, 0);
    assert.deepEqual(fs.readFileSync(taskPath), beforeTask);
    assert.equal((await api.listOptimizationWorkflows()).workflows.length, 1);
    assert.deepEqual(await api.getControlIdentity(), identity);
    assert.equal(f.modelRequests.inference, 0);
    worker.stdin!.end('stop'); await workerExit;
  } finally {
    worker?.kill(); sql.close(); await f.close(); testing.close();
  }
});

test('an unhealthy port observed during startup is not attributed to the newly spawned child', async () => {
  const f = await startWebFixture();
  try {
    let probes = 0, killed = 0, unreferenced = 0;
    const statePath = path.join(f.root, 'unclaimed', 'backend.json');
    const manager = new BackendManager({ url: f.url, allowSpawn: true, statePath,
      spec: { host: '127.0.0.1', port: Number(new URL(f.url).port), dbPath: path.join(f.root, 'db.sqlite'), runner: 'workflow', transport: 'mock', sshAlias: null },
      probe: async () => ++probes === 1 ? { kind: 'unreachable', detail: 'fixture' } : { kind: 'unhealthy', code: 'CONTROL_LEASE_LOST', reason: '租约已失效',
        health: { service: 'corepilot', runner: 'workflow', status: 'unavailable', version: 'fixture', api_version: 1, capabilities: [] } },
      spawn: () => ({ pid: 1234, exited: new Promise(() => {}), stderrTail: () => '', kill: () => { killed++; }, unref: () => { unreferenced++; } }),
      sleep: async () => {},
    });
    await assert.rejects(manager.ensure(), (error: BackendError) => error.code === 'CONTROL_UNAVAILABLE' && /归属未确认/.test(error.diagnostics));
    assert.equal(killed, 0); assert.equal(unreferenced, 1);
    assert.equal(fs.existsSync(statePath), false);
  } finally { await f.close(); }
});

test('a failed lease renewal enters unknown state and does not silently continue scheduling', async () => {
  const f = await startWebFixture();
  const renew = f.store.renewLease.bind(f.store);
  try {
    f.store.renewLease = () => { throw new Error('fixture database failure'); };
    const host = f.host as unknown as { lastLeaseRenew: number; renewLeaseIfDue(): void };
    host.lastLeaseRenew = 0; host.renewLeaseIfDue();
    f.store.renewLease = renew;
    assert.equal(f.host.executionOwnership(), 'UNKNOWN');
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.health(), (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_UNKNOWN');
    assert.equal(f.service.list().length, 0);
  } finally { f.store.renewLease = renew; await f.close(); }
});

test('lease loss does not turn an already in-flight local optimization into cancellation or failure', async () => {
  const f = await sourceOptimizationFixture({ holdFirst: true });
  const db = new DatabaseSync(path.join(f.root, 'control.sqlite'));
  try {
    const id = await f.start();
    for (let attempt = 0; attempt < 300 && !f.held; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.held, true);
    const before = f.service.get(id)!;
    assert.equal(before.status, 'GENERATING');
    db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1').run('2000-01-01T00:00:00.000Z');
    await assert.rejects(f.api.health(), (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_LEASE_LOST');
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = f.service.get(id)!;
    assert.equal(after.status, 'GENERATING');
    assert.equal(after.candidate_id, before.candidate_id);
    assert.equal(after.error, before.error);
    assert.ok(f.service.activeWorkflowIds().includes(id), 'the existing work has not been declared stopped');
  } finally { db.close(); await f.close(); }
});
