import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { executeWorkflowCommand } from '../src/client/workflow-commands.js';
import { experimentReview } from '../src/application/experiment-review.js';
import { verifyExperimentReview } from '../src/application/experiment-review-verification.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { validationTestpackDigest } from '../src/testpack/validation-freeze.js';
import type { Experiment, Measurement } from '../src/contracts/optimization-domain.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts } from './workflow-approval-fixture.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('failed experiment export is a private whitelist and does not invent a missing plan', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const secret = '/private/source/secret-token-09876';
    const evaluator = f.store.getExperiment(seeded.experiment.experiment_id)!.evaluator;
    const raw: Measurement = { schema_version: 1, measurement_id: `measurement:${randomUUID()}`, experiment_id: seeded.experiment.experiment_id,
      evaluator, kind: 'PERFORMANCE_SAMPLE', role: 'BASELINE', subject_id: secret, sample_index: .5,
      value: -42, unit: secret, validity: 'INVALID', domain_payload: { command: secret, token: secret }, recorded_at: new Date().toISOString() };
    f.store.appendMeasurement(raw);
    f.store.appendMeasurement({ ...raw, measurement_id: `measurement:${randomUUID()}`, sample_index: 0, value: 99 });
    const before = f.store.getExperiment(seeded.experiment.experiment_id), beforeRows = f.store.listMeasurements(seeded.experiment.experiment_id);
    const help = await runFixtureCli(f.url, f.token, ['evidence', '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /verify-experiment-review/);
    const actionHelp = await runFixtureCli(f.url, f.token, ['evidence', 'verify-experiment-review', '--help']);
    assert.equal(actionHelp.code, 0, actionHelp.stderr);
    assert.match(actionHelp.stdout, /verify-experiment-review/);
    const api = new ApiClient(f.url, { token: f.token });
    const missing = await fetch(`${f.url}/v1/workflows/${encodeURIComponent(seeded.workflowId)}/experiments/missing/review`,
      { headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(missing.status, 404);
    const { review } = await api.getExperimentReview(seeded.workflowId, seeded.experiment.experiment_id);
    const value = review as any;
    assert.equal(value.consistency.plan, 'MISSING');
    assert.equal(value.consistency.runner_synchronization, 'NOT_PROVEN');
    assert.equal(value.recorded.execution, 'FAILED');
    assert.equal(value.recorded.validity, 'INVALID');
    assert.equal(value.recorded.performance, 'NOT_EXECUTED');
    assert.equal(value.calculation.status, 'NOT_COMPUTED');
    assert.equal(value.calculation.reason, 'PLAN_UNAVAILABLE');
    assert.equal(value.plan, null);
    assert.deepEqual(value.performance.map((row: any) => row.value), [-42, 99]);
    assert.deepEqual(value.performance.map((row: any) => row.sample_index), [.5, 0]);
    assert.ok(value.performance.every((row: any) => row.planned === 'UNKNOWN' && row.workload === 'U001' && row.unit === 'UNKNOWN'));
    assert.equal(JSON.stringify(value).includes(secret), false);
    assert.equal(JSON.stringify(value).includes(seeded.workflowId), false);
    assert.equal(JSON.stringify(value).includes(seeded.experiment.experiment_id), false);
    const maliciousOutput = path.join(f.root, 'must-not-be-created.json');
    const maliciousApi = { getExperimentReview: async () => ({ review: { ...value, private_path: secret } }) } as unknown as ApiClient;
    await assert.rejects(executeWorkflowCommand(maliciousApi, ['experiment-review', seeded.workflowId,
      '--experiment', seeded.experiment.experiment_id, '--output', maliciousOutput]));
    assert.equal(fs.existsSync(maliciousOutput), false);
    const nestedApi = { getExperimentReview: async () => ({ review: { ...value,
      performance: value.performance.map((row: object) => ({ ...row, private_path: secret })) } }) } as unknown as ApiClient;
    await assert.rejects(executeWorkflowCommand(nestedApi, ['experiment-review', seeded.workflowId,
      '--experiment', seeded.experiment.experiment_id, '--output', maliciousOutput]));
    assert.equal(fs.existsSync(maliciousOutput), false);
    const output = path.join(f.root, 'review.json');
    const exported = await runFixtureCli(f.url, f.token, ['workflow', 'experiment-review', seeded.workflowId,
      '--experiment', seeded.experiment.experiment_id, '--output', output, '--json']);
    assert.equal(exported.code, 0, exported.stderr);
    const bytes = fs.readFileSync(output), receipt = JSON.parse(exported.stdout);
    assert.equal(receipt.sha256, hash(bytes));
    assert.equal(receipt.review, 'REVIEW_REQUIRED');
    assert.equal(bytes.toString().includes(secret), false);
    const verified = await runFixtureCli(f.url, f.token, ['evidence', 'verify-experiment-review', output, '--sha256', receipt.sha256, '--json']);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).recalculation, 'NOT_AVAILABLE');
    const wrongHash = await runFixtureCli(f.url, f.token, ['evidence', 'verify-experiment-review', output, '--sha256', '0'.repeat(64), '--json']);
    assert.notEqual(wrongHash.code, 0);
    assert.equal(JSON.parse(wrongHash.stderr).code, 'EXPERIMENT_REVIEW_VERIFICATION_FAILED');
    const collision = await runFixtureCli(f.url, f.token, ['workflow', 'experiment-review', seeded.workflowId,
      '--experiment', seeded.experiment.experiment_id, '--output', output, '--json']);
    assert.notEqual(collision.code, 0);
    assert.deepEqual(fs.readFileSync(output), bytes);
    assert.deepEqual(f.store.getExperiment(seeded.experiment.experiment_id), before);
    assert.deepEqual(f.store.listMeasurements(seeded.experiment.experiment_id), beforeRows);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    db.prepare(`WITH RECURSIVE seq(n) AS (VALUES (1) UNION ALL SELECT n+1 FROM seq WHERE n < 19999)
      INSERT INTO optimization_measurements (measurement_id, experiment_id, kind, name, role, sample_index, record_json, recorded_at)
      SELECT 'bulk:' || n, ?, 'PERFORMANCE_SAMPLE', 'hidden', 'BASELINE', 0, ?, ? FROM seq`)
      .run(seeded.experiment.experiment_id, JSON.stringify(raw), raw.recorded_at);
    const overflow = await fetch(`${f.url}/v1/workflows/${encodeURIComponent(seeded.workflowId)}/experiments/${encodeURIComponent(seeded.experiment.experiment_id)}/review`,
      { headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(overflow.status, 409);
    const overflowText = await overflow.text();
    assert.equal(overflowText.includes(secret), false);
    assert.equal(f.store.listMeasurements(seeded.experiment.experiment_id).length, 20_001);
  } finally { await f.close(); }
});

test('failed complete samples can be recalculated without promoting the recorded verdict; duplicates and mismatched plans stay unresolved', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const original = f.store.getExperiment(facts.first.experiment_id)!;
    const failedId = new OptimizationRuntime(f.store).startExperiment({ taskId: original.task_id, candidateId: original.candidate_id,
      type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' }).experiment_id;
    const failed: Experiment = { ...original, experiment_id: failedId, failure_category: 'PERFORMANCE_REGRESSION',
      evaluation: { ...original.evaluation!, performance: 'FAILED' } };
    f.store.saveExperiment(failed);
    const rows = f.store.listMeasurements(original.experiment_id);
    for (const row of rows) f.store.appendMeasurement({ ...row, measurement_id: `measurement:${randomUUID()}`, experiment_id: failedId,
      value: row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'CANDIDATE' ? (row.value as number) * 4 : row.value });
    const source = f.store.readExperimentReviewSnapshot(seeded.workflowId, failedId)!;
    const result = experimentReview(source);
    assert.equal(result.consistency.plan, 'AVAILABLE');
    assert.equal(result.consistency.candidate_task_link, 'CONSISTENT');
    assert.equal(result.recorded.execution, 'SUCCEEDED');
    assert.equal(result.recorded.correctness, 'PASSED');
    assert.equal(result.recorded.performance, 'FAILED');
    assert.equal(result.calculation.status, 'COMPUTED');
    assert.equal('verdict' in result.calculation && result.calculation.verdict, 'FAILED');
    assert.equal(result.performance.length, 18);
    assert.ok(!JSON.stringify(result).includes(original.experiment_id));
    assert.ok(!JSON.stringify(result).includes(facts.evaluatorRoot));
    assert.ok(!JSON.stringify(result).includes(failed.baseline.digest!));
    const candidate = result.performance.find(row => row.role === 'CANDIDATE')!;
    assert.equal(candidate.planned, 'YES');
    assert.equal(candidate.workload, 'W001');
    const api = new ApiClient(f.url, { token: f.token });
    const apiReview = await api.getExperimentReview(seeded.workflowId, failedId);
    assert.equal((apiReview.review.calculation as { status: string }).status, 'COMPUTED');
    const output = path.join(f.root, 'failed-review.json');
    const exported = await runFixtureCli(f.url, f.token, ['workflow', 'experiment-review', seeded.workflowId,
      '--experiment', failedId, '--output', output, '--json']);
    assert.equal(exported.code, 0, exported.stderr);
    const bytes = fs.readFileSync(output), receipt = JSON.parse(exported.stdout);
    const verified = await runFixtureCli(f.url, f.token, ['evidence', 'verify-experiment-review', output, '--sha256', receipt.sha256, '--json']);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).recalculation, 'MATCH');
    const corrupt = (mutate: (doc: any) => void) => {
      const doc = JSON.parse(bytes.toString()); mutate(doc);
      const modified = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      fs.writeFileSync(output, modified);
      assert.throws(() => verifyExperimentReview(output, hash(modified)));
    };
    corrupt(doc => doc.performance.pop());
    corrupt(doc => { doc.calculation.weighted_geomean *= 2; });
    corrupt(doc => { doc.performance.forEach((row: any) => { if (row.role === 'CANDIDATE') row.value *= 3; }); });
    corrupt(doc => { doc.plan.sampling.private_secret = 'sensitive'; });
    corrupt(doc => { doc.plan.statistics.method = 'not-supported'; });
    corrupt(doc => { doc.other_measurement_count = 20_001; });
    const duplicateKey = Buffer.from(bytes.toString().replace('"review": "REVIEW_REQUIRED",', '"review": "REVIEW_REQUIRED",\n  "review": "REVIEW_REQUIRED",'));
    fs.writeFileSync(output, duplicateKey);
    assert.throws(() => verifyExperimentReview(output, hash(duplicateKey)));
    const deeplyNested = Buffer.from('['.repeat(100) + '0' + ']'.repeat(100));
    fs.writeFileSync(output, deeplyNested);
    assert.throws(() => verifyExperimentReview(output, hash(deeplyNested)));
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    fs.writeFileSync(output, oversized);
    assert.throws(() => verifyExperimentReview(output, hash(oversized)));
    const wrongBaseline = experimentReview({ ...source, measurements: source.measurements.map(row =>
      row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'BASELINE' ? { ...row,
        domain_payload: { ...row.domain_payload, artifact_identity: { sha256: 'b'.repeat(64) } } } : row) });
    assert.equal(wrongBaseline.calculation.status, 'NOT_COMPUTED');
    assert.equal(wrongBaseline.calculation.reason, 'SAMPLE_CONTEXT_MISMATCH');
    const mixedBenchmark = experimentReview({ ...source, measurements: source.measurements.map(row =>
      row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'CANDIDATE' ? { ...row,
        domain_payload: { ...row.domain_payload, benchmark_identity: { sha256: 'c'.repeat(64) } } } : row) });
    assert.equal(mixedBenchmark.calculation.status, 'NOT_COMPUTED');
    assert.equal(mixedBenchmark.calculation.reason, 'SAMPLE_CONTEXT_MISMATCH');
    const changingRecord = experimentReview({ ...source, experiment: { ...source.experiment,
      evaluation: { ...source.experiment.evaluation!, performance: 'INCONCLUSIVE' } } });
    assert.equal(changingRecord.recorded.performance, 'INCONCLUSIVE');
    assert.equal(changingRecord.calculation.status, 'NOT_COMPUTED');
    assert.equal(changingRecord.calculation.reason, 'STATISTICAL_RECORD_MISMATCH');
    const partial = experimentReview({ ...source, experiment: { ...source.experiment, status: 'UNKNOWN', evaluation: null }, measurements: source.measurements.slice(0, 1) });
    assert.equal(partial.recorded.execution, 'UNKNOWN');
    assert.equal(partial.calculation.status, 'NOT_COMPUTED');
    assert.equal(partial.calculation.reason, 'EXPERIMENT_NOT_TERMINAL');
    f.store.appendMeasurement({ ...rows.find(row => row.kind === 'PERFORMANCE_SAMPLE')!, measurement_id: `measurement:${randomUUID()}`, experiment_id: failedId });
    const duplicated = experimentReview(f.store.readExperimentReviewSnapshot(seeded.workflowId, failedId)!);
    assert.equal(duplicated.performance.length, 19);
    assert.equal(duplicated.calculation.status, 'NOT_COMPUTED');
    assert.equal(duplicated.calculation.reason, 'SAMPLES_MISSING_OR_INVALID');
    const extra = { ...rows.find(row => row.kind === 'PERFORMANCE_SAMPLE')!, experiment_id: failedId, subject_id: '/private/unplanned' };
    const unplanned = experimentReview({ ...source, measurements: [...source.measurements, extra, extra] });
    const unknown = unplanned.performance.filter(row => row.workload === 'U001');
    assert.equal(unknown.length, 2);
    assert.ok(unknown.every(row => row.planned === 'NO'));
    assert.equal(unplanned.calculation.status, 'NOT_COMPUTED');
    assert.equal(JSON.stringify(unplanned).includes('/private/unplanned'), false);
    const planPath = facts.workflow.testpack_snapshot_path!;
    const originalPlan = fs.readFileSync(planPath);
    const altered = JSON.parse(originalPlan.toString()); altered.testpack.performance.sampling.samples++;
    fs.writeFileSync(planPath, JSON.stringify(altered));
    const mismatched = experimentReview(f.store.readExperimentReviewSnapshot(seeded.workflowId, failedId)!);
    assert.equal(mismatched.consistency.plan, 'MISMATCH');
    assert.equal(mismatched.plan, null);
    assert.equal(mismatched.calculation.reason, 'PLAN_UNAVAILABLE');
    assert.equal(mismatched.recorded.performance, 'FAILED');
    assert.equal(mismatched.performance.length, 19);
    fs.writeFileSync(planPath, originalPlan);
    const missingCandidate = experimentReview({ ...source, candidate: null });
    assert.equal(missingCandidate.consistency.candidate_task_link, 'MISSING');
    assert.equal(missingCandidate.calculation.reason, 'CANDIDATE_IDENTITY_UNAVAILABLE');
    const wrongCandidate = experimentReview({ ...source, candidate: { ...source.candidate!, task_id: 'task:other' } });
    assert.equal(wrongCandidate.consistency.candidate_task_link, 'MISMATCH');
    assert.equal(wrongCandidate.calculation.reason, 'CANDIDATE_IDENTITY_UNAVAILABLE');
    const extraPlan = JSON.parse(originalPlan.toString());
    extraPlan.testpack.performance.sampling.private_field = 'private-sampling-secret';
    extraPlan.testpack.performance.thresholds.private_field = 'private-threshold-secret';
    extraPlan.digest = validationTestpackDigest(extraPlan.testpack);
    fs.writeFileSync(planPath, JSON.stringify(extraPlan));
    const workflow = f.service.get(seeded.workflowId)!; workflow.testpack_digest = extraPlan.digest;
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify(workflow));
    const whitelisted = experimentReview(f.store.readExperimentReviewSnapshot(seeded.workflowId, failedId)!);
    assert.equal(whitelisted.consistency.plan, 'AVAILABLE');
    assert.equal(JSON.stringify(whitelisted).includes('private-sampling-secret'), false);
    assert.equal(JSON.stringify(whitelisted).includes('private-threshold-secret'), false);
    extraPlan.testpack.performance.statistics.method = 'unsupported-future-method';
    extraPlan.digest = validationTestpackDigest(extraPlan.testpack);
    fs.writeFileSync(planPath, JSON.stringify(extraPlan));
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify({ ...workflow, testpack_digest: extraPlan.digest }));
    const unknownPolicy = experimentReview(f.store.readExperimentReviewSnapshot(seeded.workflowId, failedId)!);
    assert.equal(unknownPolicy.consistency.plan, 'AVAILABLE');
    assert.equal(unknownPolicy.plan?.statistics, null);
    assert.equal(unknownPolicy.calculation.reason, 'STATISTICS_POLICY_UNAVAILABLE');
  } finally { await f.close(); }
});

test('unconfirmed statistical result stays inconclusive and verifies offline', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId, { twoWorkloads: true });
    const original = f.store.getExperiment(facts.first.experiment_id)!;
    const source = f.store.readExperimentReviewSnapshot(seeded.workflowId, original.experiment_id)!;
    const changed = { ...source, experiment: { ...source.experiment,
      evaluation: { ...source.experiment.evaluation!, performance: 'INCONCLUSIVE' as const } },
      measurements: source.measurements.map(row => row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'CANDIDATE'
        ? { ...row, value: (row.sample_index ?? 0) % 2 ? 20 : 5 } : row) };
    const review = experimentReview(changed);
    assert.equal(review.calculation.status, 'COMPUTED');
    assert.equal('verdict' in review.calculation && review.calculation.verdict, 'INCONCLUSIVE');
    const bytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`), output = path.join(f.root, 'inconclusive.json');
    fs.writeFileSync(output, bytes);
    assert.equal(verifyExperimentReview(output, hash(bytes)).recalculation, 'MATCH');
    const otherBenchmark = experimentReview({ ...changed, measurements: changed.measurements.map(row =>
      row.kind === 'PERFORMANCE_SAMPLE' && row.subject_id === 'workload-2' ? { ...row,
        domain_payload: { ...row.domain_payload, benchmark_identity: { sha256: 'c'.repeat(64) } } } : row) });
    assert.equal(otherBenchmark.calculation.reason, 'SAMPLE_CONTEXT_MISMATCH');
    const planPath = facts.workflow.testpack_snapshot_path!;
    const originalPlan = fs.readFileSync(planPath);
    const frozen = JSON.parse(originalPlan.toString());
    frozen.testpack.performance.cases[1].case_id = 'formal.workload-1';
    frozen.testpack.performance.key_cases[1] = 'formal.workload-1';
    frozen.digest = validationTestpackDigest(frozen.testpack);
    fs.writeFileSync(planPath, JSON.stringify(frozen));
    const ambiguous = experimentReview({ ...changed, workflow: { ...changed.workflow, testpack_digest: frozen.digest },
      experiment: { ...changed.experiment, type: 'REVALIDATION' },
      measurements: changed.measurements.map(row => row.subject_id === 'workload-2' ? { ...row, subject_id: 'formal.workload-1' } : row) });
    const unknown = ambiguous.performance.filter(row => row.planned === 'UNKNOWN');
    assert.ok(unknown.length > 0);
    assert.ok(unknown.every(row => row.workload.startsWith('U') && row.prefix === 'UNKNOWN'));
    assert.equal(ambiguous.calculation.status, 'NOT_COMPUTED');
    fs.writeFileSync(planPath, originalPlan);
    // An unchanged passing source may not be promoted from a recorded failure.
    const inconsistent = experimentReview({ ...source, experiment: { ...source.experiment,
      evaluation: { ...source.experiment.evaluation!, performance: 'FAILED' } } });
    assert.equal(inconsistent.calculation.status, 'NOT_COMPUTED');
    assert.equal(inconsistent.calculation.reason, 'STATISTICAL_RECORD_MISMATCH');
  } finally { await f.close(); }
});
