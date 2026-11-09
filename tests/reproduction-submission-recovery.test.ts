import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { OptimizationWorkflowRecord } from '../src/contracts/workflow.js';
import { startWebFixture } from './web-fixture.js';
import { prepareReproductionFixture } from './reproduction-fixture.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { RunnerClient } from '../src/client/runner-client.js';

/** A local proxy loses responses only after the real local Runner has accepted the plan. */
async function proxyRunner(target: string, mode: '500' | 'disconnect' | 'reject' | 'pass' | 'hold-upload' | 'no-artifact') {
  let posts = 0; let uploads = 0; let checks = 0; let cancels = 0; let hideExperiment = false; let failCancel = false;
  let hideArtifactCapability = mode === 'no-artifact';
  let base = new URL(target);
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'PUT' && url.includes('/source-archives?')) {
      uploads++;
      if (mode === 'hold-upload') { req.resume(); return; }
    }
    if (req.method === 'POST' && url.endsWith('/experiments')) {
      posts++;
      if (mode === 'reject') { req.resume(); res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"code":"INVALID_EXPERIMENT_PLAN","message":"fixture rejected"}}'); return; }
    }
    if (req.method === 'GET' && url.includes('/experiments/')) checks++;
    if (req.method === 'POST' && url.endsWith('/cancel')) cancels++;
    if (req.method === 'GET' && url.includes('/experiments/') && hideExperiment) {
      res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"code":"EXPERIMENT_NOT_FOUND"}}'); return;
    }
    if (req.method === 'POST' && url.endsWith('/cancel') && failCancel) {
      req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":"UNAVAILABLE"}}'); return;
    }
    const upstream = http.request(new URL(url, base), { method: req.method, headers: { ...req.headers, host: base.host } }, response => {
      if (req.method === 'GET' && url.endsWith('/health') && hideArtifactCapability && response.statusCode === 200) {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => { const health = JSON.parse(Buffer.concat(chunks).toString()); delete health.capabilities.artifact_path_check;
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(health)); }); return;
      }
      if (req.method === 'POST' && url.endsWith('/experiments') && response.statusCode === 202 && mode !== 'pass') {
        response.resume();
        if (mode === 'disconnect') res.destroy();
        else { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"code":"INTERNAL","message":"fixture-secret-token"}}'); }
        return;
      }
      res.writeHead(response.statusCode ?? 500, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.destroyed && !res.headersSent) { res.writeHead(502); res.end(); } });
    req.on('error', () => upstream.destroy()); req.pipe(upstream);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}`, get posts() { return posts; }, get uploads() { return uploads; }, get checks() { return checks; }, get cancels() { return cancels; }, hide() { hideExperiment = true; },
    failCancel() { failCancel = true; }, setTarget(value: string) { base = new URL(value); }, hideArtifact() { hideArtifactCapability = true; },
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

function useProxy(configPath: string, endpoint: string) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')); config.runner.endpoint = endpoint;
  fs.writeFileSync(configPath, JSON.stringify(config));
}

async function settled(service: OptimizationWorkflowService, id: string) {
  const active = (service.reproductions as unknown as { active: Map<string, unknown> }).active;
  for (let i = 0; i < 800; i++) { if (!active.has(id)) return service.get(id)!.reproduction!; await delay(25); }
  assert.fail(JSON.stringify(service.get(id)?.reproduction));
}

for (const mode of ['500', 'disconnect'] as const) test(`accepted reproduction POST with ${mode} is never replayed after Runner 404`, async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'gate') });
  const proxy = await proxyRunner(r.runner.url, mode); useProxy(f.configPath, proxy.url);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const original = JSON.stringify(f.store.getExperiment(r.experiment.experiment_id));
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const unknown = await settled(f.service, r.record.workflow_id);
    assert.equal(unknown.status, 'UNKNOWN'); assert.match(unknown.error!, /不会重新提交/);
    assert.doesNotMatch(unknown.error!, /fixture-secret-token/);
    const experiment = f.store.getExperiment(job.experiment_id)!;
    assert.equal(experiment.status, 'UNKNOWN');
    assert.equal((experiment.declared_context.reproduction_submission_intent as { schema_version: number }).schema_version, 1);
    assert.ok(experiment.declared_context.runner_execution_plan);
    assert.equal(proxy.posts, 1);
    assert.ok(['PENDING', 'RUNNING'].includes((await r.client.getExperiment(job.experiment_id)).status));
    if (mode === 'disconnect') {
      const legacy = structuredClone(experiment); delete legacy.declared_context.reproduction_submission_intent;
      f.store.saveExperiment(legacy);
    }
    await f.service.reproductions.stop();
    proxy.hide(); restarted = new OptimizationWorkflowService({ store: f.store });
    assert.equal(restarted.reproductions.start(r.record.workflow_id).experiment_id, job.experiment_id);
    const recovered = await settled(restarted, r.record.workflow_id);
    assert.equal(recovered.status, 'UNKNOWN'); assert.equal(proxy.posts, 1);
    assert.equal(f.store.getExperiment(job.experiment_id)?.status, 'UNKNOWN');
    assert.equal(f.store.listExperiments(r.candidate.task_id).length, 2);
    assert.equal(JSON.stringify(f.store.getExperiment(r.experiment.experiment_id)), original);
    assert.equal(f.store.getCandidateApproval(r.candidate.candidate_id), null);
    assert.equal(f.service.get(r.record.workflow_id)?.status, 'WAITING_APPROVAL');
    proxy.failCancel();
    await assert.rejects(api.cancelReproduction(r.record.workflow_id), /取消请求尚未确认/);
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.status, 'UNKNOWN');
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.cancel_requested, true);
    assert.notEqual((await r.client.getExperiment(job.experiment_id)).status, 'CANCELLED');
  } finally { await restarted?.stop(); await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('historical submitted reproduction without store identity is read locally but never queried or cancelled automatically', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'gate') });
  const proxy = await proxyRunner(r.runner.url, '500'); useProxy(f.configPath, proxy.url);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    assert.equal((await settled(f.service, r.record.workflow_id)).status, 'UNKNOWN');
    const old = f.store.getExperiment(job.experiment_id)!; delete old.declared_context.runner_store_instance_id; f.store.saveExperiment(old);
    const checks = proxy.checks, cancels = proxy.cancels;
    await f.service.reproductions.stop(); restarted = new OptimizationWorkflowService({ store: f.store });
    restarted.reproductions.start(r.record.workflow_id);
    assert.match((await settled(restarted, r.record.workflow_id)).error!, /历史复现实验没有固定 Runner 数据库身份/);
    await assert.rejects(api.cancelReproduction(r.record.workflow_id), /历史复现实验没有固定 Runner 数据库身份/);
    assert.equal(proxy.checks, checks); assert.equal(proxy.cancels, cancels); assert.equal(proxy.posts, 1);
    assert.equal(f.store.getExperiment(job.experiment_id)?.declared_context.runner_store_instance_id, undefined);
    assert.equal(f.service.reproductions.manifest(r.record.workflow_id).reproduction?.experiment_id, job.experiment_id);
  } finally { await restarted?.stop(); await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('reproduction resumes and cancels only against its frozen Runner store', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'gate') });
  const proxy = await proxyRunner(r.runner.url, '500'); useProxy(f.configPath, proxy.url);
  const replacement = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'fixture-runner', runnerId: r.runner.runnerId,
    dbPath: path.join(f.root, 'replacement.sqlite'), workspaceRoot: r.runnerRoot, resourceEnforcement: 'REQUIRED' });
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    assert.equal((await settled(f.service, r.record.workflow_id)).status, 'UNKNOWN');
    assert.equal(f.store.getExperiment(job.experiment_id)?.declared_context.runner_store_instance_id, r.runner.storeInstanceId);
    assert.equal(proxy.posts, 1); await f.service.reproductions.stop();
    proxy.setTarget(replacement.url);
    restarted = new OptimizationWorkflowService({ store: f.store }); restarted.reproductions.start(r.record.workflow_id);
    const unknown = await settled(restarted, r.record.workflow_id);
    assert.equal(unknown.status, 'UNKNOWN'); assert.match(unknown.error!, /数据库身份与原任务不一致/);
    await assert.rejects(api.cancelReproduction(r.record.workflow_id), /数据库身份与原任务不一致/);
    await assert.rejects(new RunnerClient({ baseUrl: replacement.url, token: 'fixture-runner' }).getExperiment(job.experiment_id), /not found/i);
    assert.ok(['PENDING', 'RUNNING'].includes((await r.client.getExperiment(job.experiment_id)).status));
    assert.equal(proxy.posts, 1);
    proxy.setTarget(r.runner.url);
    restarted.reproductions.start(r.record.workflow_id);
    const stopped = await settled(restarted, r.record.workflow_id);
    assert.equal(stopped.status, 'CANCELLED'); assert.equal(proxy.posts, 1);
  } finally {
    await restarted?.stop(); await f.service.reproductions.stop(); await proxy.close(); await replacement.close(); await r.runner.close(); await f.close();
  }
});

test('a new reproduction rejects missing path checks before any upload or submission', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const proxy = await proxyRunner(r.runner.url, 'no-artifact'); useProxy(f.configPath, proxy.url);
  try {
    const job = await new ApiClient(f.url, { token: f.token }).reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const failed = await settled(f.service, r.record.workflow_id);
    assert.equal(failed.status, 'FAILED'); assert.match(failed.error!, /升级 Runner/);
    assert.equal(proxy.uploads, 0); assert.equal(proxy.posts, 0);
    assert.equal(f.store.getExperiment(job.experiment_id)?.declared_context.runner_store_instance_id, undefined);
  } finally { await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('an already submitted reproduction can be reconciled even if the Runner does not advertise new path checks', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'gate') });
  const proxy = await proxyRunner(r.runner.url, '500'); useProxy(f.configPath, proxy.url);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    assert.equal((await settled(f.service, r.record.workflow_id)).status, 'UNKNOWN');
    proxy.hideArtifact(); await api.cancelReproduction(r.record.workflow_id);
    restarted = new OptimizationWorkflowService({ store: f.store }); restarted.reproductions.start(r.record.workflow_id);
    assert.equal((await settled(restarted, r.record.workflow_id)).status, 'CANCELLED');
    assert.equal(f.store.getExperiment(job.experiment_id)?.status, 'CANCELLED'); assert.equal(proxy.posts, 1);
  } finally { await restarted?.stop(); await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('a Runner rejection before execution fails the reproduction without inventing execution', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const proxy = await proxyRunner(r.runner.url, 'reject'); useProxy(f.configPath, proxy.url);
  try {
    const job = await new ApiClient(f.url, { token: f.token }).reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const done = await settled(f.service, r.record.workflow_id);
    assert.equal(done.status, 'FAILED'); assert.match(done.error!, /INVALID_EXPERIMENT_PLAN/);
    assert.equal(proxy.posts, 1); await assert.rejects(r.client.getExperiment(job.experiment_id), /not found/i);
    const experiment = f.store.getExperiment(job.experiment_id)!;
    assert.equal(experiment.status, 'FAILED'); assert.equal(experiment.evaluation, null);
    assert.equal(f.store.listCommandExecutions(job.experiment_id).length, 0);
  } finally { await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('a confirmed cancellation before submission survives without creating Runner work', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const proxy = await proxyRunner(r.runner.url, 'hold-upload'); useProxy(f.configPath, proxy.url);
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    for (let i = 0; i < 400 && !proxy.uploads; i++) await delay(25);
    assert.equal(proxy.uploads, 1);
    await api.cancelReproduction(r.record.workflow_id);
    const done = await settled(f.service, r.record.workflow_id);
    assert.equal(done.status, 'CANCELLED'); assert.equal(proxy.posts, 0);
    const experiment = f.store.getExperiment(job.experiment_id)!;
    assert.equal(experiment.status, 'CANCELLED'); assert.equal(experiment.declared_context.runner_execution_plan, undefined);
    assert.equal(experiment.declared_context.reproduction_submission_intent, undefined);
    await assert.rejects(r.client.getExperiment(job.experiment_id), /not found/i);
  } finally { await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('lost acknowledgement of the submission intent never causes a POST during recovery', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const proxy = await proxyRunner(r.runner.url, 'pass'); useProxy(f.configPath, proxy.url);
  const claim = f.store.claimReproductionSubmission.bind(f.store);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    f.store.claimReproductionSubmission = (...args) => { claim(...args); throw new Error('injected lost local acknowledgement'); };
    const job = await new ApiClient(f.url, { token: f.token }).reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const unknown = await settled(f.service, r.record.workflow_id);
    assert.equal(unknown.status, 'UNKNOWN'); assert.equal(proxy.posts, 0);
    assert.ok(f.store.getExperiment(job.experiment_id)?.declared_context.reproduction_submission_intent);
    f.store.claimReproductionSubmission = claim;
    await f.service.reproductions.stop(); restarted = new OptimizationWorkflowService({ store: f.store });
    restarted.reproductions.start(r.record.workflow_id);
    assert.equal((await settled(restarted, r.record.workflow_id)).status, 'UNKNOWN');
    assert.equal(proxy.posts, 0); assert.equal(f.store.listExperiments(r.candidate.task_id).length, 2);
  } finally { f.store.claimReproductionSubmission = claim; await restarted?.stop(); await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('a failure saving UNKNOWN keeps the job recoverable without exposing the persistence error', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'gate') });
  const proxy = await proxyRunner(r.runner.url, '500'); useProxy(f.configPath, proxy.url);
  const save = f.store.saveExperiment.bind(f.store);
  try {
    f.store.saveExperiment = experiment => {
      if (experiment.status === 'UNKNOWN') throw new Error('injected fixture-secret-token');
      save(experiment);
    };
    const job = await new ApiClient(f.url, { token: f.token }).reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const unknown = await settled(f.service, r.record.workflow_id);
    assert.equal(unknown.status, 'UNKNOWN'); assert.match(unknown.error!, /本地实验状态暂时无法保存/);
    assert.doesNotMatch(unknown.error!, /fixture-secret-token/);
    assert.equal(f.store.getExperiment(job.experiment_id)?.status, 'PENDING');
    assert.ok(f.store.getExperiment(job.experiment_id)?.declared_context.reproduction_submission_intent);
    assert.equal(proxy.posts, 1);
  } finally { f.store.saveExperiment = save; await f.service.reproductions.stop(); await proxy.close(); await r.runner.close(); await f.close(); }
});

test('two connections cannot both claim the same reproduction submission intent', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const second = new SqliteTaskStore(path.join(f.root, 'db.sqlite')); second.init();
  try {
    const runtime = new OptimizationRuntime(f.store);
    const experiment = runtime.prepareExperiment({ taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id,
      type: 'REVALIDATION', initialStatus: 'PENDING', declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } });
    const previous = f.store.getOptimizationWorkflowJson(r.record.workflow_id)!;
    const next = JSON.stringify({ ...r.record, reproduction: { experiment_id: experiment.experiment_id,
      original_experiment_id: r.experiment.experiment_id, status: 'PREPARING', phase: 'fixture', source_commit: r.candidate.source.commit,
      evaluator_digest: r.experiment.evaluator.digest, machine_identity: 'fixture', remote_root: '', created_at: r.record.created_at,
      updated_at: r.record.updated_at, error: null } });
    f.store.createReproductionExperiment(experiment, previous, next);
    const plan = r.plan as unknown as Record<string, unknown>;
    const saveWorkflow = f.store.saveOptimizationWorkflowJson.bind(f.store);
    f.store.saveOptimizationWorkflowJson = (id, json) => { saveWorkflow(id, json); throw new Error('injected intent transaction failure'); };
    try { assert.throws(() => f.store.claimReproductionSubmission(r.record.workflow_id, experiment, plan, '/fixture/rolled-back', new Date().toISOString()), /injected intent transaction failure/); }
    finally { f.store.saveOptimizationWorkflowJson = saveWorkflow; }
    assert.deepEqual(f.store.getExperiment(experiment.experiment_id), experiment);
    assert.equal(f.store.getOptimizationWorkflowJson(r.record.workflow_id), next);
    const cancelled = JSON.parse(next); cancelled.reproduction.cancel_requested = true;
    f.store.saveOptimizationWorkflowJson(r.record.workflow_id, JSON.stringify(cancelled));
    assert.throws(() => second.claimReproductionSubmission(r.record.workflow_id, experiment, plan, '/fixture/cancelled', new Date().toISOString()), /状态已变化/);
    assert.equal(f.store.getExperiment(experiment.experiment_id)?.declared_context.runner_execution_plan, undefined);
    f.store.saveOptimizationWorkflowJson(r.record.workflow_id, next);
    f.store.claimReproductionSubmission(r.record.workflow_id, experiment, plan, '/fixture/winner', new Date().toISOString());
    assert.throws(() => second.claimReproductionSubmission(r.record.workflow_id, experiment, plan, '/fixture/loser', new Date().toISOString()), /状态已变化/);
    const saved = f.store.getExperiment(experiment.experiment_id)!;
    assert.deepEqual(saved.declared_context.runner_execution_plan, plan);
    assert.equal((saved.declared_context.reproduction_submission_intent as { experiment_id: string }).experiment_id, experiment.experiment_id);
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.remote_root, '/fixture/winner');
    assert.throws(() => runtime.failExperiment({ experimentId: experiment.experiment_id, error: 'cancelled', cancelled: true,
      expectedExperiment: experiment }), /实验状态已改变/);
    assert.equal(f.store.getExperiment(experiment.experiment_id)?.status, 'PENDING');
    assert.equal(f.store.updateReproduction(r.record.workflow_id, experiment.experiment_id, { cancel_requested: true }), true);
    assert.equal(second.updateReproduction(r.record.workflow_id, experiment.experiment_id, { phase: 'concurrent progress' }), true);
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.cancel_requested, true);
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.remote_root, '/fixture/winner');
    const saveIfCurrent = f.store.saveExperimentIfCurrent.bind(f.store);
    f.store.saveExperimentIfCurrent = (expected, result) => {
      second.saveExperiment({ ...expected, status: 'SUCCEEDED', ended_at: new Date().toISOString() });
      return saveIfCurrent(expected, result);
    };
    try { assert.throws(() => runtime.markRemoteStateUnknown(experiment.experiment_id, 'connection lost'), /状态已改变/); }
    finally { f.store.saveExperimentIfCurrent = saveIfCurrent; }
    assert.equal(f.store.getExperiment(experiment.experiment_id)?.status, 'SUCCEEDED');
  } finally { second.close(); await r.runner.close(); await f.close(); }
});

test('cancellation racing with an existing submission intent cannot invent a cancelled outcome', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  const second = new SqliteTaskStore(path.join(f.root, 'db.sqlite')); second.init();
  const update = f.store.updateReproduction.bind(f.store);
  try {
    const runtime = new OptimizationRuntime(f.store);
    const experiment = runtime.prepareExperiment({ taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id,
      type: 'REVALIDATION', initialStatus: 'PENDING', declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } });
    const previous = f.store.getOptimizationWorkflowJson(r.record.workflow_id)!;
    const next = JSON.stringify({ ...r.record, reproduction: { experiment_id: experiment.experiment_id,
      original_experiment_id: r.experiment.experiment_id, status: 'PREPARING', phase: 'fixture', source_commit: r.candidate.source.commit,
      evaluator_digest: r.experiment.evaluator.digest, machine_identity: 'fixture', remote_root: '', created_at: r.record.created_at,
      updated_at: r.record.updated_at, error: null } });
    f.store.createReproductionExperiment(experiment, previous, next);
    f.store.updateReproduction = (workflowId, experimentId, patch) => {
      if (patch.cancel_requested) second.claimReproductionSubmission(workflowId, experiment, r.plan as unknown as Record<string, unknown>, '/fixture/winner', new Date().toISOString());
      return update(workflowId, experimentId, patch);
    };
    await assert.rejects(new ApiClient(f.url, { token: f.token }).cancelReproduction(r.record.workflow_id), /取消请求尚未确认/);
    const saved = f.store.getExperiment(experiment.experiment_id)!;
    assert.equal(saved.status, 'PENDING');
    assert.ok(saved.declared_context.reproduction_submission_intent);
    const job = f.service.get(r.record.workflow_id)!.reproduction!;
    assert.equal(job.status, 'UNKNOWN'); assert.equal(job.cancel_requested, true); assert.equal(job.remote_root, '/fixture/winner');
  } finally { f.store.updateReproduction = update; second.close(); await r.runner.close(); await f.close(); }
});
