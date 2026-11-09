import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { RunnerClient, RunnerClientError } from '../src/client/runner-client.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION } from '../src/contracts/optimization-domain.js';
import type { ExperimentExecutionPlan } from '../src/contracts/runner-rpc.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { SqliteRunnerStore } from '../src/runner/sqlite-runner-store.js';

function resolveInChild(dbPath: string): Promise<string> {
  const moduleUrl = pathToFileURL(path.resolve('src/runner/sqlite-runner-store.ts')).href;
  const code = `import { SqliteRunnerStore } from ${JSON.stringify(moduleUrl)}; const s = new SqliteRunnerStore(process.argv[1]); s.init(); process.stdout.write(s.resolveStoreInstanceId()); s.close();`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, dbPath], { windowsHide: true });
    let out = '', err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(out) : reject(new Error(err)));
  });
}

test('store identity survives restart, is initialized once by competing processes, and follows database copies', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-store-identity-'));
  try {
    const originalPath = path.join(root, 'old.sqlite');
    const old = new SqliteRunnerStore(originalPath); old.init(); old.resolveRunnerIdentity('same-user-label'); old.close();
    const [first, concurrent] = await Promise.all([resolveInChild(originalPath), resolveInChild(originalPath)]);
    assert.match(first, /^[0-9a-f-]{36}$/); assert.equal(first, concurrent);
    const reopened = new SqliteRunnerStore(originalPath); reopened.init();
    assert.equal(reopened.resolveStoreInstanceId(), first); reopened.close();
    const copiedPath = path.join(root, 'copy.sqlite'); fs.copyFileSync(originalPath, copiedPath);
    const copied = new SqliteRunnerStore(copiedPath); copied.init();
    assert.equal(copied.resolveStoreInstanceId(), first, 'a database copy carries the same identity'); copied.close();
    const fresh = new SqliteRunnerStore(path.join(root, 'new.sqlite')); fresh.init();
    assert.equal(fresh.resolveRunnerIdentity('same-user-label'), 'same-user-label');
    assert.notEqual(fresh.resolveStoreInstanceId(), first, 'a configurable runner label cannot identify the database'); fresh.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function plan(root: string, id: string): ExperimentExecutionPlan {
  const now = new Date().toISOString();
  return { experiment: { schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION, experiment_id: id, task_id: 'task:guard', candidate_id: 'candidate:guard',
    type: 'DEVELOPMENT_FEEDBACK', status: 'PENDING', validity: 'UNKNOWN', failure_category: null,
    evaluator: { id: 'fixture' }, baseline: { id: 'fixture' }, declared_context: {}, observed_context: null, evaluation: null,
    started_at: null, ended_at: null, created_at: now, updated_at: now },
    steps: [{ step: 'BUILD', command: { executable: process.execPath, args: ['-e', 'setTimeout(()=>{}, 20000)'], cwd: root, environment: {}, timeout_ms: 30000 } }] };
}

test('bound RPC operations refuse a different store at the same endpoint, and recover against the original', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-store-route-'));
  const token = 'fixture-token'; const runnerRoot = path.join(root, 'workspace'); fs.mkdirSync(runnerRoot);
  const a = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, runnerId: 'same-label', dbPath: path.join(root, 'a.sqlite'), workspaceRoot: runnerRoot });
  const b = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, runnerId: 'same-label', dbPath: path.join(root, 'b.sqlite'), workspaceRoot: runnerRoot });
  let target = a.url;
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(new URL(req.url ?? '/', target), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); }); req.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); assert.ok(address && typeof address === 'object');
  const client = new RunnerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token });
  const archive = path.join(root, 'upload.tar.gz'); fs.writeFileSync(archive, 'fixture');
  try {
    const probe = await client.probe(); assert.equal(probe.health.runner_id, 'same-label');
    assert.equal(client.boundStoreIdentity, a.storeInstanceId); assert.notEqual(a.storeInstanceId, b.storeInstanceId);
    await client.submitExperiment(plan(runnerRoot, 'experiment:guarded'));
    target = b.url;
    const mismatch = (error: unknown) => error instanceof RunnerClientError && error.code === 'RUNNER_STORE_MISMATCH';
    await assert.rejects(client.getExperiment('experiment:guarded'), mismatch);
    await assert.rejects(client.cancelExperiment('experiment:guarded'), mismatch);
    await assert.rejects(client.getCommandExecutions('experiment:guarded'), mismatch);
    await assert.rejects(client.getMeasurements('experiment:guarded'), mismatch);
    await assert.rejects(client.getExecutionOutput('experiment:guarded'), mismatch);
    await assert.rejects(client.submitExperiment(plan(runnerRoot, 'experiment:wrong-store')), mismatch);
    await assert.rejects(client.uploadSourceArchive({ filename: archive, sha256: '0'.repeat(64), workspacePath: path.join(runnerRoot, 'upload') }), mismatch);
    const wrong = new RunnerClient({ baseUrl: b.url, token });
    await assert.rejects(wrong.getExperiment('experiment:guarded'), /not found/i);
    await assert.rejects(wrong.getExperiment('experiment:wrong-store'), /not found/i);
    target = a.url;
    assert.equal((await client.getExperiment('experiment:guarded')).experiment_id, 'experiment:guarded');
    assert.equal((await client.cancelExperiment('experiment:guarded')).experiment_id, 'experiment:guarded');
  } finally {
    proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
    await a.close(); await b.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an old Runner cannot silently accept a guarded submit', async () => {
  let oldSubmissions = 0;
  const old = http.createServer((req, res) => {
    if (req.url === '/experiments' && req.method === 'POST') oldSubmissions++;
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"NOT_FOUND"}}');
  });
  await new Promise<void>(resolve => old.listen(0, '127.0.0.1', resolve));
  const address = old.address(); assert.ok(address && typeof address === 'object');
  try {
    const client = new RunnerClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: 'fixture' });
    client.bindStoreIdentity('11111111-1111-4111-8111-111111111111');
    await assert.rejects(client.submitExperiment(plan(os.tmpdir(), 'experiment:old')),
      error => error instanceof RunnerClientError && error.code === 'RUNNER_STORE_GUARD_UNAVAILABLE');
    assert.equal(oldSubmissions, 0);
  } finally { old.closeAllConnections(); await new Promise<void>(resolve => old.close(() => resolve())); }
});
