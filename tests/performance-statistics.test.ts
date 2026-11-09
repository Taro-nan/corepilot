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
  assert.equal(result.gate_version, 4); assert.equal(result.passed, true);
  assert.deepEqual(result.statistics?.overall_interval, { lower: 2, upper: 2 });
  assert.equal(result.workloads[0].conclusion, 'IMPROVED');
  assert.deepEqual(evaluatePerformanceGate(pack(), input), result);
  assert.equal(result.statistics?.sample_digest.length, 64);
  const changed = pack(); changed.performance.statistics = { ...DEFAULT_STATISTICS, seed: 42 };
  assert.notEqual(evaluatePerformanceGate(changed, input).statistics?.sample_digest, result.statistics?.sample_digest);
});

test('versioned target failures distinguish a missed target from regression and preserve v3 semantics', () => {
  const current = pack(12);
  current.performance.cases.forEach(row => { row.weight = 1; });
  current.performance.thresholds = { weighted_geomean_min: 1, overall_ci_lower_min: 1.1, key_case_ci_lower_min: 0.9, confidence_level: 0.95 };
  const data = measurements(12, 1);
  data[0].baseline_samples = Array(12).fill(1.2); data[0].candidate_samples = Array(12).fill(1);
  data[1].baseline_samples = Array(12).fill(1); data[1].candidate_samples = Array(12).fill(1);
  const next = evaluatePerformanceGate(current, data);
  assert.equal(next.gate_version, 4);
  assert.equal(next.statistics?.verdict, 'FAILED');
  assert.ok(next.statistics!.overall_interval!.upper < 1.1);
  assert.equal(next.statistics?.comparison, 'IMPROVED');
  assert.equal(next.workloads.every(row => !row.regression), true);
  assert.match(next.reason, /未达到固定验收线；未确认性能退化/);

  const legacy = structuredClone(current);
  legacy.performance.statistics = { ...DEFAULT_STATISTICS, method: 'paired-block-bootstrap-v1' };
  const old = evaluatePerformanceGate(legacy, data);
  assert.equal(old.gate_version, 3);
  assert.equal(old.statistics?.verdict, 'INCONCLUSIVE');
  assert.equal(old.statistics?.comparison, undefined);
  assert.notEqual(old.statistics?.sample_digest, next.statistics?.sample_digest);
  const oldPass = evaluatePerformanceGate(legacy, measurements(12, 2));
  assert.equal(oldPass.gate_version, 3); assert.equal(oldPass.statistics?.verdict, 'PASSED');
  const oldFailure = evaluatePerformanceGate(legacy, measurements(12, 0.8));
  assert.equal(oldFailure.gate_version, 3); assert.equal(oldFailure.statistics?.verdict, 'FAILED');
});

test('v4 calls a proven slowdown a regression but still follows a permissive frozen target', () => {
  const testpack = pack(12);
  testpack.performance.thresholds = { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 };
  const slower = measurements(12, 0.9);
  const rejected = evaluatePerformanceGate(testpack, slower);
  assert.equal(rejected.statistics?.verdict, 'FAILED');
  assert.equal(rejected.statistics?.comparison, 'REGRESSED');
  assert.equal(rejected.workloads.every(row => row.regression), true);
  assert.match(rejected.reason, /性能退化/);
  testpack.performance.thresholds = { weighted_geomean_min: 0.8, overall_ci_lower_min: 0.8, key_case_ci_lower_min: 0.8, confidence_level: 0.95 };
  const permitted = evaluatePerformanceGate(testpack, slower);
  assert.equal(permitted.passed, true, 'the confirmed policy permits this regression');
  assert.equal(permitted.statistics?.comparison, 'REGRESSED');
  assert.equal(permitted.workloads.every(row => row.regression), true, 'the report must still show the slowdown');
});

test('v4 leaves a confidence interval crossing the required target inconclusive', () => {
  const testpack = pack(12);
  testpack.performance.thresholds = { weighted_geomean_min: 1.1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 };
  const data = measurements(12, 1);
  for (const row of data) {
    row.baseline_samples = Array(12).fill(1);
    row.candidate_samples = Array.from({ length: 12 }, (_, index) => index < 6 ? 1 : 1 / 1.3);
  }
  const result = evaluatePerformanceGate(testpack, data);
  assert.equal(result.statistics?.verdict, 'INCONCLUSIVE');
  assert.ok(result.statistics!.overall_interval!.lower < 1.1);
  assert.ok(result.statistics!.overall_interval!.upper > 1.1);
  assert.equal(result.passed, false);
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
  const invalid = measurements(12, 1); invalid[0].candidate_samples.pop();
  assert.equal(calibratePerformance(pack(), invalid).status, 'INVALID');
});

test('non-representable intermediate statistics cannot be reported as an A/A equality or a performance verdict', () => {
  const overflow = measurements(12, 1).map(row => ({ ...row,
    baseline_samples: Array(12).fill(1e308), candidate_samples: Array(12).fill(1e308) }));
  const calibration = calibratePerformance(pack(), overflow);
  assert.equal(calibration.status, 'INVALID');
  assert.equal(calibration.statistics.overall_interval, null);

  const underflow = measurements(12, 1).map(row => ({ ...row,
    baseline_samples: Array(12).fill(1e-300), candidate_samples: Array(12).fill(1e300) }));
  const result = evaluatePerformanceGate(pack(), underflow);
  assert.equal(result.statistics?.verdict, 'INVALID');
  assert.equal(result.passed, false);
  assert.equal(result.overall_ci_lower, null);

  // The original median is finite, but some bootstrap blocks select only the
  // extreme tail: their paired ratio exceeds the finite number range.
  const extremeTail = measurements(12, 1).map(row => ({ ...row,
    baseline_samples: [...Array(7).fill(1), ...Array(5).fill(1e200)],
    candidate_samples: [...Array(7).fill(1), ...Array(5).fill(1e-200)] }));
  const resampled = evaluatePerformanceGate(pack(), extremeTail);
  assert.equal(resampled.statistics?.verdict, 'INVALID');
  assert.equal(resampled.statistics?.overall_interval, null);
});
