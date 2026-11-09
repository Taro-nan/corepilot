import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { CONTROL_GUARD_HEADER } from '../src/contracts/control-identity.js';
import { TaskHost } from '../src/core/task-host.js';
import { createHttpServer } from '../src/http/server.js';
import { CONTROL_DATA_IDENTITY_FILE, ControlIdentityGuard } from '../src/storage/control-identity.js';
import { startWebFixture } from './web-fixture.js';

test('guarded intake survives a response loss and refuses a proxy switched to another database or data directory', async () => {
  const a = await startWebFixture(), b = await startWebFixture();
  const alternateRoot = path.join(a.root, 'alternate-data');
  const sameDatabaseOtherRoot = ControlIdentityGuard.initialize(a.store, alternateRoot, { initializeNewDataDir: true });
  const extra = createHttpServer(new TaskHost(a.store), { host: '127.0.0.1', port: 0, workflowService: a.service,
    controlIdentity: sameDatabaseOtherRoot, accessToken: a.token });
  await once(extra, 'listening');
  const extraAddress = extra.address(); assert.ok(extraAddress && typeof extraAddress === 'object');
  const alternateUrl = `http://127.0.0.1:${extraAddress.port}`;
  let destination = a.url, loseResponse = false, stripPath = false;
  const proxy = http.createServer((req, res) => {
    const target = new URL(destination);
    let requestPath = req.url ?? '/';
    if (stripPath) requestPath = requestPath.replace(/^\/v1\/control-identities\/[^/]+\/[^/]+\//, '/v1/');
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: requestPath,
      headers: { ...req.headers, host: target.host } }, response => {
      if (loseResponse && req.method === 'POST' && requestPath.endsWith('/workflows')) {
        response.resume(); response.once('end', () => res.destroy()); return;
      }
      res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress === 'object');
  const url = `http://127.0.0.1:${proxyAddress.port}`, api = new ApiClient(url, { token: a.token });
  try {
    assert.equal((await fetch(`${url}/v1/control-identity`)).status, 401);
    const original = await api.getControlIdentity();
    assert.deepEqual(original, a.controlIdentity.current());
    const input = { verification_mode: 'source_only', function_name: 'kernel', entry_file: null, config_path: a.configPath,
      repository_root: a.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } };
    destination = b.url;
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'before-post', controlIdentity: original }),
      (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_DATABASE_MISMATCH');
    assert.equal(a.service.list().length, 0); assert.equal(b.service.list().length, 0);
    destination = a.url; loseResponse = true;
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'response-lost', controlIdentity: original }));
    loseResponse = false;
    assert.equal(a.service.list().length, 1);
    const originalId = a.service.list()[0].workflow_id;
    destination = b.url;
    const wrongDb = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_DATABASE_MISMATCH';
    await assert.rejects(api.getOptimizationIntake('response-lost', original), wrongDb);
    await assert.rejects(api.closeOptimizationIntake('response-lost', original), wrongDb);
    assert.deepEqual(b.store.getOptimizationIntakeStatus('response-lost'), { status: 'NOT_FOUND' });
    destination = alternateUrl;
    const wrongDirectory = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_DATA_ROOT_MISMATCH';
    await assert.rejects(api.getOptimizationIntake('response-lost', original), wrongDirectory);
    await assert.rejects(api.closeOptimizationIntake('response-lost', original), wrongDirectory);
    destination = a.url; stripPath = true;
    const missingGuard = (error: ApiClientError) => error.status === 409 && error.code === 'CONTROL_GUARD_UNAVAILABLE';
    await assert.rejects(api.getOptimizationIntake('response-lost', original), missingGuard);
    await assert.rejects(api.closeOptimizationIntake('response-lost', original), missingGuard);
    await assert.rejects(api.submitOptimizationWorkflow(input, { requestId: 'stripped', controlIdentity: original }), missingGuard);
    assert.deepEqual(a.store.getOptimizationIntakeStatus('stripped'), { status: 'NOT_FOUND' });
    stripPath = false;
    const guardedWithoutHeader = await fetch(`${url}/v1/control-identities/${original.database_id}/${original.data_root_id}/workflow-requests/response-lost`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(guardedWithoutHeader.status, 409);
    assert.equal((await guardedWithoutHeader.json()).error.code, 'CONTROL_GUARD_UNAVAILABLE');
    const marker = path.join(a.dataDir, CONTROL_DATA_IDENTITY_FILE), saved = fs.readFileSync(marker);
    fs.unlinkSync(marker);
    try {
      await assert.rejects(api.getOptimizationIntake('response-lost', original),
        (error: ApiClientError) => error.status === 503 && error.code === 'CONTROL_IDENTITY_UNAVAILABLE');
      assert.equal((await fetch(`${url}/v1/workflows`, { headers: { authorization: `Bearer ${a.token}` } })).status, 200);
    } finally { fs.writeFileSync(marker, saved); }
    assert.deepEqual(await api.getOptimizationIntake('response-lost', original), { status: 'CREATED', workflow_id: originalId });
    assert.deepEqual(await api.closeOptimizationIntake('response-lost', original), { status: 'CREATED', workflow_id: originalId });
    assert.deepEqual(await api.getOptimizationIntake('response-lost'), { status: 'CREATED', workflow_id: originalId }, 'legacy API remains available');
    assert.equal(a.modelRequests.inference, 0); assert.equal(b.modelRequests.inference, 0);
    assert.equal(CONTROL_GUARD_HEADER, 'x-corepilot-control-guard');
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => extra.close(() => resolve()));
    await a.close(); await b.close();
  }
});

test('a slow guarded POST rechecks identity after its body before creating a task', async () => {
  const f = await startWebFixture();
  const identity = f.controlIdentity.current();
  const marker = path.join(f.dataDir, CONTROL_DATA_IDENTITY_FILE), saved = fs.readFileSync(marker);
  const input = { verification_mode: 'source_only', function_name: 'kernel', entry_file: null, config_path: f.configPath,
    repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } };
  try {
    for (const mode of ['missing', 'replaced'] as const) {
      let signal!: () => void;
      const entered = new Promise<void>(resolve => { signal = resolve; });
      const current = f.controlIdentity.current.bind(f.controlIdentity);
      let checks = 0;
      f.controlIdentity.current = () => { const value = current(); if (++checks === 1) signal(); return value; };
      const body = Buffer.from(JSON.stringify(input)), midpoint = Math.floor(body.length / 2);
      let responseResolve!: (response: { status: number; body: string }) => void, responseReject!: (error: Error) => void;
      const response = new Promise<{ status: number; body: string }>((resolve, reject) => { responseResolve = resolve; responseReject = reject; });
      const request = http.request(`${f.url}/v1/control-identities/${identity.database_id}/${identity.data_root_id}/workflows`, {
        method: 'POST', headers: { authorization: `Bearer ${f.token}`, [CONTROL_GUARD_HEADER]: '1', 'idempotency-key': `slow-${mode}`,
          'content-type': 'application/json', 'content-length': String(body.length) },
      }, reply => {
        let text = ''; reply.on('data', chunk => { text += String(chunk); });
        reply.on('end', () => responseResolve({ status: reply.statusCode ?? 0, body: text }));
      });
      request.on('error', responseReject);
      request.write(body.subarray(0, midpoint));
      try {
        await entered;
        if (mode === 'missing') fs.unlinkSync(marker);
        else fs.writeFileSync(marker, JSON.stringify({ version: 1, data_root_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
        request.end(body.subarray(midpoint));
        const result = await response;
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.body).error.code, 'CONTROL_IDENTITY_UNAVAILABLE');
        assert.deepEqual(f.store.getOptimizationIntakeStatus(`slow-${mode}`), { status: 'NOT_FOUND' });
        assert.equal(f.service.list().length, 0);
      } finally { f.controlIdentity.current = current; fs.writeFileSync(marker, saved); request.destroy(); }
    }
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
