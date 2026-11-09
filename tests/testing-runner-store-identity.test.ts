import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { RunnerClient } from '../src/client/runner-client.js';
import { ApiClient } from '../src/client/api-client.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { TestingStore } from '../src/storage/testing-store.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('independent testing keeps the original job unknown across Runner store replacement and recovers it', async () => {
  const f = createTestingFixture();
  const runnerRoot = path.join(f.root, 'runner-workspace'); fs.mkdirSync(runnerRoot);
  const token = 'independent-runner-fixture';
  const a = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, runnerId: 'same-label', dbPath: path.join(f.root, 'a.sqlite'),
    workspaceRoot: runnerRoot, resourceEnforcement: 'REQUIRED' });
  const b = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, runnerId: 'same-label', dbPath: path.join(f.root, 'b.sqlite'),
    workspaceRoot: runnerRoot, resourceEnforcement: 'REQUIRED' });
  let target = a.url, posts = 0;
  const proxy = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const upstream = http.request(new URL(url, target), { method: req.method, headers: req.headers }, response => {
      if (req.method === 'POST' && url.endsWith('/experiments') && response.statusCode === 202) {
        posts++; response.resume(); res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"code":"LOST_RESPONSE"}}'); return;
      }
      res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}`;
  f.machine.runner.endpoint = endpoint; f.machine.runner.token = token;
  f.machine.target.workspace_root = runnerRoot.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/');
  f.options.runnerFactory = () => new RunnerClient({ baseUrl: endpoint, token });
  const machine = await new RunnerClient({ baseUrl: a.url, token }).probe();
  const stageBinary = f.options.stageBinary!;
  f.options.stageBinary = async input => ({ ...await stageBinary(input), machine_identity_sha256: machine.machine.machine_identity_sha256 });
  const web = await startWebFixture({ testingService: f.service });
  const api = new ApiClient(web.url, { token: web.token });
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    const { task: created } = await api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, baseline, mode: 'both' });
    const submitted = await waitTestingPreparation(f.service, created.task_id);
    assert.equal(submitted.execution.status, 'UNKNOWN', JSON.stringify(submitted.execution)); assert.equal(posts, 1);
    assert.equal(submitted.machine.runner_store_instance_id, a.storeInstanceId);
    target = b.url;
    const wrong = await api.testing.get(created.task_id);
    assert.equal(wrong.task.execution.status, 'UNKNOWN'); assert.equal(wrong.task.execution.failure?.code, 'RUNNER_STORE_MISMATCH');
    assert.match(wrong.task.execution.message!, /数据库身份与原任务不一致/);
    const cancelled = await api.testing.cancel(created.task_id);
    assert.equal(cancelled.task.execution.status, 'UNKNOWN'); assert.equal(cancelled.task.execution.cancel_requested, true);
    await assert.rejects(new RunnerClient({ baseUrl: b.url, token }).getExperiment(created.task_id), /not found/i);
    assert.equal(posts, 1, 'recovery and cancellation do not resubmit to the replacement');
    target = a.url;
    const recovered = await api.testing.get(created.task_id);
    assert.equal(recovered.status?.experiment_id, created.task_id);
    assert.equal(posts, 1);
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await a.close(); await b.close(); await web.close(); f.close();
  }
});

test('historical tests without a store identity keep local facts and never query or cancel an unverified Runner', async () => {
  const f = createTestingFixture();
  const web = await startWebFixture({ testingService: f.service }); const api = new ApiClient(web.url, { token: web.token });
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    const { task: created } = await api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, baseline, mode: 'both' });
    const submitted = await waitTestingPreparation(f.service, created.task_id);
    assert.ok(submitted.machine.runner_store_instance_id);
    const disk = new TestingStore(f.root);
    disk.updateTask(created.task_id, record => { delete record.machine.runner_store_instance_id; });
    const calls = f.getCalls;
    const details = await api.testing.get(created.task_id);
    assert.equal(details.task.execution.status, 'UNKNOWN');
    assert.equal(details.task.execution.failure?.code, 'TESTING_RUNNER_IDENTITY_UNKNOWN');
    assert.match(details.task.execution.message!, /历史测试没有固定/);
    assert.equal(f.getCalls, calls);
    const cancelled = await api.testing.cancel(created.task_id);
    assert.equal(cancelled.task.execution.status, 'UNKNOWN'); assert.equal(cancelled.task.execution.cancel_requested, true);
    assert.equal(f.getCalls, calls); assert.equal(disk.task(created.task_id).machine.runner_store_instance_id, undefined);

    const { task: completed } = await api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, baseline, mode: 'both' });
    await waitTestingPreparation(f.service, completed.task_id); f.complete(completed);
    assert.equal((await api.testing.get(completed.task_id)).task.execution.status, 'SUCCEEDED');
    disk.updateTask(completed.task_id, record => { delete record.machine.runner_store_instance_id; });
    const oldCalls = f.getCalls;
    assert.equal((await api.testing.get(completed.task_id)).task.execution.status, 'SUCCEEDED');
    assert.equal(f.getCalls, oldCalls, 'completed historical cached results remain readable locally');
    fs.rmSync(path.join(disk.taskRoot(completed.task_id), 'result.json'));
    assert.equal((await api.testing.get(completed.task_id)).task.execution.status, 'SUCCEEDED');
    assert.equal(f.getCalls, oldCalls, 'a missing old cache does not overwrite a confirmed terminal state');
  } finally { await web.close(); f.close(); }
});

for (const missing of ['store_identity_guard', 'artifact_path_check'] as const) test(`a new independent test requires ${missing} before submission`, async () => {
  const f = createTestingFixture();
  const original = f.options.runnerFactory!(f.machine);
  f.options.runnerFactory = () => ({ ...original, async probe(signal) {
    const value = await original.probe(signal);
    if (missing === 'store_identity_guard') delete value.health.store_instance_id;
    if (value.health.capabilities) delete value.health.capabilities[missing];
    return value;
  } });
  const web = await startWebFixture({ testingService: f.service }); const api = new ApiClient(web.url, { token: web.token });
  try {
    const candidate = await f.binary('candidate');
    const { task: created } = await api.testing.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, candidate, mode: 'correctness' });
    const result = await waitTestingPreparation(f.service, created.task_id);
    assert.equal(result.execution.status, 'FAILED');
    assert.match(result.execution.failure?.message ?? '', /升级 Runner/);
    assert.equal(f.plans.length, 0);
  } finally { await web.close(); f.close(); }
});
