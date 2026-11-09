import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { prepareReproductionFixture } from './reproduction-fixture.js';
import { ApiClient } from '../src/client/api-client.js';
import type { OptimizationWorkflowRecord } from '../src/contracts/workflow.js';

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
