import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { evaluatePerformanceGate, parsePerformanceMeasurements } from '../src/workspace/validation-runner.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { calibratePerformance } from '../src/evaluator/performance-statistics.js';

function pack(count = 12): ValidationTestpack {
  return { performance: { cases: [{ case_id: 'small', weight: 1, critical: false, threads: 1 }, { case_id: 'large', weight: 3, critical: true, threads: 1 }],
    key_cases: ['large'], sampling: { samples: count, warmup: 0, bootstrap_iterations: 4000, interleave_seed: 0 }, statistics: DEFAULT_STATISTICS,
    thresholds: { weighted_geomean_min: 1.02, overall_ci_lower_min: 0.98, key_case_ci_lower_min: 0.99, confidence_level: 0.95 } } } as ValidationTestpack;
}
const measurements = (n: number, ratio: number) => ['small', 'large'].map(case_id => ({ case_id,
  baseline_samples: Array.from({ length: n }, (_, i) => 1 + i * .1), candidate_samples: Array.from({ length: n }, (_, i) => (1 + i * .1) / ratio) }));

test('statistics computes the fixed-weight aggregate interval and reproducible sample identity; supplied lower bounds cannot override samples', () => {
  const input = measurements(12, 2).map(row => ({ ...row, ci_lower: 0.01 }));
  const result = evaluatePerformanceGate(pack(), input);
  assert.equal(result.gate_version, 3); assert.equal(result.passed, true);
  assert.deepEqual(result.statistics?.overall_interval, { lower: 2, upper: 2 });
  assert.equal(result.workloads[0].conclusion, 'IMPROVED');
  assert.deepEqual(evaluatePerformanceGate(pack(), input), result);
  assert.equal(result.statistics?.sample_digest.length, 64);
  const changed = pack(); changed.performance.statistics = { ...DEFAULT_STATISTICS, seed: 42 };
  assert.notEqual(evaluatePerformanceGate(changed, input).statistics?.sample_digest, result.statistics?.sample_digest);
});

test('A/A control does not claim an improvement and case regression cannot be hidden behind aggregate speedup', () => {
  const aa = evaluatePerformanceGate(pack(), measurements(12, 1));
  assert.equal(aa.passed, false); assert.equal(aa.workloads[0].conclusion, 'INCONCLUSIVE');
  const mixed = measurements(12, 2); mixed[0].candidate_samples = mixed[0].baseline_samples.map(value => value * 2);
  const result = evaluatePerformanceGate(pack(), mixed);
  assert.ok(result.weighted_geomean > 1); assert.equal(result.passed, false);
  assert.equal(result.statistics?.verdict, 'FAILED'); assert.equal(result.workloads[0].regression, true);
});

test('too few samples is inconclusive; missing pairs, duplicate inventories and invalid values are invalid', () => {
  const few = evaluatePerformanceGate(pack(3), measurements(3, 2));
  assert.equal(few.statistics?.verdict, 'INCONCLUSIVE'); assert.equal(few.overall_ci_lower, null); assert.equal(few.passed, false);
  const missing = measurements(12, 2); missing[0].candidate_samples.pop();
  assert.equal(evaluatePerformanceGate(pack(), missing).statistics?.verdict, 'INVALID');
  assert.equal(evaluatePerformanceGate(pack(), [...measurements(12, 2), measurements(12, 2)[0]]).statistics?.verdict, 'INVALID');
  const bad = measurements(12, 2); bad[0].baseline_samples[0] = NaN;
  assert.equal(evaluatePerformanceGate(pack(), bad).statistics?.verdict, 'INVALID');
});

test('paired drift stays paired and noise crossing the target is not promoted to a pass', () => {
  const policy = pack(20); policy.performance.thresholds.weighted_geomean_min = 1.1;
  const data = measurements(20, 1.1); data[0].candidate_samples = Array.from({ length: 20 }, (_, i) => i < 10 ? 1 : 5);
  const result = evaluatePerformanceGate(policy, data);
  assert.equal(result.passed, false); assert.ok(result.statistics?.overall_interval);
});

test('structured samples retain gaps and duplicates instead of silently re-pairing shifted sample identities', () => {
  const raw = ['small', 'large'].flatMap(id => ['BASELINE', 'CANDIDATE'].flatMap(role => Array.from({ length: 12 }, (_, i) =>
    'COREPILOT_MEASUREMENT ' + JSON.stringify({ kind: 'PERFORMANCE_SAMPLE', subject_id: id, role, sample_index: role === 'CANDIDATE' && i === 11 ? 10 : i,
      value: role === 'CANDIDATE' ? 1 : 2 })))).join('\n');
  const parsed = parsePerformanceMeasurements(raw);
  assert.equal(parsed[0].candidate_samples?.length, 12);
  const result = evaluatePerformanceGate(pack(), parsed);
  assert.equal(result.statistics?.verdict, 'INVALID');
  assert.match(result.reason!, /sample index/);
});

test('A/A calibration describes equality and bias separately from optimization acceptance', () => {
  const equal = calibratePerformance(pack(), measurements(12, 1));
  assert.equal(equal.status, 'COMPATIBLE_WITH_EQUALITY');
  assert.deepEqual(equal.statistics.overall_interval, { lower: 1, upper: 1 });
  assert.equal(calibratePerformance(pack(), measurements(12, 1.1)).status, 'BIAS_DETECTED');
  assert.equal(calibratePerformance(pack(3), measurements(3, 1)).status, 'INSUFFICIENT');
});
