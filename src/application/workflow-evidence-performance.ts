import type { Experiment, Measurement } from '../contracts/optimization-domain.js';
import type { ValidationTestpack } from '../contracts/validation-testpack.js';
import { evaluatePerformanceGate, type PerformanceCaseMeasurement, type PerformanceWorkloadResult } from '../workspace/validation-runner.js';

/** Recompute each recorded gate against that experiment's persisted samples before a new freeze. */
export function assertPerformanceEvidenceConsistent(experiment: Experiment, rows: readonly Measurement[], testpack: ValidationTestpack): void {
  const fail = (): never => {
    throw new Error(`${experiment.type} 的原始性能样本、冻结测试方案与已保存的性能结论不一致或信息不足，无法准备批准证据。请核对原实验并重新验证。`);
  };
  const evaluation = experiment.evaluation;
  const storedGate = evaluation?.details?.performance_gate as Record<string, unknown> | null | undefined;
  const version = testpack.performance.statistics ? 3 : 2;
  if (!storedGate || storedGate.gate_version !== version || storedGate.passed !== true) return fail();
  const gate = storedGate;

  // First validation stores a compact gate plus workload summaries. Revalidation
  // stores the complete gate instead. Do not use one experiment's rows for another.
  const storedWorkloads = (experiment.type === 'REVALIDATION' ? gate.workloads : evaluation?.performance_workloads) as
    Array<Record<string, unknown>> | undefined;
  const cases = testpack.performance.cases;
  if (!Array.isArray(storedWorkloads) || storedWorkloads.length !== cases.length ||
      storedWorkloads.some(row => !row || typeof row !== 'object' || Array.isArray(row)) ||
      new Set(storedWorkloads.map(row => row?.case_id ?? row?.workload_id)).size !== cases.length) return fail();
  const saved = storedWorkloads;
  const count = testpack.performance.sampling.samples;
  const samples = rows.filter(row => row.kind === 'PERFORMANCE_SAMPLE');
  // No unrelated workload, role or second prefix may be silently excluded
  // from an approval claim. One consistent legacy "formal." prefix is allowed.
  if (samples.length !== cases.length * count * 2) return fail();
  const prefixes = experiment.type === 'REVALIDATION' ? ['', 'formal.'] : [''];
  const prefix = prefixes.find(value => cases.every(spec => (['BASELINE', 'CANDIDATE'] as const).every(role =>
    samples.filter(row => row.subject_id === value + spec.case_id && row.role === role).length === count)));
  if (prefix === undefined) fail();

  const measurements: PerformanceCaseMeasurement[] = cases.map(spec => {
    const stored = saved.find(row => (row.case_id ?? row.workload_id) === spec.case_id);
    if (!stored) return fail();
    const values = (role: 'BASELINE' | 'CANDIDATE') => {
      const selected = samples.filter(row => row.subject_id === prefix + spec.case_id && row.role === role)
        .sort((a, b) => (a.sample_index ?? -1) - (b.sample_index ?? -1));
      if (selected.length !== count || selected.some((row, index) => row.experiment_id !== experiment.experiment_id ||
        row.sample_index !== index || row.validity !== 'VALID' || typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value <= 0)) fail();
      return selected.map(row => row.value as number);
    };
    const baseline = values('BASELINE'), candidate = values('CANDIDATE');
    if (!sameSamples(stored.baseline_samples, baseline) || !sameSamples(stored.candidate_samples, candidate)) fail();
    // v2 permitted a separately supplied lower bound. Preserve it as an input;
    // these samples alone cannot establish that bound's statistical validity.
    if (version === 2 && stored.ci_lower !== undefined && (typeof stored.ci_lower !== 'number' || !Number.isFinite(stored.ci_lower))) fail();
    return { case_id: spec.case_id, baseline_samples: baseline, candidate_samples: candidate,
      sample_indices: { baseline: baseline.map((_, index) => index), candidate: candidate.map((_, index) => index) },
      ...(version === 2 && typeof stored.ci_lower === 'number' ? { ci_lower: stored.ci_lower } : {}) };
  });

  const recomputed = evaluatePerformanceGate(testpack, measurements);
  if (!recomputed.passed || gate.passed !== recomputed.passed || !sameNumber(gate.weighted_geomean, recomputed.weighted_geomean) ||
      !sameNumber(gate.overall_ci_lower, recomputed.overall_ci_lower) || !sameNumber(gate.key_case_ci_lower, recomputed.key_case_ci_lower)) fail();
  for (const result of recomputed.workloads) {
    const stored = saved.find(row => (row.case_id ?? row.workload_id) === result.case_id)!;
    if (!sameWorkload(stored, result)) fail();
  }
  if (version === 3) {
    const recorded = gate.statistics as Record<string, unknown> | undefined;
    const actual = recomputed.statistics;
    // Earlier callers could supply raw arrays without explicit indices. Both
    // encodings identify the same verified 0..N-1 rows; no conclusion is changed.
    const withoutIndices = measurements.map(({ sample_indices: _indices, ...rest }) => rest);
    const alternateDigest = recorded?.sample_digest === actual?.sample_digest ? undefined
      : evaluatePerformanceGate(testpack, withoutIndices).statistics?.sample_digest;
    const originalInterval = recorded?.overall_interval as Record<string, unknown> | undefined;
    if (!recorded || !actual || recorded.verdict !== actual.verdict ||
        (recorded.sample_digest !== actual.sample_digest && recorded.sample_digest !== alternateDigest) ||
        !samePolicy(recorded.policy, actual.policy) || recorded.resampling_unit !== actual.resampling_unit ||
        recorded.case_interval_adjustment !== actual.case_interval_adjustment ||
        !sameNumber(recorded.worst_case_lower, actual.worst_case_lower) ||
        !originalInterval || !actual.overall_interval || !sameNumber(originalInterval.lower, actual.overall_interval.lower) ||
        !sameNumber(originalInterval.upper, actual.overall_interval.upper)) fail();
  }
}

function samePolicy(left: unknown, right: object): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const policy = left as Record<string, unknown>;
  return Object.entries(right).every(([key, value]) => policy[key] === value);
}

function sameSamples(value: unknown, actual: readonly number[]): boolean {
  return Array.isArray(value) && value.length === actual.length && value.every((item, index) => item === actual[index]);
}

function sameNumber(left: unknown, right: number | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return typeof left === 'number' && Number.isFinite(left) && Number.isFinite(right) &&
    (left === right || Math.abs(left - right) <= 1e-12 * Math.max(Math.abs(left), Math.abs(right)));
}

function sameWorkload(saved: Record<string, unknown>, result: PerformanceWorkloadResult): boolean {
  return sameNumber(saved.baseline_median, result.baseline_median) && sameNumber(saved.candidate_median, result.candidate_median) &&
    sameNumber(saved.speedup, result.speedup) && saved.critical === result.critical && saved.regression === result.regression &&
    sameNumber(saved.ci_lower, result.ci_lower) && sameNumber(saved.ci_upper, result.ci_upper) && saved.conclusion === result.conclusion;
}
