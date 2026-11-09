import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { TaskHost } from '../src/core/task-host.js';
import { createHttpServer } from '../src/http/server.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts, approveFixture } from './workflow-approval-fixture.js';

async function fixture() {
  const f = await startWebFixture();
  const seeded = await seedBlockedValidation(f, true);
  const accepted = seedApprovalFacts(f, seeded.workflowId);
  await approveFixture(f, seeded.workflowId);
  const record = f.service.get(seeded.workflowId)!;
  return { ...f, seeded, accepted, record, api: new ApiClient(f.url, { token: f.token }), baseline: f.git('rev-parse', 'HEAD') };
}

async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.stop();
  const service = new OptimizationWorkflowService({ store: f.store, transportFactory: () => { throw new Error('delivery recovery must not use a Runner'); } });
  const server = createHttpServer(new TaskHost(f.store), { host: '127.0.0.1', port: 0, workflowService: service, accessToken: f.token });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  return { service, url, api: new ApiClient(url, { token: f.token }), async close() { await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function waitFor(f: Awaited<ReturnType<typeof fixture>>, predicate: () => boolean) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(25); }
  assert.fail(JSON.stringify(f.store.getOptimizationWorkflowJson(f.record.workflow_id)));
}

test('a lost database write after Git advances is reconciled after service restart without another merge or lost workspace edits', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof restart>> | undefined;
  const save = f.store.saveCompletedDelivery.bind(f.store);
  try {
    f.store.saveCompletedDelivery = () => { throw new Error('fixture database unavailable'); };
    await assert.rejects(f.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'fixture delivery' }),
      error => error instanceof ApiClientError && error.status === 409);
    const pending = f.service.get(f.record.workflow_id)!;
    assert.equal(pending.delivery_operation?.status, 'APPLYING');
    const commit = pending.delivery_operation!.prepared_commit!;
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
    assert.equal(f.git('rev-parse', 'HEAD^{tree}'), f.seeded.checkpoint.tree);
    assert.equal(pending.status, 'WAITING_APPROVAL');
    const note = path.join(f.seeded.workspace.editing, 'private-after-interruption.txt');
    fs.writeFileSync(note, 'keep this local note');
    f.store.saveCompletedDelivery = save;
    restarted = await restart(f);
    await waitFor(f, () => {
      const operation = restarted!.service.get(f.record.workflow_id)?.delivery_operation;
      return operation?.status === 'COMPLETED' && operation.cleanup !== 'PENDING';
    });
    const recovered = (await restarted.api.getOptimizationWorkflow(f.record.workflow_id) as { workflow: typeof f.record }).workflow;
    assert.equal(recovered.status, 'DELIVERABLE'); assert.equal(recovered.delivery?.commit, commit);
    assert.equal(recovered.delivery_operation?.cleanup, 'NEEDS_ATTENTION');
    assert.equal(fs.readFileSync(note, 'utf8'), 'keep this local note');
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
    assert.equal(f.store.getCandidateApproval(f.seeded.candidate.candidate_id)?.approval_status, 'APPROVED');
    const cli = await runFixtureCli(restarted.url, f.token, ['workflow', 'delivery-check', f.record.workflow_id, '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).workflow.delivery.commit, commit);
    fs.unlinkSync(note);
    const cleaned = await restarted.api.cleanupWorkflowDelivery(f.record.workflow_id);
    assert.equal(cleaned.workflow.delivery_operation?.cleanup, 'DONE');
    assert.equal(fs.existsSync(f.seeded.workspace.editing), false);
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
  } finally { f.store.saveCompletedDelivery = save; if (restarted) await restarted.close(); await f.close(); }
});

test('a prepared commit survives interruption and explicit resume applies the same commit exactly once', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof restart>> | undefined;
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (JSON.parse(json).delivery_operation?.status === 'PREPARED') throw new Error('fixture interruption after pin');
      save(id, json);
    };
    await assert.rejects(f.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'same fixture commit' }));
    const pending = f.service.get(f.record.workflow_id)!;
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    assert.ok(pending.delivery_operation?.prepared_commit);
    const commit = pending.delivery_operation.prepared_commit;
    const operationId = pending.delivery_operation.operation_id;
    f.store.saveOptimizationWorkflowJson = save;
    restarted = await restart(f);
    await waitFor(f, () => restarted!.service.get(f.record.workflow_id)?.delivery_operation?.status === 'WAITING');
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline, 'startup reconciliation must not merge');
    const response = await restarted.api.resumeWorkflowDelivery(f.record.workflow_id);
    assert.equal(response.commit, commit);
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
    const repeat = await restarted.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'same fixture commit' }) as { commit: string };
    assert.equal(repeat.commit, commit);
    assert.equal(restarted.service.get(f.record.workflow_id)?.delivery_operation?.operation_id, operationId);
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
  } finally { f.store.saveOptimizationWorkflowJson = save; if (restarted) await restarted.close(); await f.close(); }
});

test('an interrupted applying phase is not resumed until the prior Git process is confirmed stopped', async () => {
  const f = await fixture();
  let restarted: Awaited<ReturnType<typeof restart>> | undefined;
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  let interrupted = false;
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (interrupted) throw new Error('fixture process interrupted');
      save(id, json);
      if (JSON.parse(json).delivery_operation?.status === 'APPLYING') { interrupted = true; throw new Error('fixture process interrupted'); }
    };
    await assert.rejects(f.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'interrupted fixture' }));
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    const commit = f.service.get(f.record.workflow_id)!.delivery_operation!.prepared_commit;
    f.store.saveOptimizationWorkflowJson = save;
    restarted = await restart(f);
    await waitFor(f, () => restarted!.service.get(f.record.workflow_id)?.delivery_operation?.stop_confirmation_required === true);
    const status = restarted.service.get(f.record.workflow_id)!.delivery_operation!;
    assert.equal(status.status, 'NEEDS_ATTENTION'); assert.equal(status.observation, 'NOT_APPLIED');
    await assert.rejects(restarted.api.resumeWorkflowDelivery(f.record.workflow_id), /确认它已停止/);
    await assert.rejects(restarted.api.withdrawWorkflowDelivery(f.record.workflow_id, status.operation_id), /确认它已停止/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    const done = await restarted.api.resumeWorkflowDelivery(f.record.workflow_id, true);
    assert.equal(done.commit, commit); assert.equal(f.git('rev-parse', 'HEAD'), commit);
    assert.ok(restarted.service.get(f.record.workflow_id)?.delivery_operation?.stop_confirmed_at);
  } finally { f.store.saveOptimizationWorkflowJson = save; if (restarted) await restarted.close(); await f.close(); }
});

test('a pending request cannot be resumed after a newer validation invalidates its frozen evidence', async () => {
  const f = await fixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (JSON.parse(json).delivery_operation?.status === 'PREPARED') throw new Error('fixture interruption after pin');
      save(id, json);
    };
    await assert.rejects(f.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'fixture delivery' }));
    f.store.saveOptimizationWorkflowJson = save;
    const changed = f.service.get(f.record.workflow_id)!;
    changed.status = 'FAILED';
    f.store.saveOptimizationWorkflowJson(changed.workflow_id, JSON.stringify(changed));
    assert.throws(() => f.service.resumePublic(changed.workflow_id), /先核对或撤回交付请求/);
    assert.throws(() => f.service.retryValidationPublic(changed.workflow_id), /先核对或撤回交付请求/);
    const changedStatus = await f.api.reconcileWorkflowDelivery(f.record.workflow_id);
    assert.equal(changedStatus.workflow.delivery_operation?.can_resume, false);
    changed.status = 'WAITING_APPROVAL';
    changed.delivery_operation = changedStatus.workflow.delivery_operation;
    f.store.saveOptimizationWorkflowJson(changed.workflow_id, JSON.stringify(changed));
    const previous = f.store.getExperiment(f.accepted.repeated.experiment_id)!;
    f.store.createExperiment({ ...previous, experiment_id: 'experiment:newer-invalid-revalidation',
      status: 'FAILED', validity: 'INVALID', failure_category: 'EVALUATOR_FAILURE' });
    const checked = await f.api.reconcileWorkflowDelivery(f.record.workflow_id);
    assert.equal(checked.workflow.delivery_operation?.status, 'NEEDS_ATTENTION');
    assert.equal(checked.workflow.delivery_operation?.can_resume, false);
    assert.match(checked.workflow.delivery_operation?.message ?? '', /候选或验证记录已变化/);
    await assert.rejects(f.api.resumeWorkflowDelivery(f.record.workflow_id), /候选或验证记录已变化/);
    const operationId = checked.workflow.delivery_operation!.operation_id;
    const cli = await runFixtureCli(f.url, f.token, ['workflow', 'delivery-withdraw', f.record.workflow_id, '--operation-id', operationId, '--json']);
    assert.equal(cli.code, 0, cli.stderr);
    const withdrawn = JSON.parse(cli.stdout).workflow;
    assert.equal(withdrawn.delivery_operation, undefined);
    assert.equal(withdrawn.delivery_history.length, 1);
    assert.equal(withdrawn.delivery_history[0].operation_id, operationId);
    assert.equal(withdrawn.delivery_history[0].status, 'WITHDRAWN');
    const latest = f.service.get(f.record.workflow_id)!;
    const laterId = 'fedcba98-7654-4321-8234-123456789012';
    latest.delivery_operation = { ...latest.delivery_history![0], operation_id: laterId, status: 'PREPARING',
      prepared_commit: null, observation: 'UNKNOWN', can_resume: false };
    f.store.saveOptimizationWorkflowJson(latest.workflow_id, JSON.stringify(latest));
    const repeated = await f.api.withdrawWorkflowDelivery(f.record.workflow_id, operationId);
    assert.equal(repeated.workflow.delivery_history?.length, 1);
    assert.equal(repeated.workflow.delivery_operation?.operation_id, laterId, 'retrying an old withdrawal must not withdraw a newer request');
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    assert.equal(f.store.getCandidateApproval(f.seeded.candidate.candidate_id)?.approval_status, 'APPROVED');
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('withdrawal reconciles an already applied Git commit instead of hiding or reversing delivery', async () => {
  const f = await fixture();
  const save = f.store.saveCompletedDelivery.bind(f.store);
  try {
    f.store.saveCompletedDelivery = () => { throw new Error('fixture database unavailable'); };
    await assert.rejects(f.api.requestWorkflowApprove(f.record.workflow_id, { commit_message: 'fixture delivery' }));
    const pending = f.service.get(f.record.workflow_id)!;
    const operationId = pending.delivery_operation!.operation_id;
    const commit = pending.delivery_operation!.prepared_commit!;
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
    f.store.saveCompletedDelivery = save;
    await assert.rejects(f.api.withdrawWorkflowDelivery(f.record.workflow_id, operationId), /不能撤回/);
    const recovered = f.service.get(f.record.workflow_id)!;
    assert.equal(recovered.status, 'DELIVERABLE');
    assert.equal(recovered.delivery?.commit, commit);
    assert.equal(recovered.delivery_history?.length ?? 0, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
  } finally { f.store.saveCompletedDelivery = save; await f.close(); }
});

test('normal delivery keeps ignored user files made after the candidate was frozen and allows cleanup after they are handled', async () => {
  const f = await fixture();
  try {
    const note = path.join(f.seeded.workspace.editing, 'private-after-freeze.txt');
    fs.writeFileSync(note, 'keep this local note');
    fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\nprivate-after-freeze.txt\n');
    const result = await runFixtureCli(f.url, f.token, ['workflow', 'approve', f.record.workflow_id, '--commit-message', 'fixture delivery']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /未提交内容/);
    const commit = f.git('rev-parse', 'HEAD');
    assert.notEqual(commit, f.baseline);
    assert.equal(f.service.get(f.record.workflow_id)?.delivery_operation?.cleanup, 'NEEDS_ATTENTION');
    assert.equal(fs.readFileSync(note, 'utf8'), 'keep this local note');
    fs.unlinkSync(note);
    const cleaned = await f.api.cleanupWorkflowDelivery(f.record.workflow_id);
    assert.equal(cleaned.workflow.delivery_operation?.cleanup, 'DONE');
    assert.equal(fs.existsSync(f.seeded.workspace.editing), false);
    assert.equal(f.git('rev-parse', 'HEAD'), commit);
  } finally { await f.close(); }
});

test('pending delivery discovery includes old records beyond the workflow listing limit', async () => {
  const f = await fixture();
  try {
    const pending = { ...f.record, delivery_operation: { status: 'WAITING' } };
    f.store.saveOptimizationWorkflowJson('old-pending-delivery', JSON.stringify(pending));
    for (let i = 0; i < 205; i++) f.store.saveOptimizationWorkflowJson(`unrelated-${i}`, JSON.stringify(f.record));
    assert.equal(f.store.listOptimizationWorkflowJson(200).some(row => JSON.parse(row).delivery_operation?.status === 'WAITING'), false);
    assert.ok(f.store.listPendingDeliveryWorkflowIds().includes('old-pending-delivery'));
  } finally { await f.close(); }
});
