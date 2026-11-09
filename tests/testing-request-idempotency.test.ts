import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { executeTestingCommand } from '../src/client/testing-commands.js';
import type { CreateTestingTask, TestingTaskRecord } from '../src/contracts/testing.js';
import { TestingStore, testingRequestIdentity } from '../src/storage/testing-store.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('HTTP request lookup, replay and closure preserve exactly one task', async () => {
  const f = createTestingFixture(), web = await startWebFixture({ testingService: f.service });
  const api = new ApiClient(web.url, { token: web.token });
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const [first, second] = await Promise.all([api.testing.start(input, 'request-one'), api.testing.start(input, 'request-one')]);
    assert.equal(first.task.task_id, second.task.task_id);
    assert.equal(first.task.task_id, testingRequestIdentity('request-one').taskId);
    await waitTestingPreparation(f.service, first.task.task_id);
    assert.equal(f.plans.length, 1);
    assert.deepEqual(await api.testing.requestStatus('request-one'), { state: 'CREATED', task_id: first.task.task_id });
    assert.deepEqual(await api.testing.closeRequest('request-one'), { state: 'CREATED', task_id: first.task.task_id });
    assert.equal(f.service.list()[0].execution.cancel_requested, false);
    await assert.rejects(api.testing.start({ ...input, name: 'different' }, 'request-one'), error => error instanceof ApiClientError && error.code === 'TESTING_REQUEST_CONFLICT');
    assert.deepEqual(await api.testing.requestStatus('not-yet-created'), { state: 'NOT_FOUND' });
    assert.deepEqual(await api.testing.closeRequest('not-yet-created'), { state: 'CLOSED' });
    assert.deepEqual(await api.testing.requestStatus('not-yet-created'), { state: 'CLOSED' });
    await assert.rejects(api.testing.start(input, 'not-yet-created'), error => error instanceof ApiClientError && error.code === 'TESTING_REQUEST_CLOSED');
    assert.equal((await api.testing.list()).tasks.length, 1, 'closed fences are not tasks');
    await assert.rejects(api.testing.get(testingRequestIdentity('not-yet-created').taskId), error => error instanceof ApiClientError && error.status === 404);
    const noKeyA = await api.testing.start(input), noKeyB = await api.testing.start(input);
    assert.notEqual(noKeyA.task.task_id, noKeyB.task.task_id, 'unkeyed compatibility retains independent requests');
    await waitTestingPreparation(f.service, noKeyA.task.task_id); await waitTestingPreparation(f.service, noKeyB.task.task_id);
  } finally { await web.close(); f.close(); }
});

test('legacy request lookup retains a unique record and refuses to choose among duplicates', async () => {
  const f = createTestingFixture(), web = await startWebFixture({ testingService: f.service });
  const api = new ApiClient(web.url, { token: web.token }), store = new TestingStore(f.root);
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const source = (await api.testing.start(input)).task; await waitTestingPreparation(f.service, source.task_id);
    const one: TestingTaskRecord = { ...structuredClone(store.task(source.task_id)), task_id: `testing:${randomUUID()}`, request_id: 'legacy-key' };
    store.saveTask(one);
    assert.deepEqual(await api.testing.requestStatus('legacy-key'), { state: 'CREATED', task_id: one.task_id });
    assert.equal((await api.testing.start(input, 'legacy-key')).task.task_id, one.task_id);
    const two: TestingTaskRecord = { ...structuredClone(one), task_id: `testing:${randomUUID()}` }; store.saveTask(two);
    const before = [store.task(one.task_id), store.task(two.task_id)];
    for (const operation of [() => api.testing.requestStatus('legacy-key'), () => api.testing.closeRequest('legacy-key'), () => api.testing.start(input, 'legacy-key')]) {
      await assert.rejects(operation(), error => error instanceof ApiClientError && error.code === 'TESTING_REQUEST_AMBIGUOUS');
    }
    assert.deepEqual([store.task(one.task_id), store.task(two.task_id)], before);
  } finally { await web.close(); f.close(); }
});

test('a lost local publish acknowledgement is recovered by the same key without starting twice', async () => {
  const f = createTestingFixture();
  const store = new TestingStore(f.root), originalLink = fs.linkSync;
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    fs.linkSync = ((source, destination) => { originalLink(source, destination); throw new Error('injected lost acknowledgement'); }) as typeof fs.linkSync;
    try { await assert.rejects(f.service.start(input, { requestId: 'lost-commit' }), /无法确认测试请求是否原子保存/); }
    finally { fs.linkSync = originalLink; }
    const status = f.service.requestStatus('lost-commit'); assert.equal(status.state, 'CREATED');
    const replay = await f.service.start(input, { requestId: 'lost-commit' });
    assert.equal(replay.task_id, testingRequestIdentity('lost-commit').taskId); assert.equal(replay.execution.status, 'UNKNOWN');
    assert.equal(f.plans.length, 0, 'a later request does not start work owned by an interrupted creator');
    assert.equal(f.service.closeRequest('lost-commit').state, 'CREATED');
    assert.equal(store.tasks().length, 1);
  } finally { fs.linkSync = originalLink; f.close(); }
});

test('a filesystem without hard links cannot silently start a keyed task', async () => {
  const f = createTestingFixture(), originalLink = fs.linkSync;
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    fs.linkSync = (() => { throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' }); }) as typeof fs.linkSync;
    await assert.rejects(f.service.start(input, { requestId: 'no-hard-links' }), error => (error as { code?: string }).code === 'TESTING_ATOMIC_STORAGE_UNAVAILABLE');
    assert.throws(() => f.service.closeRequest('no-hard-links'), error => (error as { code?: string }).code === 'TESTING_ATOMIC_STORAGE_UNAVAILABLE');
    assert.deepEqual(f.service.requestStatus('no-hard-links'), { state: 'NOT_FOUND' });
    assert.equal(f.service.list().length, 0); assert.equal(f.plans.length, 0);
  } finally { fs.linkSync = originalLink; f.close(); }
});

test('CLI rejects empty keys and can inspect, close and reuse an explicit key', async () => {
  const f = createTestingFixture(), web = await startWebFixture({ testingService: f.service });
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const filename = path.join(f.root, 'request.json'); fs.writeFileSync(filename, JSON.stringify(input));
    const options = { baseUrl: web.url, token: web.token };
    await assert.rejects(executeTestingCommand(['start', '--file', filename, '--request-id', ''], options), /1 到 160/);
    assert.equal(f.service.list().length, 0);
    const first = await executeTestingCommand(['start', '--file', filename, '--request-id', 'cli-request'], options);
    const replay = await executeTestingCommand(['start', '--file', filename, '--request-id', 'cli-request'], options);
    const id = (first.value as { task: TestingTaskRecord }).task.task_id;
    assert.equal((replay.value as { task: TestingTaskRecord }).task.task_id, id);
    assert.deepEqual((await executeTestingCommand(['request', '--request-id', 'cli-request'], options)).value, { state: 'CREATED', task_id: id });
    assert.deepEqual((await executeTestingCommand(['close-request', '--request-id', 'new-cli-request'], options)).value, { state: 'CLOSED' });
    await waitTestingPreparation(f.service, id);
  } finally { await web.close(); f.close(); }
});

type WorkerResult = { ok: boolean; code?: string; result?: { task_id?: string; state?: string } };
async function concurrentWorkers(root: string, descriptions: object[]): Promise<WorkerResult[]> {
  const gate = path.join(root, `gate-${randomUUID()}`);
  const workers = descriptions.map((description, index) => {
    const filename = path.join(root, `worker-${randomUUID()}-${index}.json`); fs.writeFileSync(filename, JSON.stringify(description));
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/testing-request-worker.ts', filename, gate], { windowsHide: true });
    let output = '', errors = '', becameReady = false; let ready!: () => void, failReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
    child.stdout.on('data', chunk => { output += chunk.toString(); if (!becameReady && output.includes('READY\n')) { becameReady = true; ready(); } });
    child.stderr.on('data', chunk => { errors += chunk.toString(); });
    const done = new Promise<WorkerResult>((resolve, reject) => {
      child.once('error', error => { if (!becameReady) failReady(error); reject(error); });
      child.once('exit', code => {
        if (!becameReady) failReady(new Error(`worker exited before start gate: ${errors}`));
        if (code !== 0) { reject(new Error(`worker exited ${code}: ${errors}`)); return; }
        const result = output.split('\n').find(line => line.startsWith('{'));
        if (!result) { reject(new Error(`missing worker result: ${output} ${errors}`)); return; }
        resolve(JSON.parse(result) as WorkerResult);
      });
    });
    return { started, done };
  });
  await Promise.all(workers.map(worker => worker.started)); fs.writeFileSync(gate, 'release');
  return Promise.all(workers.map(worker => worker.done));
}

test('two independent processes cannot both start one keyed task and reject changed inputs', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const log = path.join(f.root, 'probes.log');
    const description = { root: f.root, machine: f.machine, input, log, action: 'start', key: 'same-key' };
    const results = await concurrentWorkers(f.root, [description, description]);
    assert.ok(results.every(item => item.ok));
    assert.equal(results[0].result?.task_id, results[1].result?.task_id);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
    const different = await concurrentWorkers(f.root, [{ ...description, key: 'different-input' },
      { ...description, key: 'different-input', input: { ...input, name: 'changed' } }]);
    assert.equal(different.filter(item => item.ok).length, 1);
    assert.equal(different.find(item => !item.ok)?.code, 'TESTING_REQUEST_CONFLICT');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => line === 'different-input').length, 1);
  } finally { f.close(); }
});

test('different Control databases racing for one request cannot claim each other’s task', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const log = path.join(f.root, 'identity-probes.log'), dataRootId = randomUUID();
    const identityA = { database_id: randomUUID(), data_root_id: dataRootId }, identityB = { database_id: randomUUID(), data_root_id: dataRootId };
    const common = { root: f.root, machine: f.machine, input, log, action: 'start', key: 'same-key-different-controls' };
    const results = await concurrentWorkers(f.root, [{ ...common, controlIdentity: identityA }, { ...common, controlIdentity: identityB }]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.find(result => !result.ok)?.code, 'TESTING_REQUEST_CONTROL_MISMATCH');
    const winner = results.findIndex(result => result.ok), taskId = results[winner].result?.task_id;
    assert.ok(taskId); assert.deepEqual(new TestingStore(f.root).task(taskId).request_control_identity, winner === 0 ? identityA : identityB);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1);
  } finally { f.close(); }
});

test('two processes racing creation and closure leave either one task or one closed fence', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate');
    const input: CreateTestingTask = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' };
    const log = path.join(f.root, 'probes.log'), store = new TestingStore(f.root);
    for (let index = 0; index < 3; index++) {
      const key = `close-race-${index}`, common = { root: f.root, machine: f.machine, input, log, key };
      const [started, closed] = await concurrentWorkers(f.root, [{ ...common, action: 'start' }, { ...common, action: 'close' }]);
      const decision = f.service.requestStatus(key);
      if (decision.state === 'CLOSED') {
        assert.equal(closed.result?.state, 'CLOSED'); assert.equal(started.code, 'TESTING_REQUEST_CLOSED');
        assert.equal(store.tasks().filter(task => task.request_id === key).length, 0);
      } else {
        assert.equal(decision.state, 'CREATED'); assert.equal(started.result?.task_id, decision.task_id);
        assert.deepEqual(closed.result, decision); assert.equal(store.tasks().filter(task => task.request_id === key).length, 1);
      }
      const probes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(line => line === key) : [];
      assert.equal(probes.length, decision.state === 'CREATED' ? 1 : 0);
    }
  } finally { f.close(); }
});
