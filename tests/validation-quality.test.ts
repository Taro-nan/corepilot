import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseValidationQuality, validationQualityResult } from '../src/evaluator/validation-quality.js';
import { startWebFixture } from './web-fixture.js';
import { prepareReviewFixture } from './validation-review-fixture.js';
import type { Measurement } from '../src/contracts/optimization-domain.js';

test('semantic coverage counts logical inputs once and rejects unsupported inputs or escaped probe artifacts', () => {
  const plan = { schema_version: 1, coverage: [{ dimension: 'tail', input_ids: ['tail'], rationale: '17 elements', status: 'COVERED' }],
    probes: [{ probe_id: 'missing-tail', defect: 'ignores element 17', artifact: 'sensitivity/tail.so', input_ids: ['tail'] }] };
  const parsed = parseValidationQuality(plan, ['tail']);
  const result = validationQualityResult(parsed, [{ input_id: 'tail' }, { input_id: 'tail' }], []);
  assert.equal(result.logical_inputs, 1); assert.equal(result.correctness_executions, 2); assert.equal(result.status, 'PENDING');
  assert.throws(() => parseValidationQuality(plan, ['other']), /覆盖|错误/);
  assert.throws(() => parseValidationQuality({ ...plan, probes: [{ ...plan.probes[0], artifact: 'sensitivity/../actual.so' }] }), /错误实现/);
  const invalid = { kind: 'OBSERVATION', unit: null, validity: 'INVALID', value: 'DETECTED', domain_payload: { classification: 'TEST_SENSITIVITY', probe_id: 'missing-tail', input_id: 'tail' } } as Measurement;
  assert.equal(validationQualityResult(parsed, [{ input_id: 'tail' }], [invalid]).status, 'PENDING');
});

test('shared review API blocks a self-passing evaluator and stores a version-bound sensitivity receipt only after actual FAIL evidence', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f);
  try {
    const before = f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target);
    const draft = f.projects.validationAssets.save(r.project, r.pkg, r.version, r.target, { ...before, expected_digest: before.evaluator_digest, source: 'edited',
      quality: { schema_version: 1, coverage: [{ dimension: 'numeric output', input_ids: ['kernel-check'], rationale: 'compare actual value with independent reference', status: 'COVERED' }],
        probes: [{ probe_id: 'zero-output', defect: 'returns zero', artifact: 'sensitivity/zero.so', input_ids: ['kernel-check'] }] } });
    const filename = path.join(f.dataDir, 'projects', r.project.project_id, 'validation-trials', r.trialId.slice(11) + '.json');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
    record.evaluator_digest = draft.evaluator_digest; record.quality = draft.quality;
    record.correctness_inputs = [{ input_id: 'kernel-check' }]; fs.writeFileSync(filename, JSON.stringify(record));
    const review = () => f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    assert.equal((await review()).state, 'BLOCKED');
    const observation = { experiment_id: 'validation:other', kind: 'OBSERVATION', role: 'EVALUATOR', subject_id: 'sensitivity:zero-output:kernel-check', sample_index: null,
      value: 'DETECTED', unit: null, validity: 'VALID', domain_payload: { classification: 'TEST_SENSITIVITY', probe_id: 'zero-output', input_id: 'kernel-check', original_verdict: 'FAIL' } };
    r.state.measurements.push(observation as typeof r.state.measurements[number]);
    const foreign = await review(); assert.equal(foreign.state, 'BLOCKED'); assert.equal(foreign.quality?.status, 'PENDING');
    observation.experiment_id = r.trialId;
    const unverified = await review();
    assert.equal(unverified.state, 'BLOCKED');
    assert.ok(unverified.blockers.some(message => message.includes('Runner 库路径核对')));
    const input = '/fixture/sensitivity/zero.so', fileId = { device: '1', inode: '43' };
    const resolvedPath = { field: 'resolved_symbol_path', path: input, realpath: input, file_id: { device: '1', inode: '44' } };
    Object.assign(observation.domain_payload, {
      artifact_identity: { input_path: input, resolved_symbol_path: input, sha256: 'b'.repeat(64) },
      runner_artifact_path_check: { planned_path: input, input_realpath: input, input_file_id: fileId,
        reported_paths: [{ field: 'input_path', path: input, realpath: input, file_id: fileId },
          resolvedPath] },
    });
    const conflicting = await review();
    assert.equal(conflicting.state, 'BLOCKED');
    assert.ok(conflicting.blockers.some(message => message.includes('Runner 库路径核对')));
    resolvedPath.file_id = fileId;
    const ready = await review(); assert.equal(ready.state, 'READY_FOR_REVIEW'); assert.equal(ready.quality?.status, 'PASSED');
    const accepted = await f.projects.validationReview.approve(r.project, r.pkg, r.version, r.target, { expected_digest: ready.evaluator_digest,
      expected_package_digest: ready.package_digest, trial_id: r.trialId, reviewer: 'Fixture owner', confirm: true });
    assert.equal(accepted.quality?.status, 'PASSED'); assert.equal(accepted.evaluator_digest, draft.evaluator_digest);
  } finally { await r.close(); await f.close(); }
});
