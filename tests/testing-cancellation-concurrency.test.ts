import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TestingService } from '../src/application/testing-service.js';
import type { TestingRunner } from '../src/application/testing-subjects.js';
import { ApiClient } from '../src/client/api-client.js';
import { RunnerClientError } from '../src/client/runner-client.js';
import { TaskHost } from '../src/core/task-host.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { TestingStore } from '../src/storage/testing-store.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

type Fixture = ReturnType<typeof createTestingFixture>;
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 1_000; i++) { if (predicate()) return; await delay(10); }
  throw new Error('testing concurrency fixture timed out');
}
async function controlHost(root: string) {
  const host = new TaskHost(new SqliteTaskStore(path.join(root, 'control-a.sqlite'))); await host.start(); return host;
}
function workerDescription(f: Fixture, additional: Record<string, unknown>) {
  const filename = path.join(f.root, `worker-${randomUUID()}.json`);
  fs.writeFileSync(filename, JSON.stringify({ root: f.root, machine: f.machine,
    hostDb: path.join(f.root, `control-b-${randomUUID()}.sqlite`), ...additional }));
  return filename;
}
function cancelFromAnotherControl(f: Fixture, taskId: string, reply: 'missing' | 'cancelled' = 'missing') {
  const description = workerDescription(f, { taskId, reply });
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/testing-cancellation-worker.ts', 'cancel', description],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(child.status, 0, `cancel worker failed: ${child.error ?? child.stderr}`);
  return JSON.parse(child.stdout.trim()) as { execution: { status: string; cancel_requested: boolean; submission_attempted: boolean } };
}
function observeFromAnotherControl(f: Fixture, taskId: string) {
  const description = workerDescription(f, { taskId, reply: 'cancelled' });
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/testing-cancellation-worker.ts', 'get', description],
    { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.equal(child.status, 0, `read worker failed: ${child.error ?? child.stderr}`);
  return JSON.parse(child.stdout.trim()) as { execution: { status: string; cancel_requested: boolean } };
}
function startWorker(action: string, description: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/testing-cancellation-worker.ts', action, description],
    { cwd: process.cwd(), windowsHide: true });
  let output = '', error = '';
  child.stdout!.on('data', chunk => { output += chunk.toString(); });
  child.stderr!.on('data', chunk => { error += chunk.toString(); });
  return { child, output: () => output, error: () => error };
}
async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL'); await exited;
}
async function workerExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
}

test('another Control cannot claim a live preparation has stopped', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let release!: () => void;
  try {
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.phase === 'STAGING_SUBJECTS');
    const cancelled = cancelFromAnotherControl(f, task.task_id);
    assert.equal(cancelled.execution.status, 'UNKNOWN'); assert.equal(cancelled.execution.cancel_requested, true);
    assert.equal(f.plans.length, 0);
    release(); await waitFor(() => f.service.list()[0].execution.status === 'CANCELLED');
    assert.equal(f.plans.length, 0); assert.equal(f.service.list()[0].execution.cancel_requested, true);
  } finally { release?.(); await delay(20); await host.stop(); f.close(); }
});

test('two HTTP controls with different workflow databases expose the same pending cancellation', async () => {
  const f = createTestingFixture(), other = new TestingService(f.options); let release!: () => void;
  const first = await startWebFixture({ testingService: f.service }), second = await startWebFixture({ testingService: other });
  try {
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const a = new ApiClient(first.url, { token: first.token }), b = new ApiClient(second.url, { token: second.token });
    const { task } = await a.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.phase === 'STAGING_SUBJECTS');
    const cancellation = await b.testing.cancel(task.task_id);
    assert.equal(cancellation.task.execution.status, 'UNKNOWN'); assert.equal(cancellation.task.execution.cancel_requested, true);
    release(); await waitFor(() => f.service.list()[0].execution.status === 'CANCELLED');
    const checked = await b.testing.get(task.task_id);
    assert.equal(checked.task.execution.status, 'CANCELLED'); assert.equal(checked.task.execution.cancel_requested, true);
    assert.equal(f.plans.length, 0);
  } finally { release?.(); await delay(20); await first.close(); await second.close(); f.close(); }
});

test('a cross-process cancellation wins before submission intent is claimed', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root), original = TestingStore.prototype.updateTask;
  let fired = false, receipt: ReturnType<typeof cancelFromAnotherControl> | undefined;
  try {
    const candidate = await f.binary('candidate');
    TestingStore.prototype.updateTask = function (id, change) {
      const current = this.task(id);
      if (!fired && current.execution.phase === 'STAGING_TESTS' && !current.execution.submission_attempted) {
        fired = true; receipt = cancelFromAnotherControl(f, id);
      }
      return original.call(this, id, change);
    };
    await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.status === 'CANCELLED');
    assert.equal(fired, true); assert.equal(receipt?.execution.status, 'UNKNOWN');
    assert.equal(f.service.list()[0].execution.cancel_requested, true); assert.equal(f.plans.length, 0);
  } finally { TestingStore.prototype.updateTask = original; await delay(20); await host.stop(); f.close(); }
});

test('a writer holding an old snapshot cannot erase another Control cancellation', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let releaseOwner!: () => void;
  let writer: ReturnType<typeof startWorker> | undefined, canceller: ReturnType<typeof startWorker> | undefined;
  const marker = path.join(f.root, 'writer-locked'), release = path.join(f.root, 'release-writer');
  try {
    f.setStagingGate(new Promise<void>(resolve => { releaseOwner = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.phase === 'STAGING_SUBJECTS');
    writer = startWorker('hold-update', workerDescription(f, { taskId: task.task_id, marker, release }));
    await waitFor(() => fs.existsSync(marker));
    canceller = startWorker('cancel', workerDescription(f, { taskId: task.task_id, reply: 'missing', announce: true }));
    await waitFor(() => canceller!.output().includes('CANCEL_READY\n'));
    fs.writeFileSync(release, 'continue');
    assert.equal(await workerExit(writer.child), 0, writer.error());
    assert.equal(await workerExit(canceller.child), 0, canceller.error());
    const response = JSON.parse(canceller.output().split('\n').find(line => line.startsWith('{'))!);
    assert.equal(response.execution.status, 'UNKNOWN'); assert.equal(response.execution.cancel_requested, true);
    assert.equal(new TestingStore(f.root).task(task.task_id).execution.cancel_requested, true);
    releaseOwner(); await waitFor(() => f.service.list()[0].execution.status === 'CANCELLED');
    assert.equal(f.plans.length, 0);
  } finally {
    if (!fs.existsSync(release)) fs.writeFileSync(release, 'continue');
    if (writer) await stopWorker(writer.child); if (canceller) await stopWorker(canceller.child);
    releaseOwner?.(); await delay(20); await host.stop(); f.close();
  }
});

for (const reply of ['missing', 'cancelled'] as const) test(`a ${reply} cancellation receipt cannot be lost behind a late submission receipt`, async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let release!: () => void, remoteCancels = 0;
  try {
    const runner = f.options.runnerFactory!(f.machine), originalCancel = runner.cancelExperiment.bind(runner);
    runner.cancelExperiment = async id => { remoteCancels++; return originalCancel(id); };
    f.setSubmitGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.plans.length === 1);
    const cancelled = cancelFromAnotherControl(f, task.task_id, reply);
    assert.equal(cancelled.execution.status, reply === 'missing' ? 'UNKNOWN' : 'CANCELLED');
    assert.equal(cancelled.execution.cancel_requested, true);
    release(); await delay(100);
    const after = f.service.list()[0].execution;
    assert.equal(after.cancel_requested, true); assert.equal(after.submission_attempted, true); assert.equal(f.plans.length, 1);
    if (reply === 'cancelled') { assert.equal(after.status, 'CANCELLED'); assert.equal(remoteCancels, 0); }
    else { assert.equal(after.status, 'UNKNOWN'); assert.equal(remoteCancels, 1); }
  } finally { release?.(); await delay(20); await host.stop(); f.close(); }
});

test('a late submission receipt cannot regress a Runner status already observed by another Control', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let release!: () => void;
  try {
    f.setSubmitGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.plans.length === 1);
    assert.equal(observeFromAnotherControl(f, task.task_id).execution.status, 'RUNNING');
    release(); await waitFor(() => f.service.list()[0].execution.phase === 'SUBMITTED');
    assert.equal(f.service.list()[0].execution.status, 'RUNNING');
  } finally { release?.(); await delay(20); await host.stop(); f.close(); }
});

test('a stale Runner GET cannot replace a confirmed cancellation or cache a stale view', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let release!: () => void, entered!: () => void;
  try {
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitTestingPreparation(f.service, task.task_id);
    const runner = f.options.runnerFactory!(f.machine), originalGet = runner.getExperiment.bind(runner);
    const gate = new Promise<void>(resolve => { release = resolve; }), called = new Promise<void>(resolve => { entered = resolve; });
    runner.getExperiment = async id => { const stale = await originalGet(id); entered(); await gate; return stale; };
    const pending = f.service.get(task.task_id); await called;
    const cancelled = cancelFromAnotherControl(f, task.task_id, 'cancelled');
    assert.equal(cancelled.execution.status, 'CANCELLED'); release();
    assert.equal((await pending).task.execution.status, 'CANCELLED');
    assert.equal(f.service.list()[0].execution.status, 'CANCELLED');
    assert.equal(f.service.list()[0].execution.cancel_requested, true);
    const cached = new TestingStore(f.root).cache(task.task_id);
    assert.ok(!cached || cached.task.execution.status !== 'RUNNING');
  } finally { release?.(); await delay(20); await host.stop(); f.close(); }
});

test('a result fetched before cancellation cannot replace its newer cached task state', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root), original = TestingStore.prototype.saveResult; let fired = false;
  try {
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitTestingPreparation(f.service, task.task_id);
    TestingStore.prototype.saveResult = function (result) {
      if (!fired) { fired = true; assert.equal(cancelFromAnotherControl(f, task.task_id, 'cancelled').execution.status, 'CANCELLED'); }
      return original.call(this, result);
    };
    const result = await f.service.get(task.task_id);
    assert.equal(fired, true); assert.equal(result.task.execution.status, 'CANCELLED');
    assert.equal(result.task.execution.cancel_requested, true); assert.equal(result.status, null);
    assert.equal(new TestingStore(f.root).cache(task.task_id), null);
  } finally { TestingStore.prototype.saveResult = original; await host.stop(); f.close(); }
});

for (const pause of ['probe', 'submit'] as const) test(`Control crash during ${pause} preserves the original request and cancellation uncertainty`, async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let worker: ReturnType<typeof startWorker> | undefined;
  try {
    const candidate = await f.binary('candidate');
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' as const };
    const marker = path.join(f.root, 'owner-marker'), requestId = `crash-${pause}`;
    const probe = await f.options.runnerFactory!(f.machine).probe();
    worker = startWorker('owner', workerDescription(f, { input, marker, requestId, pause, probe }));
    await waitFor(() => worker!.output().includes('\n') && fs.existsSync(marker));
    const taskId = (JSON.parse(worker.output().trim()) as { task_id: string }).task_id;
    await stopWorker(worker.child);
    const disk = new TestingStore(f.root), before = disk.task(taskId);
    assert.equal(before.execution.submission_attempted, pause === 'submit');
    let reachable = false, cancels = 0, submissions = 0;
    const runner = { bindStoreIdentity() {}, async submitExperiment() { submissions++; throw new Error('unexpected re-submission'); },
      async getExperiment() { if (!reachable) throw new RunnerClientError(404, 'NOT_FOUND', 'unknown fixture job');
        return { experiment_id: taskId, status: cancels ? 'CANCELLED' : 'RUNNING', current_step: 'PERFORMANCE', cancel_requested: cancels > 0, failure: null }; },
      async cancelExperiment() { if (!reachable) throw new RunnerClientError(404, 'NOT_FOUND', 'unknown fixture job'); cancels++;
        return { experiment_id: taskId, status: 'RUNNING', cancel_requested: true }; },
      async getCommandExecutions() { return { experiment_id: taskId, command_executions: [] }; },
      async getMeasurements() { return { experiment_id: taskId, measurements: [] }; },
      async getExecutionOutput() { return { stdout: '', stderr: '', stdout_path: '', stderr_path: '', truncated: false }; },
    } as unknown as TestingRunner;
    const recovered = new TestingService({ ...f.options, runnerFactory: () => runner });
    const cancelled = await recovered.cancel(taskId);
    assert.equal(cancelled.task.execution.status, 'UNKNOWN'); assert.equal(cancelled.task.execution.cancel_requested, true);
    assert.equal((await recovered.start(input, { requestId })).task_id, taskId); assert.equal(submissions, 0);
    if (pause === 'submit') {
      reachable = true; const result = await recovered.get(taskId);
      assert.equal(result.task.execution.status, 'CANCELLED'); assert.equal(result.task.execution.cancel_requested, true);
      assert.equal(cancels, 1); assert.equal(submissions, 0);
    } else { assert.equal(cancels, 0); assert.equal(disk.task(taskId).execution.status, 'UNKNOWN'); }
  } finally { if (worker) await stopWorker(worker.child); await host.stop(); f.close(); }
});

test('SQLite lock contention fails closed and a killed owner leaves no stale lock', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let worker: ReturnType<typeof startWorker> | undefined;
  try {
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitTestingPreparation(f.service, task.task_id);
    const disk = new TestingStore(f.root), before = disk.task(task.task_id);
    worker = startWorker('hold-lock', workerDescription(f, {})); await waitFor(() => worker!.output().includes('LOCKED\n'));
    await assert.rejects(f.service.cancel(task.task_id), error => (error as { code?: string }).code === 'TESTING_STATE_LOCK_UNAVAILABLE');
    assert.deepEqual(disk.task(task.task_id), before);
    await stopWorker(worker.child);
    assert.equal((await f.service.cancel(task.task_id)).task.execution.cancel_requested, true);
  } finally { if (worker) await stopWorker(worker.child); await host.stop(); f.close(); }
});

test('unusable SQLite coordination storage preserves the task and reports a retryable error', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitTestingPreparation(f.service, task.task_id); const store = new TestingStore(f.root), before = store.task(task.task_id);
    const lock = path.join(store.root, 'task-write-lock.sqlite'), saved = lock + '.saved';
    fs.renameSync(lock, saved); fs.mkdirSync(lock);
    try {
      await assert.rejects(f.service.cancel(task.task_id), error => (error as { code?: string }).code === 'TESTING_STATE_LOCK_UNAVAILABLE');
      assert.deepEqual(store.task(task.task_id), before);
    } finally { fs.rmdirSync(lock); fs.renameSync(saved, lock); }
  } finally { f.close(); }
});

test('a lock failure while preparing is not recorded as a test failure', async () => {
  const f = createTestingFixture(), host = await controlHost(f.root); let release!: () => void;
  let worker: ReturnType<typeof startWorker> | undefined; const originalError = console.error;
  try {
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.phase === 'STAGING_SUBJECTS');
    worker = startWorker('hold-lock', workerDescription(f, {})); await waitFor(() => worker!.output().includes('LOCKED\n'));
    const diagnostics: string[] = []; console.error = (...args) => { diagnostics.push(args.join(' ')); };
    release(); await waitFor(() => diagnostics.length > 0);
    await stopWorker(worker.child);
    const after = f.service.list().find(row => row.task_id === task.task_id)!;
    assert.equal(after.execution.status, 'UNKNOWN'); assert.equal(after.execution.failure, null); assert.equal(f.plans.length, 0);
    assert.match(diagnostics[0], /无法保存测试/);
  } finally { console.error = originalError; release?.(); if (worker) await stopWorker(worker.child); await delay(20); await host.stop(); f.close(); }
});

test('a task file replacement failure is recorded as unknown rather than a test failure', async () => {
  const f = createTestingFixture(), originalRename = fs.renameSync; let release!: () => void, fired = false;
  try {
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const candidate = await f.binary('candidate');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    await waitFor(() => f.service.list()[0].execution.phase === 'STAGING_SUBJECTS');
    fs.renameSync = ((from, to) => {
      if (!fired && String(to).endsWith('task.json')) { fired = true; throw Object.assign(new Error('fixture storage failure'), { code: 'ENOSPC' }); }
      return originalRename(from, to);
    }) as typeof fs.renameSync;
    release(); await waitFor(() => f.service.list()[0].execution.status === 'UNKNOWN');
    const result = f.service.list().find(row => row.task_id === task.task_id)!;
    assert.equal(fired, true); assert.equal(result.execution.failure?.code, 'TESTING_STATE_UNCONFIRMED'); assert.equal(f.plans.length, 0);
  } finally { fs.renameSync = originalRename; release?.(); await delay(20); f.close(); }
});
