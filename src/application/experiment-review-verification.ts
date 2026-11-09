import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { evaluateStatisticalPerformance, parseStatisticsPolicy } from '../evaluator/performance-statistics.js';
import { EXPERIMENT_RECALC_NOTICE, EXPERIMENT_REVIEW_FORMAT, EXPERIMENT_REVIEW_NOTICE } from './experiment-review.js';

const invalid = (): never => { throw new Error('单实验数值包格式、摘要、规模或重算结果无效；请核对原文件和来源。'); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, names: string[]): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).length !== names.length || names.some(key => !Object.hasOwn(value, key))) return invalid();
  return value;
};
const oneOf = (value: unknown, values: readonly unknown[]) => values.includes(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => finite(value) && value > 0;
const id = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}[0-9]{3}$`).test(value);
const reasonCodes = ['PLAN_UNAVAILABLE', 'STATISTICS_POLICY_UNAVAILABLE', 'CANDIDATE_IDENTITY_UNAVAILABLE', 'CANDIDATE_SOURCE_UNAVAILABLE',
  'EXPERIMENT_NOT_TERMINAL', 'RECORDED_PERFORMANCE_NOT_COMPARABLE', 'INSUFFICIENT_OR_OVER_LIMIT', 'EXECUTION_PLAN_UNAVAILABLE',
  'EXECUTION_PLAN_MISMATCH', 'SAMPLES_MISSING_OR_INVALID', 'SAMPLE_PREFIX_MISMATCH', 'SAMPLE_CONTEXT_UNAVAILABLE',
  'SAMPLE_CONTEXT_MISMATCH', 'NUMERICAL_CALCULATION_INVALID', 'STATISTICAL_RECORD_MISMATCH'] as const;

function same(left: unknown, right: unknown): boolean {
  if (typeof left === 'number') return finite(right) && (left === right || Math.abs(left - right) <= 1e-12 * Math.max(Math.abs(left), Math.abs(right)));
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((v, i) => same(v, right[i]));
  if (object(left)) return object(right) && Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(key => Object.hasOwn(right, key) && same(left[key], right[key]));
  return left === right;
}

/** Verify the file identity and, when present, independently repeat only its numerical calculation. */
export function verifyExperimentReview(filename: string, expectedSha256: string) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('必须提供通过可信渠道取得的单实验数值包 SHA-256。');
  let bytes: Buffer;
  try {
    const fd = fs.openSync(filename, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return invalid();
      bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) return invalid(); offset += n; }
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length)) return invalid();
    } finally { fs.closeSync(fd); }
  } catch { return invalid(); }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expectedSha256.toLowerCase()) throw new Error('单实验数值包 SHA-256 不匹配。');
  const result = verifyExperimentReviewBytes(bytes);
  return { ...result, sha256,
    notice: '仅核对数值包与可信摘要及可重算数值，不证明源数据、执行环境、正确性、批准或交付；分享前仍需人工审阅。' };
}

/** Validate the complete whitelist before publishing bytes from any server. */
export function verifyExperimentReviewBytes(bytes: Buffer) {
  if (bytes.length > 16 * 1024 * 1024) return invalid();
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return invalid(); }
  // Avoid recursive serialization of hostile deeply nested input. The limit
  // includes all fields of 20,000 projected measurements, not only objects.
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++visited > 500_000 || next.depth > 64) return invalid();
    if (typeof next.value === 'number' && !Number.isFinite(next.value)) return invalid();
    if (!next.value || typeof next.value !== 'object') continue;
    for (const child of Object.values(next.value)) pending.push({ value: child, depth: next.depth + 1 });
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))) return invalid();
  const root = exact(value, ['format', 'review', 'notice', 'consistency', 'recorded', 'plan', 'correctness', 'performance', 'other_measurement_count', 'calculation']);
  if (root.format !== EXPERIMENT_REVIEW_FORMAT || root.review !== 'REVIEW_REQUIRED' || root.notice !== EXPERIMENT_REVIEW_NOTICE) return invalid();
  const consistency = exact(root.consistency, ['database', 'plan', 'candidate_task_link', 'runner_synchronization', 'source_and_binary', 'machine', 'correctness_oracle', 'approval', 'delivery']);
  if (consistency.database !== 'SQLITE_READ_TRANSACTION' || !oneOf(consistency.plan, ['AVAILABLE', 'MISSING', 'MISMATCH', 'INVALID']) ||
      !oneOf(consistency.candidate_task_link, ['CONSISTENT', 'MISSING', 'MISMATCH']) || consistency.runner_synchronization !== 'NOT_PROVEN' ||
      ['source_and_binary', 'machine', 'correctness_oracle', 'approval', 'delivery'].some(key => consistency[key] !== 'NOT_INCLUDED')) return invalid();
  const recorded = exact(root.recorded, ['type', 'execution', 'validity', 'failure_category', 'build', 'correctness', 'performance']);
  if (!oneOf(recorded.type, ['FORMAL_EVALUATION', 'REVALIDATION', 'DEVELOPMENT_FEEDBACK', 'UNKNOWN']) ||
      !oneOf(recorded.execution, ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']) ||
      !oneOf(recorded.validity, ['VALID', 'INVALID', 'UNKNOWN']) ||
      !oneOf(recorded.failure_category, [null, 'BUILD_FAILURE', 'CORRECTNESS_FAILURE', 'PERFORMANCE_REGRESSION', 'PERFORMANCE_TARGET_NOT_MET',
        'INFRASTRUCTURE_FAILURE', 'RESOURCE_UNAVAILABLE', 'EVALUATOR_FAILURE', 'CANCELLED', 'AGENT_FAILURE', 'INVALID_EXPERIMENT', 'UNKNOWN']) ||
      !oneOf(recorded.build, ['PASSED', 'FAILED', 'NOT_EXECUTED', 'UNKNOWN']) ||
      !oneOf(recorded.correctness, ['PASSED', 'FAILED', 'INVALID', 'INCOMPLETE', 'NOT_EXECUTED', 'UNKNOWN']) ||
      !oneOf(recorded.performance, ['PASSED', 'FAILED', 'INVALID', 'INCONCLUSIVE', 'NOT_EXECUTED', 'UNKNOWN'])) return invalid();
  if (!Array.isArray(root.performance) || !Array.isArray(root.correctness) || !natural(root.other_measurement_count) ||
      root.performance.length + root.correctness.length + root.other_measurement_count > 20_000) return invalid();
  const samples = root.performance.map(value => {
    const row = exact(value, ['workload', 'planned', 'prefix', 'role', 'sample_index', 'sample_index_status', 'value', 'value_status', 'unit', 'validity', 'experiment_identity', 'evaluator_identity']);
    if (!id(row.workload, '[WU]') || !oneOf(row.planned, ['YES', 'NO', 'UNKNOWN']) || !oneOf(row.prefix, ['NONE', 'FORMAL', 'UNKNOWN']) ||
        !oneOf(row.role, ['BASELINE', 'CANDIDATE', 'UNKNOWN']) || !oneOf(row.validity, ['VALID', 'INVALID', 'UNKNOWN']) ||
        !oneOf(row.experiment_identity, ['MATCH', 'MISMATCH']) || !oneOf(row.evaluator_identity, ['MATCH', 'UNKNOWN_OR_MISMATCH']) ||
        !oneOf(row.unit, ['seconds', 'UNKNOWN']) ||
        !(row.sample_index === null && oneOf(row.sample_index_status, ['RECORDED_NULL', 'OMITTED_UNSUPPORTED']) || finite(row.sample_index) && row.sample_index_status === 'RECORDED_NUMBER') ||
        !(row.value === null && row.value_status === 'UNREPRESENTABLE_OR_NONNUMERIC' || finite(row.value) && row.value_status === 'RECORDED_NUMBER')) return invalid();
    return row;
  });
  for (const value of root.correctness) {
    const row = exact(value, ['case', 'planned', 'prefix', 'role', 'sample_index', 'sample_index_status', 'value', 'value_status', 'unit', 'validity', 'experiment_identity', 'evaluator_identity']);
    if (!id(row.case, '[CV]') || !oneOf(row.planned, ['YES', 'NO', 'UNKNOWN']) || !oneOf(row.prefix, ['NONE', 'FORMAL', 'UNKNOWN']) ||
        !oneOf(row.role, ['EVALUATOR', 'UNKNOWN']) || !oneOf(row.validity, ['VALID', 'INVALID', 'UNKNOWN']) ||
        !oneOf(row.experiment_identity, ['MATCH', 'MISMATCH']) || !oneOf(row.evaluator_identity, ['MATCH', 'UNKNOWN_OR_MISMATCH']) ||
        !oneOf(row.unit, ['NONE', 'UNKNOWN']) ||
        !(row.sample_index === null && oneOf(row.sample_index_status, ['RECORDED_NULL', 'OMITTED_UNSUPPORTED']) || finite(row.sample_index) && row.sample_index_status === 'RECORDED_NUMBER') ||
        !(row.value === null && row.value_status === 'OMITTED_UNSUPPORTED' || oneOf(row.value, [true, false, 'PASS', 'FAIL']) && row.value_status === 'RECORDED')) return invalid();
  }
  let plan: Record<string, unknown> | null = null;
  if (root.plan !== null) {
    plan = exact(root.plan, ['sampling', 'thresholds', 'statistics', 'workloads', 'correctness_case_count']);
    const sampling = exact(plan.sampling, ['warmup', 'samples', 'interleave_seed', 'bootstrap_iterations']);
    const thresholds = exact(plan.thresholds, ['weighted_geomean_min', 'overall_ci_lower_min', 'key_case_ci_lower_min', 'confidence_level']);
    if (!natural(sampling.warmup) || !natural(sampling.samples) || sampling.samples > 1000 || !natural(sampling.interleave_seed) ||
        !natural(sampling.bootstrap_iterations) || !natural(plan.correctness_case_count) || plan.correctness_case_count > 256 ||
        !finite(thresholds.weighted_geomean_min) || thresholds.weighted_geomean_min < 0 || !finite(thresholds.overall_ci_lower_min) || thresholds.overall_ci_lower_min < 0 ||
        !finite(thresholds.key_case_ci_lower_min) || thresholds.key_case_ci_lower_min < 0 || !positive(thresholds.confidence_level) || thresholds.confidence_level >= 1 ||
        !Array.isArray(plan.workloads) || plan.workloads.length > 64) return invalid();
    plan.workloads.forEach((value, index) => {
      const row = exact(value, ['id', 'threads', 'weight', 'critical', 'key']);
      if (row.id !== `W${String(index + 1).padStart(3, '0')}` || !natural(row.threads) || row.threads < 1 || !positive(row.weight) ||
          typeof row.critical !== 'boolean' || typeof row.key !== 'boolean') invalid();
    });
    if (plan.statistics !== null) {
      exact(plan.statistics, ['method', 'confidence_level', 'iterations', 'seed', 'block_length', 'min_samples']);
      try { parseStatisticsPolicy(plan.statistics); } catch { return invalid(); }
    }
  }
  if ((consistency.plan === 'AVAILABLE') !== !!plan) return invalid();
  const calculation = object(root.calculation) ? root.calculation : invalid();
  let recalculation: 'MATCH' | 'NOT_AVAILABLE' = 'NOT_AVAILABLE';
  if (calculation.status === 'NOT_COMPUTED') {
    exact(calculation, ['status', 'reason']);
    if (!oneOf(calculation.reason, reasonCodes)) return invalid();
  } else if (calculation.status === 'COMPUTED') {
    exact(calculation, ['status', 'notice', 'verdict', 'weighted_geomean', 'overall_interval', 'workloads']);
    if (!plan || !plan.statistics || !Array.isArray(plan.workloads) || !plan.workloads.length ||
        consistency.candidate_task_link !== 'CONSISTENT' || !oneOf(recorded.performance, ['FAILED', 'INCONCLUSIVE']) ||
        !oneOf(recorded.execution, ['SUCCEEDED', 'FAILED', 'CANCELLED']) || calculation.notice !== EXPERIMENT_RECALC_NOTICE ||
        calculation.verdict !== recorded.performance) return invalid();
    const sampling = plan.sampling as { warmup: number; samples: number; interleave_seed: number; bootstrap_iterations: number };
    const thresholds = plan.thresholds as { weighted_geomean_min: number; overall_ci_lower_min: number; key_case_ci_lower_min: number; confidence_level: number };
    const policy = parseStatisticsPolicy(plan.statistics);
    if (sampling.samples < policy.min_samples || plan.workloads.length * sampling.samples * policy.iterations > 10_000_000 ||
        samples.length !== plan.workloads.length * sampling.samples * 2) return invalid();
    const prefixes = new Set(samples.map(row => row.prefix));
    if (prefixes.size !== 1 || prefixes.has('UNKNOWN')) return invalid();
    const workloads = plan.workloads as Array<{ id: string; threads: number; weight: number; critical: boolean; key: boolean }>;
    const measurements = workloads.map(workload => {
      const role = (which: string) => {
        const rows = samples.filter(row => row.workload === workload.id && row.role === which).sort((a, b) => (a.sample_index as number) - (b.sample_index as number));
        if (rows.length !== sampling.samples || rows.some((row, index) => row.sample_index !== index || row.planned !== 'YES' ||
          row.unit !== 'seconds' || row.validity !== 'VALID' || row.experiment_identity !== 'MATCH' || row.evaluator_identity !== 'MATCH' || !positive(row.value))) return invalid();
        return rows.map(row => row.value as number);
      };
      const baseline = role('BASELINE'), candidate = role('CANDIDATE');
      return { case_id: workload.id, baseline_samples: baseline, candidate_samples: candidate,
        sample_indices: { baseline: baseline.map((_, index) => index), candidate: candidate.map((_, index) => index) } };
    });
    const gate = evaluateStatisticalPerformance({ performance: { sampling, thresholds, statistics: policy,
      cases: workloads.map(row => ({ case_id: row.id, threads: row.threads, weight: row.weight, critical: row.critical })),
      key_cases: workloads.filter(row => row.key).map(row => row.id) } }, measurements);
    if (!gate.statistics || gate.statistics.verdict !== recorded.performance) return invalid();
    const interval = gate.statistics.overall_interval;
    const actual = { status: 'COMPUTED', notice: EXPERIMENT_RECALC_NOTICE, verdict: recorded.performance,
      weighted_geomean: Number.isFinite(gate.weighted_geomean) ? gate.weighted_geomean : null,
      overall_interval: interval && Number.isFinite(interval.lower) && Number.isFinite(interval.upper) ? interval : null,
      workloads: gate.workloads.map(row => ({ id: row.case_id, speedup: Number.isFinite(row.speedup) ? row.speedup : null,
        ci_lower: Number.isFinite(row.ci_lower) ? row.ci_lower : null, ci_upper: Number.isFinite(row.ci_upper) ? row.ci_upper : null,
        conclusion: row.conclusion ?? 'UNKNOWN' })) };
    if (!same(actual, calculation)) return invalid();
    recalculation = 'MATCH';
  } else return invalid();
  return { format: EXPERIMENT_REVIEW_FORMAT, review: 'REVIEW_REQUIRED', recalculation };
}
