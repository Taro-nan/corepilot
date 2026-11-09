import type { PerformanceStatisticsPolicy } from '../contracts/performance-statistics.js';
import type { PerformanceThresholds, ValidationSampling, ValidationTestpack } from '../contracts/validation-testpack.js';
import { evaluateStatisticalPerformance, parseStatisticsPolicy } from '../evaluator/performance-statistics.js';
import type { PerformanceGateResult } from '../workspace/validation-runner.js';

const FORMAT = 'COREPILOT_REVIEW_SAMPLES_V1';
const LIMITS = { workloads: 64, samples: 1000, workUnits: 10_000_000 };
const OMITTED = { provenance: 'NOT_INCLUDED', binaries: 'NOT_INCLUDED', evaluator: 'NOT_INCLUDED', machine: 'NOT_INCLUDED',
  parameters: 'NOT_INCLUDED', correctness: 'NOT_INCLUDED', approval: 'NOT_INCLUDED', delivery: 'NOT_INCLUDED' } as const;

type Workload = { id: string; threads: number; weight: number; critical: boolean; key: boolean };
type Samples = { workload_id: string; baseline: number[]; candidate: number[] };
type Inputs = { policy: PerformanceStatisticsPolicy; sampling: ValidationSampling; thresholds: PerformanceThresholds;
  workloads: Workload[]; formal: Samples[]; revalidation: Samples[] };
type RecordValue = Record<string, unknown>;

function invalid(): never { throw new Error('待审阅包格式、数值、统计结果或计算规模无效；请重新导出并检查来源。'); }
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as RecordValue;
};
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const id = (index: number): string => `W${String(index + 1).padStart(3, '0')}`;

function inputsFromUnknown(value: unknown): Inputs {
  const root = record(value), sampling = record(root.sampling), thresholds = record(root.thresholds);
  let policy: PerformanceStatisticsPolicy;
  try { policy = parseStatisticsPolicy(record(root.policy)); } catch { return invalid(); }
  if (!integer(sampling.warmup) || !integer(sampling.samples) || sampling.samples < policy.min_samples || sampling.samples > LIMITS.samples ||
      !integer(sampling.interleave_seed) || !integer(sampling.bootstrap_iterations) ||
      !nonnegative(thresholds.weighted_geomean_min) || !nonnegative(thresholds.overall_ci_lower_min) ||
      !nonnegative(thresholds.key_case_ci_lower_min) || !positive(thresholds.confidence_level) || thresholds.confidence_level >= 1 ||
      !Array.isArray(root.workloads) || !root.workloads.length || root.workloads.length > LIMITS.workloads ||
      root.workloads.length * sampling.samples * policy.iterations > LIMITS.workUnits) return invalid();
  const workloads = root.workloads.map((value, index): Workload => {
    const row = record(value);
    if (row.id !== id(index) || !integer(row.threads) || row.threads < 1 || !positive(row.weight) ||
        typeof row.critical !== 'boolean' || typeof row.key !== 'boolean') return invalid();
    return { id: id(index), threads: row.threads, weight: row.weight, critical: row.critical, key: row.key };
  });
  if (!Number.isFinite(workloads.reduce((sum, row) => sum + row.weight, 0))) return invalid();
  const round = (value: unknown): Samples[] => {
    const raw = record(value).samples;
    if (!Array.isArray(raw) || raw.length !== workloads.length) return invalid();
    return raw.map((value, index) => {
      const row = record(value);
      if (row.workload_id !== id(index) || !Array.isArray(row.baseline) || !Array.isArray(row.candidate) ||
          row.baseline.length !== sampling.samples || row.candidate.length !== sampling.samples ||
          [...row.baseline, ...row.candidate].some(item => !positive(item) || item > Number.MAX_VALUE / 2)) return invalid();
      return { workload_id: id(index), baseline: row.baseline as number[], candidate: row.candidate as number[] };
    });
  };
  return { policy, sampling: { warmup: sampling.warmup, samples: sampling.samples, interleave_seed: sampling.interleave_seed,
    bootstrap_iterations: sampling.bootstrap_iterations },
  thresholds: { weighted_geomean_min: thresholds.weighted_geomean_min, overall_ci_lower_min: thresholds.overall_ci_lower_min,
    key_case_ci_lower_min: thresholds.key_case_ci_lower_min, confidence_level: thresholds.confidence_level },
  workloads, formal: round(root.formal), revalidation: round(root.revalidation) };
}

function gateSummary(gate: PerformanceGateResult) {
  const stats = gate.statistics;
  if (!stats || !stats.overall_interval || !Number.isFinite(gate.weighted_geomean) ||
      !Number.isFinite(stats.overall_interval.lower) || !Number.isFinite(stats.overall_interval.upper) ||
      !Number.isFinite(stats.worst_case_lower) || !Number.isFinite(gate.overall_ci_lower) ||
      (gate.key_case_ci_lower !== null && !Number.isFinite(gate.key_case_ci_lower))) return invalid();
  const workloads = gate.workloads.map((row, index) => {
    if (![row.baseline_median, row.candidate_median, row.speedup, row.ci_lower, row.ci_upper].every(Number.isFinite) || !row.conclusion) return invalid();
    return { workload_id: id(index), baseline_median: row.baseline_median, candidate_median: row.candidate_median,
      speedup: row.speedup, critical: row.critical, regression: row.regression, ci_lower: row.ci_lower,
      ci_upper: row.ci_upper, conclusion: row.conclusion };
  });
  return { passed: gate.passed, verdict: stats.verdict, weighted_geomean: gate.weighted_geomean,
    overall_ci_lower: gate.overall_ci_lower, key_case_ci_lower: gate.key_case_ci_lower,
    overall_interval: { lower: stats.overall_interval.lower, upper: stats.overall_interval.upper },
    worst_case_lower: stats.worst_case_lower, workloads };
}

function calculate(inputs: Inputs, samples: Samples[]) {
  const cases = inputs.workloads.map(row => ({ case_id: row.id, threads: row.threads, weight: row.weight, critical: row.critical }));
  const measurements = samples.map(row => ({ case_id: row.workload_id, baseline_samples: row.baseline, candidate_samples: row.candidate,
    sample_indices: { baseline: row.baseline.map((_, index) => index), candidate: row.candidate.map((_, index) => index) } }));
  return evaluateStatisticalPerformance({ performance: { statistics: inputs.policy, sampling: inputs.sampling, thresholds: inputs.thresholds,
    cases, key_cases: inputs.workloads.filter(row => row.key).map(row => row.id) } }, measurements);
}

function projection(inputs: Inputs) {
  const formal = gateSummary(calculate(inputs, inputs.formal)), revalidation = gateSummary(calculate(inputs, inputs.revalidation));
  if (!formal.passed || formal.verdict !== 'PASSED' || !revalidation.passed || revalidation.verdict !== 'PASSED') return invalid();
  return { format: FORMAT, review: 'REVIEW_REQUIRED', omitted: OMITTED, unit: 'seconds', pairing: 'BY_SAMPLE_INDEX',
    policy: inputs.policy, sampling: inputs.sampling, thresholds: inputs.thresholds, workloads: inputs.workloads,
    formal: { samples: inputs.formal, result: formal }, revalidation: { samples: inputs.revalidation, result: revalidation } };
}

/** A whitelist projection: values, weighting and ordering only, never source IDs or original digests. */
export function createReviewSamples(testpack: ValidationTestpack, formal: PerformanceGateResult, revalidation: PerformanceGateResult) {
  const performance = testpack.performance;
  const samples = (gate: PerformanceGateResult) => gate.workloads.map((row, index) =>
    ({ workload_id: id(index), baseline: row.baseline_samples, candidate: row.candidate_samples }));
  const input = { policy: performance.statistics, sampling: performance.sampling, thresholds: performance.thresholds,
    workloads: performance.cases.map((row, index) => ({ id: id(index), threads: row.threads, weight: row.weight,
      critical: row.critical, key: performance.key_cases.includes(row.case_id) })),
    formal: { samples: samples(formal) }, revalidation: { samples: samples(revalidation) } };
  const output = projection(inputsFromUnknown(input));
  // Identity is intentionally changed; compare every numerical conclusion and never the original sample digest.
  if (JSON.stringify(output.formal.result) !== JSON.stringify(gateSummary(formal)) ||
      JSON.stringify(output.revalidation.result) !== JSON.stringify(gateSummary(revalidation))) return invalid();
  return output;
}

function sameResult(expected: unknown, actual: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual) &&
    (expected === actual || Math.abs(expected - actual) <= 1e-12 * Math.max(Math.abs(expected), Math.abs(actual)));
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length &&
    expected.every((value, index) => sameResult(value, actual[index]));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const left = expected as RecordValue, right = actual as RecordValue, keys = Object.keys(left), actualKeys = Object.keys(right);
    return keys.length === actualKeys.length && keys.every((key, index) => key === actualKeys[index] && sameResult(left[key], right[key]));
  }
  return expected === actual;
}

/** Strict canonical bytes prevent duplicate keys and hidden fields; numerical conclusions allow ordinary rounding variation. */
export function verifyReviewSamplesBytes(bytes: Buffer) {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return invalid(); }
  const output = projection(inputsFromUnknown(value));
  const source = record(value), formal = record(source.formal), revalidation = record(source.revalidation);
  if (!sameResult(output.formal.result, formal.result) || !sameResult(output.revalidation.result, revalidation.result)) return invalid();
  const canonical = { ...output, formal: { samples: output.formal.samples, result: formal.result },
    revalidation: { samples: output.revalidation.samples, result: revalidation.result } };
  if (!bytes.equals(Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8'))) return invalid();
  return output;
}
