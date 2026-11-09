import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { TestingService } from '../src/application/testing-service.js';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { CONTROL_GUARD_HEADER } from '../src/contracts/control-identity.js';
import { createHttpServer } from '../src/http/server.js';
import { CONTROL_DATA_IDENTITY_FILE, ControlIdentityGuard } from '../src/storage/control-identity.js';
import { TestingStore } from '../src/storage/testing-store.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('guarded testing requests retain their Control identity across lost responses and a shared data directory', async () => {
  const testing = createTestingFixture(), a = await startWebFixture(), b = await startWebFixture();
  const guardA = ControlIdentityGuard.initialize(a.store, testing.root, { initializeNewDataDir: true });
  const guardB = ControlIdentityGuard.initialize(b.store, testing.root, { initializeNewDataDir: true });
  const secondService = new TestingService(testing.options);
  const serverA = createHttpServer(a.host, { host: '127.0.0.1', port: 0, workflowService: a.service, testingService: testing.service, controlIdentity: guardA, accessToken: a.token });
  const serverB = createHttpServer(b.host, { host: '127.0.0.1', port: 0, workflowService: b.service, testingService: secondService, controlIdentity: guardB, accessToken: a.token });
  await Promise.all([once(serverA, 'listening'), once(serverB, 'listening')]);
  const addrA = serverA.address(), addrB = serverB.address(); assert.ok(addrA && typeof addrA === 'object' && addrB && typeof addrB === 'object');
  const urls = [`http://127.0.0.1:${addrA.port}`, `http://127.0.0.1:${addrB.port}`];
  let destination = 0, dropResponse = false, stripPath = false;
  const proxy = http.createServer((request, response) => {
    const target = new URL(urls[destination]);
    const requestPath = stripPath ? (request.url ?? '/').replace(/^\/v1\/control-identities\/[^/]+\/[^/]+\//, '/v1/') : request.url ?? '/';
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: request.method, path: requestPath,
      headers: { ...request.headers, host: target.host } }, reply => {
      if (dropResponse && request.method === 'POST' && requestPath.endsWith('/testing-tasks')) { reply.resume(); reply.once('end', () => response.destroy()); return; }
      response.writeHead(reply.statusCode ?? 500, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const addr = proxy.address(); assert.ok(addr && typeof addr === 'object');
  const api = new ApiClient(`http://127.0.0.1:${addr.port}`, { token: a.token });
  try {
    const identityA = await api.getControlIdentity(), identityB = guardB.current();
    assert.equal(identityA.data_root_id, identityB.data_root_id); assert.notEqual(identityA.database_id, identityB.database_id);
    const candidate = await testing.binary('candidate'), baseline = await testing.binary('baseline');
    const input = { machine_id: testing.machine.identity.machine_id, plan: testingPlanRef, mode: 'performance' as const, candidate, baseline };
    dropResponse = true;
    await assert.rejects(api.testing.start(input, 'lost-testing-response', identityA));
    dropResponse = false;
    const saved = testing.service.list()[0]; assert.ok(saved);
    await waitTestingPreparation(testing.service, saved.task_id);
    assert.deepEqual(saved.request_control_identity, identityA);
    assert.deepEqual(await api.testing.requestStatus('lost-testing-response', identityA), { state: 'CREATED', task_id: saved.task_id });
    assert.equal((await api.testing.get(saved.task_id, identityA)).task.task_id, saved.task_id);
    destination = 1;
    const wrongDatabase = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_DATABASE_MISMATCH';
    await assert.rejects(api.testing.requestStatus('lost-testing-response', identityA), wrongDatabase);
    await assert.rejects(api.testing.closeRequest('lost-testing-response', identityA), wrongDatabase);
    await assert.rejects(api.testing.get(saved.task_id, identityA), wrongDatabase);
    const otherDirectory = new ApiClient(a.url, { token: a.token });
    const wrongDirectory = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_DATA_ROOT_MISMATCH';
    await assert.rejects(otherDirectory.testing.requestStatus('lost-testing-response', identityA), wrongDirectory);
    await assert.rejects(otherDirectory.testing.closeRequest('lost-testing-response', identityA), wrongDirectory);
    await assert.rejects(otherDirectory.testing.start(input, 'other-directory', identityA), wrongDirectory);
    const wrongOwner = (error: ApiClientError) => error.status === 409 && error.code === 'TESTING_REQUEST_CONTROL_MISMATCH';
    await assert.rejects(api.testing.requestStatus('lost-testing-response', identityB), wrongOwner);
    await assert.rejects(api.testing.closeRequest('lost-testing-response', identityB), wrongOwner);
    await assert.rejects(api.testing.start(input, 'lost-testing-response', identityB), wrongOwner);
    await assert.rejects(api.testing.get(saved.task_id, identityB), wrongOwner);
    assert.equal(testing.service.list().length, 1); assert.equal(testing.plans.length, 1);
    const reads = testing.getCalls;
    assert.match((await api.testing.list()).identity_notice ?? '', /其他控制端/);
    await assert.rejects(api.testing.get(saved.task_id), wrongOwner);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(testing.getCalls, reads, 'foreign task is not reconciled by a list or ordinary detail read');
    const cancelled = await api.testing.cancel(saved.task_id);
    assert.equal(cancelled.task.execution.cancel_requested, true, 'manual cancellation still uses the selected Control and fixed Runner identity');
    assert.deepEqual(await api.testing.closeRequest('empty-close', identityB), { state: 'CLOSED' });
    destination = 0;
    await assert.rejects(api.testing.requestStatus('empty-close', identityA), wrongOwner);
    await assert.rejects(api.testing.start(input, 'empty-close', identityA), wrongOwner);
    stripPath = true;
    const missingGuard = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_GUARD_UNAVAILABLE';
    await assert.rejects(api.testing.requestStatus('lost-testing-response', identityA), missingGuard);
    await assert.rejects(api.testing.closeRequest('lost-testing-response', identityA), missingGuard);
    await assert.rejects(api.testing.get(saved.task_id, identityA), missingGuard);
    await assert.rejects(api.testing.start(input, 'stripped', identityA), missingGuard);
    stripPath = false;
    const noHeader = await fetch(`${urls[0]}/v1/control-identities/${identityA.database_id}/${identityA.data_root_id}/testing-requests`,
      { headers: { authorization: `Bearer ${a.token}`, 'idempotency-key': 'lost-testing-response' } });
    assert.equal(noHeader.status, 409); assert.equal((await noHeader.json()).error.code, 'CONTROL_GUARD_UNAVAILABLE');
    const marker = path.join(testing.root, CONTROL_DATA_IDENTITY_FILE), bytes = fs.readFileSync(marker); fs.unlinkSync(marker);
    try {
      const unavailable = (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_IDENTITY_UNAVAILABLE';
      await assert.rejects(api.testing.requestStatus('lost-testing-response', identityA), unavailable);
      await assert.rejects(api.testing.get(saved.task_id), unavailable);
      assert.match((await api.testing.list()).identity_notice ?? '', /身份暂不可核对/);
    }
    finally { fs.writeFileSync(marker, bytes); }
    // Existing unguarded API remains available to older CLI clients.
    assert.deepEqual(await api.testing.requestStatus('lost-testing-response'), { state: 'CREATED', task_id: saved.task_id });
    const legacy = await api.testing.start(input, 'legacy-no-control');
    await waitTestingPreparation(testing.service, legacy.task.task_id);
    assert.equal((await api.testing.get(legacy.task.task_id)).task.task_id, legacy.task.task_id);
    await assert.rejects(api.testing.requestStatus('legacy-no-control', identityA),
      (error: ApiClientError) => error.status === 409 && error.code === 'TESTING_REQUEST_CONTROL_UNKNOWN');
    await assert.rejects(api.testing.get(legacy.task.task_id, identityA),
      (error: ApiClientError) => error.status === 409 && error.code === 'TESTING_REQUEST_CONTROL_UNKNOWN');
    new TestingStore(testing.root).updateTask(legacy.task.task_id, task => { (task as unknown as { request_control_identity: unknown }).request_control_identity = 'damaged'; });
    const calls = testing.getCalls;
    await assert.rejects(api.testing.get(legacy.task.task_id), (error: ApiClientError) => error.status === 409 && error.code === 'TESTING_REQUEST_CONTROL_UNKNOWN');
    assert.equal(testing.getCalls, calls);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await Promise.all([new Promise<void>(resolve => serverA.close(() => resolve())), new Promise<void>(resolve => serverB.close(() => resolve()))]);
    await a.close(); await b.close(); testing.close();
  }
});

test('guarded testing writes recheck Control identity after receiving a slow body', async () => {
  const testing = createTestingFixture(), f = await startWebFixture({ testingService: testing.service });
  const identity = f.controlIdentity.current(), marker = path.join(f.dataDir, CONTROL_DATA_IDENTITY_FILE), bytes = fs.readFileSync(marker);
  try {
    for (const action of ['testing-tasks', 'testing-requests/close'] as const) {
      const body = Buffer.from(action === 'testing-tasks' ? JSON.stringify({ machine_id: 'unused' }) : '{}');
      const midpoint = Math.floor(body.length / 2), key = `slow-${action}`;
      const current = f.controlIdentity.current.bind(f.controlIdentity);
      let entered!: () => void;
      const initialCheck = new Promise<void>(resolve => { entered = resolve; });
      f.controlIdentity.current = () => { const result = current(); entered(); return result; };
      let resolveResponse!: (value: { status: number; body: string }) => void, rejectResponse!: (error: Error) => void;
      const result = new Promise<{ status: number; body: string }>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
      const request = http.request(`${f.url}/v1/control-identities/${identity.database_id}/${identity.data_root_id}/${action}`, { method: 'POST',
        headers: { authorization: `Bearer ${f.token}`, [CONTROL_GUARD_HEADER]: '1', 'idempotency-key': key, 'content-type': 'application/json', 'content-length': String(body.length) } }, reply => {
        let content = ''; reply.on('data', chunk => { content += String(chunk); }); reply.on('end', () => resolveResponse({ status: reply.statusCode ?? 0, body: content }));
      });
      request.on('error', rejectResponse); request.write(body.subarray(0, midpoint));
      try {
        await initialCheck; fs.unlinkSync(marker); request.end(body.subarray(midpoint));
        const response = await result; assert.equal(response.status, 503); assert.equal(JSON.parse(response.body).error.code, 'CONTROL_IDENTITY_UNAVAILABLE');
        assert.deepEqual(testing.service.requestStatus(key), { state: 'NOT_FOUND' });
      } finally { f.controlIdentity.current = current; fs.writeFileSync(marker, bytes); request.destroy(); }
    }
    assert.equal(testing.service.list().length, 0); assert.equal(testing.plans.length, 0);
  } finally { await f.close(); testing.close(); }
});
