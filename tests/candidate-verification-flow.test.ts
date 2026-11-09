import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';

test('report, HTTP and CLI agree on current verification without altering historical evidence or the branch', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    const original = f.store.getExperiment(seeded.experiment.experiment_id)!;
    const originalJson = JSON.stringify(original);
    const timestamp = new Date(Date.now() + 10_000).toISOString();
    const valid = {
      ...original, status: 'SUCCEEDED' as const, validity: 'VALID' as const, failure_category: null,
      created_at: timestamp, updated_at: timestamp, ended_at: timestamp,
      observed_context: { machine: { machine_identity_sha256: 'a'.repeat(64) }, resource_policy: { validity: 'VALID' } },
      evaluation: { build: 'PASSED' as const, correctness: 'PASSED' as const, performance: 'NOT_EXECUTED' as const,
        correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true } },
    };
    f.store.createExperiment({ ...valid, experiment_id: 'experiment:z-formal', type: 'FORMAL_EVALUATION' });
    // Same timestamp and reverse lexical ID: insertion order is the actual sequence.
    f.store.createExperiment({ ...valid, experiment_id: 'experiment:a-revalidation', type: 'REVALIDATION' });
    const record = f.service.get(seeded.workflowId)!;
    record.status = 'WAITING_APPROVAL'; record.candidate_evaluation_feedback = null; record.candidate_evaluation_decision = null;
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
    const api = new ApiClient(f.url, { token: f.token });
    const before = f.git('rev-parse', 'HEAD');
    let report = await api.getOptimizationReport(record.workflow_id);
    assert.equal(report.report.summary?.state, 'READY_FOR_REVIEW');
    assert.equal(report.report.summary?.verification.formal_experiment_id, 'experiment:z-formal');
    assert.equal(report.report.summary?.verification.revalidation_experiment_id, 'experiment:a-revalidation');

    const passed = f.store.getExperiment('experiment:a-revalidation')!;
    const passedJson = JSON.stringify(passed);
    f.store.createExperiment({ ...passed, experiment_id: 'experiment:later-invalid-revalidation', validity: 'INVALID', failure_category: 'EVALUATOR_FAILURE' });
    report = await api.getOptimizationReport(record.workflow_id);
    assert.equal(report.report.summary?.state, 'NO_VERIFIED_RESULT');
    assert.deepEqual(report.report.summary?.verification.issues.map(issue => issue.code), ['REVALIDATION_INVALID']);
    await assert.rejects(api.requestWorkflowApprove(record.workflow_id, { commit_message: 'fixture only' }),
      error => error instanceof ApiClientError && error.status === 409 && /复验未形成完整有效/.test(error.message)
        && (error.details?.verification as { issues: Array<{ code: string }> }).issues[0].code === 'REVALIDATION_INVALID');
    const cli = await runFixtureCli(f.url, f.token, ['workflow', 'approve', record.workflow_id, '--commit-message', 'fixture only']);
    assert.notEqual(cli.code, 0);
    assert.match(cli.stderr, /复验未形成完整有效/);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
    assert.equal(f.service.get(record.workflow_id)?.status, 'WAITING_APPROVAL');
    assert.equal(JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id)), originalJson);
    assert.equal(JSON.stringify(f.store.getExperiment(passed.experiment_id)), passedJson);

    // A new failed formal run must take precedence even if the wall clock moved backwards.
    const earlierClock = new Date(Date.parse(timestamp) - 20_000).toISOString();
    f.store.createExperiment({ ...valid, experiment_id: 'experiment:0-new-formal', type: 'FORMAL_EVALUATION', validity: 'INVALID', created_at: earlierClock });
    report = await api.getOptimizationReport(record.workflow_id);
    assert.equal(report.report.summary?.verification.formal_experiment_id, 'experiment:0-new-formal');
    assert.equal(report.report.summary?.verification.revalidation_experiment_id, null);
    assert.deepEqual(report.report.summary?.verification.issues.map(issue => issue.code), ['FORMAL_INVALID', 'REVALIDATION_MISSING']);
    assert.equal(f.git('rev-parse', 'HEAD'), before);
  } finally { await f.close(); }
});
