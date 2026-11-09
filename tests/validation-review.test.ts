import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ApiClient } from '../src/client/api-client.js';
import type { ValidationReview } from '../src/contracts/validation-review.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { prepareReviewFixture } from './validation-review-fixture.js';

test('passed target trial becomes usable only after an explicit, version-bound human review through the shared API/CLI', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const setup = await f.projects.setupStatus(r.project.project_id);
    assert.equal(setup.validation?.review?.state, 'READY_FOR_REVIEW');
    const review = await api.projectAction(r.project.project_id, r.endpoint) as ValidationReview;
    assert.equal(review.state, 'READY_FOR_REVIEW');
    assert.equal(f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target).qualification, 'DRAFT');
    const decision = { expected_digest: review.evaluator_digest, expected_package_digest: review.package_digest,
      trial_id: r.trialId, reviewer: 'Fixture maintainer', confirm: true };
    await assert.rejects(api.projectAction(r.project.project_id, r.endpoint, { ...decision, confirm: false }), /明确确认/);
    await assert.rejects(api.projectAction(r.project.project_id, r.endpoint, { ...decision, expected_digest: '0'.repeat(64) }), /已变化/);
    const filename = path.join(f.root, 'human-review.json'); fs.writeFileSync(filename, JSON.stringify({ ...review, reviewer: decision.reviewer, confirm: true }));
    const cli = await runFixtureCli(f.url, f.token, ['project', 'validation-review', r.project.project_id, r.pkg, r.version, r.target, '--file', filename]);
    assert.equal(cli.code, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).state, 'QUALIFIED');
    const qualified = f.projects.packageLoader.resolveSelection({ package_id: r.pkg, package_version: r.version, target_id: r.target }, { requireQualified: true });
    assert.equal(qualified.bundle.content_digest, review.evaluator_digest, 'review changes the attestation, never the tested code');
    assert.equal(qualified.bundle.qualification.reviewer, decision.reviewer);
    assert.equal(qualified.bundle.qualification.qualification_run.run_id, r.trialId);
    assert.equal(qualified.loaded.manifest.qualification.state, 'QUALIFIED');
    const receipt = path.join(qualified.loaded.root, 'onboarding', `validation-review-${r.target}`);
    const raw = fs.readFileSync(path.join(receipt, 'measurements.json'));
    assert.equal(createHash('sha256').update(raw).digest('hex'), qualified.bundle.qualification.evidence.raw_measurements_sha256);
    assert.equal(JSON.parse(fs.readFileSync(path.join(receipt, 'report.json'), 'utf8')).formal_evidence, false);
    assert.equal((await f.projects.check(r.project.project_id)).function_name, 'kernel');
    assert.equal((await api.projectAction(r.project.project_id, r.endpoint, decision) as ValidationReview).state, 'QUALIFIED', 'replaying the same human decision is idempotent');
    assert.equal(r.record.purpose, 'VALIDATION_DRAFT'); assert.equal(f.service.list().length, 0);
    assert.equal(f.modelRequests.validationBodies.length, 0);
  } finally { await r.close(); await f.close(); }
});

test('missing samples, invalid resource observations and edits after a trial remain actionable review blockers', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const preview = () => f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    r.state.measurements.pop();
    assert.equal((await preview()).state, 'BLOCKED');
    r.state.commandValidity = 'INVALID';
    assert.match((await preview()).blockers.join(' '), /CPU 和 NUMA/);
    const draft = f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target);
    f.projects.validationAssets.save(r.project, r.pkg, r.version, r.target, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      test_plan: { ...draft.test_plan, seed: 123 } });
    assert.match((await preview()).blockers.join(' '), /条件或代码/);
    assert.equal(f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target).qualification, 'DRAFT');
  } finally { await r.close(); await f.close(); }
});

test('review refuses conflicting, duplicate, foreign and unplanned trial measurements', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const preview = () => api.projectAction(r.project.project_id, r.endpoint) as Promise<ValidationReview>;
    const status = () => api.projectAction(r.project.project_id, `validation-trials/${encodeURIComponent(r.trialId)}`) as Promise<{
      passed: boolean; summary: { issues: string[]; comparisons: Array<{ speedup: number | null }> }; measurements: unknown[] }>;
    const initial = await preview();
    assert.equal(initial.state, 'READY_FOR_REVIEW');
    const original = structuredClone(r.state.measurements);
    const check = async (message: RegExp) => {
      const result = await status();
      assert.equal(result.passed, false);
      assert.match(result.summary.issues.join(' '), message);
      assert.equal(result.measurements.length, r.state.measurements.length, 'raw records remain available');
      const review = await preview();
      assert.equal(review.state, 'BLOCKED');
      await assert.rejects(api.projectAction(r.project.project_id, r.endpoint, { expected_digest: initial.evaluator_digest,
        expected_package_digest: initial.package_digest, trial_id: r.trialId, reviewer: 'Fixture maintainer', confirm: true }), /尚未完整通过/);
      assert.equal(f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target).qualification, 'DRAFT');
    };
    r.state.measurements.push({ ...original[0], value: 'FAIL' });
    await check(/正确性测量无效、重复/);
    r.state.measurements = structuredClone(original);
    r.state.measurements.push({ ...original[1], value: 99 });
    await check(/性能样本无效、重复/);
    assert.equal((await status()).summary.comparisons[0].speedup, null, 'a duplicate cannot be hidden by a selected subset');
    r.state.measurements = structuredClone(original);
    r.state.measurements[1].experiment_id = 'validation:other';
    await check(/实验身份不匹配/);
    r.state.measurements = structuredClone(original);
    r.state.measurements.push({ ...original[1], sample_index: 99 });
    await check(/不属于本次固定测试计划/);
    r.state.measurements = structuredClone(original);
    Object.assign(r.state.measurements[0], { sample_index: undefined });
    await check(/不属于本次固定测试计划/);
    r.state.measurements = structuredClone(original);
    assert.equal((await preview()).state, 'READY_FOR_REVIEW', 'no history or qualification is rewritten');
  } finally { await r.close(); await f.close(); }
});

test('reviewing one function leaves other functions editable and unqualified', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f, true).catch(async error => { await f.close(); throw error; });
  try {
    const review = await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    await f.projects.validationReview.approve(r.project, r.pkg, r.version, r.target, { expected_digest: review.evaluator_digest,
      expected_package_digest: review.package_digest, trial_id: r.trialId, reviewer: 'Target owner', confirm: true });
    const other = r.resolved.loaded.manifest.targets.find(target => target.target_id !== r.target)!;
    const draft = f.projects.validationAssets.get(r.project, r.pkg, r.version, other.target_id);
    assert.equal(draft.qualification, 'DRAFT');
    const updated = f.projects.validationAssets.save(r.project, r.pkg, r.version, other.target_id, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest });
    assert.equal(updated.qualification, 'DRAFT');
    const current = f.projects.packageLoader.loadPackage(r.pkg, r.version);
    assert.equal(current.manifest.qualification.state, 'REVIEWED');
    assert.equal(f.projects.catalog().find(item => item.package_id === r.pkg)!.targets.find(item => item.target_id === r.target)!.evaluator.qualification, 'QUALIFIED');
  } finally { await r.close(); await f.close(); }
});
