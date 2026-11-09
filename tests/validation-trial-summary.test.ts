import assert from 'node:assert/strict';
import test from 'node:test';
import type { Measurement } from '../src/contracts/optimization-domain.js';
import type { ValidationTestPlan } from '../src/contracts/validation-assets.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { trialSummary } from '../src/application/validation-trial-summary.js';

test('A/A cannot claim compatibility when the trial contains an unplanned observation', () => {
  const record = { trial_id: 'validation:calibration', mode: 'calibration' as const, case_ids: [], workload_ids: ['small'],
    test_plan: { sampling: { warmup_count: 0, sample_count: 9 }, seed: 0, statistics: DEFAULT_STATISTICS } as ValidationTestPlan,
    workload_specs: [{ case_id: 'small', threads: 1, critical: false, weight: 1 }] };
  const samples: Measurement[] = (['BASELINE', 'CANDIDATE'] as const).flatMap(role => Array.from({ length: 9 }, (_, index) => ({
    schema_version: 1 as const, measurement_id: `${role}-${index}`, experiment_id: record.trial_id, evaluator: null,
    kind: 'PERFORMANCE_SAMPLE' as const, role, subject_id: 'small', sample_index: index, value: 1, unit: 'seconds',
    validity: 'VALID' as const, domain_payload: {}, recorded_at: '2026-01-01T00:00:00.000Z',
  })));
  assert.equal(trialSummary(record, samples).calibration?.status, 'COMPATIBLE_WITH_EQUALITY');
  const result = trialSummary(record, [...samples, { ...samples[0], measurement_id: 'unexpected', subject_id: 'other' }]);
  assert.equal(result.calibration?.status, 'INVALID');
  assert.equal(result.calibration?.statistics.overall_interval, null);
  assert.equal(result.calibration?.statistics.verdict, 'INVALID');
  assert.match(result.issues.join(' '), /不属于本次固定测试计划/);
});

test('A/A and comparison summaries expose non-representable arithmetic and retain the original samples', () => {
  const record = { trial_id: 'validation:extreme', mode: 'calibration' as const, case_ids: [], workload_ids: ['small'],
    test_plan: { sampling: { warmup_count: 0, sample_count: 12 }, seed: 0, statistics: DEFAULT_STATISTICS } as ValidationTestPlan,
    workload_specs: [{ case_id: 'small', threads: 1, critical: false, weight: 1 }] };
  const samples: Measurement[] = (['BASELINE', 'CANDIDATE'] as const).flatMap(role => Array.from({ length: 12 }, (_, index) => ({
    schema_version: 1 as const, measurement_id: `${role}-${index}`, experiment_id: record.trial_id, evaluator: null,
    kind: 'PERFORMANCE_SAMPLE' as const, role, subject_id: 'small', sample_index: index, value: 1e308, unit: 'seconds',
    validity: 'VALID' as const, domain_payload: {}, recorded_at: '2026-01-01T00:00:00.000Z',
  })));
  const aa = trialSummary(record, samples);
  assert.equal(aa.performance.measured, 24);
  assert.equal(aa.calibration?.status, 'INVALID');
  assert.ok(aa.issues.length);
  assert.equal(aa.comparisons[0].speedup, null);
  assert.deepEqual(aa.comparisons[0].baseline_samples, Array(12).fill(1e308));
  const comparison = trialSummary({ ...record, mode: 'comparison' }, samples);
  assert.ok(comparison.issues.length);
  assert.equal(comparison.comparisons[0].baseline_median, null);
  assert.equal(comparison.comparisons[0].speedup, null);

  const extremeTail = samples.map(row => ({ ...row, value: row.sample_index! < 7 ? 1 : row.role === 'BASELINE' ? 1e200 : 1e-200 }));
  const bootstrap = trialSummary(record, extremeTail);
  assert.equal(bootstrap.calibration?.status, 'INVALID');
  assert.ok(bootstrap.issues.length, 'an invalid bootstrap must block a successful trial summary');
});
