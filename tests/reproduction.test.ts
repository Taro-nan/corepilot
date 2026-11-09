import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { prepareReproductionFixture } from './reproduction-fixture.js';
import { ApiClient } from '../src/client/api-client.js';
import type { OptimizationWorkflowRecord } from '../src/contracts/workflow.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';

async function finished(f: Awaited<ReturnType<typeof startWebFixture>>, id: string) {
  for (let i = 0; i < 600; i++) {
    const job = f.service.get(id)?.reproduction;
    if (job && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCONCLUSIVE'].includes(job.status)) return job;
    await delay(25);
  }
  assert.fail(JSON.stringify(f.service.get(id)?.reproduction));
}

test('public CLI/API rebuilds exact frozen source in a new Runner directory, appends evidence and never calls a model', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  try {
    const original = JSON.stringify(f.store.getExperiment(r.experiment.experiment_id));
    const api = new ApiClient(f.url, { token: f.token });
    const cli = await runFixtureCli(f.url, f.token, ['workflow', 'reproduce', r.record.workflow_id, '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    const first = JSON.parse(cli.stdout) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const duplicate = await api.reproduceWorkflow(r.record.workflow_id) as typeof first;
    assert.equal(duplicate.experiment_id, first.experiment_id);
    const done = await finished(f, r.record.workflow_id);
    assert.equal(done.status, 'SUCCEEDED', done.error ?? done.phase);
    assert.notEqual(done.remote_root, path.dirname(r.plan.candidate!.workspace_path));
    assert.deepEqual(fs.readFileSync(path.join(done.remote_root, 'build', 'kernel.bin')), fs.readFileSync(path.join(r.workspace.validation, 'kernel.c')));
    assert.equal(fs.existsSync(r.artifact), false, 'old build was never used');
    assert.equal(fs.existsSync(path.join(r.runnerRoot, 'original', 'runtime')), false, 'old evaluator runtime was never used');
    assert.equal(fs.existsSync(path.join(done.remote_root, 'runtime')), true, 'evaluator setup uses the fresh run directory');
    assert.equal(fs.readFileSync(r.baseline, 'utf8'), 'baseline fixture', 'the frozen comparison path is retained even when it lived under the original run');
    const experiment = f.store.getExperiment(done.experiment_id)!;
    assert.equal(experiment.type, 'REVALIDATION'); assert.equal(experiment.evaluation?.performance, 'PASSED');
    assert.equal(experiment.declared_context.purpose, 'DELIVERY_REPRODUCTION');
    assert.equal(f.store.listMeasurements(done.experiment_id).filter(row => row.kind === 'PERFORMANCE_SAMPLE').length, 6);
    const commands = f.store.listCommandExecutions(done.experiment_id);
    assert.ok(commands[0].args.join(' ').includes(path.join(done.remote_root, 'build').replaceAll('\\', '/')));
    assert.equal(JSON.stringify(f.store.getExperiment(r.experiment.experiment_id)), original);
    assert.equal(f.service.get(r.record.workflow_id)?.status, 'WAITING_APPROVAL');
    assert.equal(f.store.getCandidateApproval(r.candidate.candidate_id), null);
    assert.equal(f.modelRequests.inference, 0);
    assert.ok(JSON.stringify(await api.getReproduction(r.record.workflow_id)).includes(r.checkpoint.commit));
  } finally { await f.service.reproductions.stop(); await r.runner.close(); await f.close(); }
});

test('observation restart reconciles the same reproduction ID; confirmed cancellation preserves original workflow and history', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { buildGate: path.join(f.root, 'release') });
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const job = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    for (let i = 0; i < 300 && (await r.client.getExperiment(job.experiment_id).catch(() => null))?.status !== 'RUNNING'; i++) await delay(25);
    await f.service.reproductions.stop();
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.status, 'UNKNOWN');
    const resumed = await api.reproduceWorkflow(r.record.workflow_id) as typeof job;
    assert.equal(resumed.experiment_id, job.experiment_id);
    const cancelled = await runFixtureCli(f.url, f.token, ['workflow', 'reproduce', r.record.workflow_id, '--cancel', '--json']);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    const done = await finished(f, r.record.workflow_id);
    assert.equal(done.status, 'CANCELLED', done.error ?? done.phase);
    assert.equal(f.store.listExperiments(r.candidate.task_id).length, 2);
    assert.equal(f.service.get(r.record.workflow_id)?.status, 'WAITING_APPROVAL');
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.service.reproductions.stop(); await r.runner.close(); await f.close(); }
});

test('resource enforcement and original machine identity are checked before any build', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f, { resourceEnforcement: 'DISABLED' });
  try {
    f.service.reproductions.start(r.record.workflow_id);
    const done = await finished(f, r.record.workflow_id);
    assert.equal(done.status, 'FAILED'); assert.match(done.error!, /资源约束/);
    assert.equal(f.store.listCommandExecutions(done.experiment_id).length, 0);
  } finally { await r.runner.close(); await f.close(); }
});

test('a failed workflow write rolls back the new reproduction and a retry creates exactly one experiment', async () => {
  const f = await startWebFixture(); const gate = path.join(f.root, 'release-atomic');
  const r = await prepareReproductionFixture(f, { buildGate: gate });
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const beforeWorkflow = f.store.getOptimizationWorkflowJson(r.record.workflow_id);
    const beforeExperiments = f.store.listExperiments(r.candidate.task_id);
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('injected failure after experiment insert'); };
    await assert.rejects(api.reproduceWorkflow(r.record.workflow_id), /injected failure after experiment insert/);
    assert.equal(f.store.getOptimizationWorkflowJson(r.record.workflow_id), beforeWorkflow);
    assert.deepEqual(f.store.listExperiments(r.candidate.task_id), beforeExperiments);
    assert.equal(f.modelRequests.inference, 0);

    f.store.saveOptimizationWorkflowJson = save;
    const started = await api.reproduceWorkflow(r.record.workflow_id) as NonNullable<OptimizationWorkflowRecord['reproduction']>;
    const retry = await api.reproduceWorkflow(r.record.workflow_id) as typeof started;
    assert.equal(retry.experiment_id, started.experiment_id);
    assert.equal(f.store.listExperiments(r.candidate.task_id).length, beforeExperiments.length + 1);
    fs.writeFileSync(gate, 'release');
    assert.equal((await finished(f, r.record.workflow_id)).status, 'SUCCEEDED');
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.service.reproductions.stop(); await r.runner.close(); await f.close(); }
});

test('stale concurrent creation cannot overwrite the committed reproduction or add an orphan', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  try {
    const runtime = new OptimizationRuntime(f.store);
    const input = { taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id, type: 'REVALIDATION' as const, initialStatus: 'PENDING' as const,
      declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } };
    const first = runtime.prepareExperiment(input), second = runtime.prepareExperiment(input);
    const previous = f.store.getOptimizationWorkflowJson(r.record.workflow_id)!;
    const snapshot = (experimentId: string) => JSON.stringify({ ...r.record, reproduction: {
      experiment_id: experimentId, original_experiment_id: r.experiment.experiment_id, status: 'PREPARING', phase: 'fixture',
      source_commit: r.candidate.source.commit, evaluator_digest: r.experiment.evaluator.digest, machine_identity: 'fixture',
      remote_root: '', created_at: r.record.created_at, updated_at: r.record.updated_at, error: null,
    } });
    f.store.createReproductionExperiment(first, previous, snapshot(first.experiment_id));
    assert.throws(() => f.store.createReproductionExperiment(second, previous, snapshot(second.experiment_id)), /任务状态已变化/);
    assert.equal(f.store.getExperiment(second.experiment_id), null);
    assert.equal(f.store.getExperiment(first.experiment_id)?.status, 'PENDING');
    assert.equal(f.service.get(r.record.workflow_id)?.reproduction?.experiment_id, first.experiment_id);
    assert.throws(() => f.store.createReproductionExperiment(second, snapshot(first.experiment_id), snapshot(second.experiment_id)), /identity or status mismatch/);
  } finally { await r.runner.close(); await f.close(); }
});

test('a new pending experiment appearing after the precheck prevents reproduction creation', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  try {
    const runtime = new OptimizationRuntime(f.store);
    const input = { taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id, type: 'REVALIDATION' as const, initialStatus: 'PENDING' as const,
      declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } };
    const intended = runtime.prepareExperiment(input);
    const previous = f.store.getOptimizationWorkflowJson(r.record.workflow_id)!;
    const next = JSON.stringify({ ...r.record, reproduction: { experiment_id: intended.experiment_id,
      original_experiment_id: r.experiment.experiment_id, status: 'PREPARING', phase: 'fixture', source_commit: r.candidate.source.commit,
      evaluator_digest: r.experiment.evaluator.digest, machine_identity: 'fixture', remote_root: '', created_at: r.record.created_at,
      updated_at: r.record.updated_at, error: null } });
    const other = runtime.startExperiment(input);
    assert.throws(() => f.store.createReproductionExperiment(intended, previous, next), /未确认终态的实验/);
    assert.equal(f.store.getOptimizationWorkflowJson(r.record.workflow_id), previous);
    assert.equal(f.store.getExperiment(intended.experiment_id), null);
    assert.deepEqual(f.store.getExperiment(other.experiment_id), other);
  } finally { await r.runner.close(); await f.close(); }
});

test('restart recovers a committed reproduction using its original experiment ID', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  let restarted: OptimizationWorkflowService | undefined;
  try {
    const runtime = new OptimizationRuntime(f.store);
    const experiment = runtime.prepareExperiment({ taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id,
      type: 'REVALIDATION', initialStatus: 'PENDING', declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } });
    const previous = f.store.getOptimizationWorkflowJson(r.record.workflow_id)!;
    const machine = f.store.getExperiment(r.experiment.experiment_id)!.observed_context!.machine as { machine_identity_sha256: string };
    const next = JSON.stringify({ ...r.record, reproduction: { experiment_id: experiment.experiment_id,
      original_experiment_id: r.experiment.experiment_id, status: 'PREPARING', phase: 'fixture', source_commit: r.candidate.source.commit,
      evaluator_digest: r.experiment.evaluator.digest, machine_identity: machine.machine_identity_sha256, remote_root: '',
      created_at: r.record.created_at, updated_at: r.record.updated_at, error: null } });
    f.store.createReproductionExperiment(experiment, previous, next);
    await f.service.stop();
    restarted = new OptimizationWorkflowService({ store: f.store });
    assert.equal(restarted.get(r.record.workflow_id)?.reproduction?.status, 'UNKNOWN');
    assert.equal(f.store.getExperiment(experiment.experiment_id)?.status, 'PENDING');
    const resumed = restarted.reproductions.start(r.record.workflow_id);
    assert.equal(resumed.experiment_id, experiment.experiment_id);
    for (let i = 0; i < 600; i++) {
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'INCONCLUSIVE'].includes(restarted.get(r.record.workflow_id)?.reproduction?.status ?? '')) break;
      await delay(25);
    }
    const done = restarted.get(r.record.workflow_id)?.reproduction;
    assert.equal(done?.status, 'SUCCEEDED', done?.error ?? done?.phase);
    assert.equal(done?.experiment_id, experiment.experiment_id);
    assert.equal(f.store.listExperiments(r.candidate.task_id).length, 2);
  } finally { await restarted?.stop(); await r.runner.close(); await f.close(); }
});

test('an unlinked historical reproduction is visible and blocks retries without changing its state', async () => {
  const f = await startWebFixture(); const r = await prepareReproductionFixture(f);
  try {
    const runtime = new OptimizationRuntime(f.store);
    const orphan = runtime.startExperiment({ taskId: r.candidate.task_id, candidateId: r.candidate.candidate_id,
      type: 'REVALIDATION', initialStatus: 'PENDING', declaredContext: { purpose: 'DELIVERY_REPRODUCTION', reproduction_of: r.experiment.experiment_id } });
    const original = f.store.getOptimizationWorkflowJson(r.record.workflow_id);
    const api = new ApiClient(f.url, { token: f.token });
    const manifest = await api.getReproduction(r.record.workflow_id) as { unlinked_reproductions: Array<{ experiment_id: string; status: string }> };
    assert.deepEqual(manifest.unlinked_reproductions.map(item => [item.experiment_id, item.status]), [[orphan.experiment_id, 'PENDING']]);
    await assert.rejects(api.reproduceWorkflow(r.record.workflow_id), new RegExp(`未关联的历史复现实验 ${orphan.experiment_id}`));
    const cli = await runFixtureCli(f.url, f.token, ['workflow', 'reproduce', r.record.workflow_id, '--json']);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /未关联的历史复现实验/);
    assert.ok(cli.stderr.includes(orphan.experiment_id));
    assert.equal(f.store.getOptimizationWorkflowJson(r.record.workflow_id), original);
    assert.deepEqual(f.store.getExperiment(orphan.experiment_id), orphan);
    assert.equal(f.store.listExperiments(r.candidate.task_id).length, 2);
    await assert.rejects(r.client.getExperiment(orphan.experiment_id), /not found/i);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await r.runner.close(); await f.close(); }
});
