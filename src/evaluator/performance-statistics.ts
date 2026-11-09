import { createHash } from 'node:crypto';
import type { PerformanceStatisticsPolicy, ConfidenceInterval, PerformanceCalibration } from '../contracts/performance-statistics.js';
import type { ValidationTestpack } from '../contracts/validation-testpack.js';
import type { PerformanceCaseMeasurement, PerformanceGateResult, PerformanceWorkloadResult } from '../workspace/validation-runner.js';

export function parseStatisticsPolicy(value: unknown): PerformanceStatisticsPolicy {
  const raw = value as PerformanceStatisticsPolicy;
  if (!raw || raw.method !== 'paired-block-bootstrap-v1' || !Number.isFinite(raw.confidence_level) || raw.confidence_level < 0.8 || raw.confidence_level > 0.99
    || !Number.isInteger(raw.iterations) || raw.iterations < 1000 || raw.iterations > 20000 || !Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 4294967295
    || !Number.isInteger(raw.min_samples) || raw.min_samples < 9 || raw.min_samples > 100 || !Number.isInteger(raw.block_length) || raw.block_length < 1 || raw.block_length > raw.min_samples) throw new Error('统计方案需要 9..100 个最少样本、1000..20000 次重采样及有效置信水平/seed/分块长度');
  return { method: raw.method, confidence_level: raw.confidence_level, iterations: raw.iterations, seed: raw.seed, block_length: raw.block_length, min_samples: raw.min_samples };
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const index = sorted.length >> 1; return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2; };
function random(seed: number) { let state = seed >>> 0; return () => { state += 0x6D2B79F5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function interval(values: number[], alpha: number): ConfidenceInterval {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (q: number) => { const p = q * (sorted.length - 1), i = Math.floor(p); return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (p - i); };
  return { lower: quantile(alpha / 2), upper: quantile(1 - alpha / 2) };
}

/** Fixed-sample, paired moving-block bootstrap. Never pools different workloads or validation rounds. */
type StatisticalInput = { performance: Pick<ValidationTestpack['performance'], 'statistics' | 'cases' | 'sampling' | 'thresholds' | 'key_cases'> };
export function evaluateStatisticalPerformance(testpack: StatisticalInput, input: readonly PerformanceCaseMeasurement[]): PerformanceGateResult {
  const policy = parseStatisticsPolicy(testpack.performance.statistics);
  const issues: string[] = [], workloads: PerformanceWorkloadResult[] = [], declared = testpack.performance.cases;
  const seen = new Set<string>(); let invalid = false, insufficient = false;
  for (const row of input) {
    if (!declared.some(item => item.case_id === row.case_id) || seen.has(row.case_id)) { issues.push(`undeclared or duplicate workload: ${row.case_id}`); invalid = true; }
    seen.add(row.case_id);
  }
  for (const spec of declared) {
    const row = input.find(item => item.case_id === spec.case_id), baseline = row?.baseline_samples ?? [], candidate = row?.candidate_samples ?? [];
    if (row?.sample_indices && [row.sample_indices.baseline, row.sample_indices.candidate].some(indices => indices.length !== testpack.performance.sampling.samples || indices.some((index, i) => index !== i))) {
      issues.push(`missing or duplicate sample index: ${spec.case_id}`); invalid = true;
    }
    if (!row || baseline.length !== testpack.performance.sampling.samples || candidate.length !== baseline.length || [...baseline, ...candidate].some(value => !Number.isFinite(value) || value <= 0)) {
      issues.push(`missing or invalid paired samples: ${spec.case_id}`); invalid = true; continue;
    }
    if (baseline.length < policy.min_samples) { issues.push(`${spec.case_id}: ${baseline.length} samples; frozen plan requires at least ${policy.min_samples}`); insufficient = true; }
    const bm = median(baseline), cm = median(candidate);
    workloads.push({ case_id: spec.case_id, baseline_samples: [...baseline], candidate_samples: [...candidate], baseline_median: bm, candidate_median: cm,
      speedup: bm / cm, critical: spec.critical || testpack.performance.key_cases.includes(spec.case_id), regression: false });
  }
  const weightTotal = declared.reduce((sum, row) => sum + row.weight, 0);
  if (!workloads.length || weightTotal <= 0 || !Number.isFinite(weightTotal)) { issues.push('No positive-weight complete workload inventory'); invalid = true; }
  const geomean = (values: number[]) => Math.exp(values.reduce((sum, value, i) => sum + Math.log(value) * declared[i].weight, 0) / weightTotal);
  const weighted = workloads.length === declared.length && weightTotal > 0 ? geomean(workloads.map(row => row.speedup)) : 0;
  const sampleDigest = createHash('sha256').update(JSON.stringify({ policy, declared, samples: workloads.map(row => ({ id: row.case_id, baseline: row.baseline_samples, candidate: row.candidate_samples,
    ...(input.find(item => item.case_id === row.case_id)?.sample_indices ? { indices: input.find(item => item.case_id === row.case_id)!.sample_indices } : {}) })) })).digest('hex');
  const thresholds = testpack.performance.thresholds;
  const statistics: NonNullable<PerformanceGateResult['statistics']> = { policy, verdict: invalid ? 'INVALID' : 'INCONCLUSIVE', overall_interval: null,
    worst_case_lower: null, issues, sample_digest: sampleDigest, resampling_unit: 'consecutive paired process samples within each workload', case_interval_adjustment: 'Bonferroni across declared workloads' };
  if (!invalid && !insufficient) {
    const rng = random(policy.seed), distributions = workloads.map(() => [] as number[]), totals: number[] = [];
    for (let iteration = 0; iteration < policy.iterations; iteration++) {
      const ratios = workloads.map((row, index) => {
        const n = row.baseline_samples.length, indices: number[] = [];
        while (indices.length < n) { const start = Math.floor(rng() * n); for (let b = 0; b < policy.block_length && indices.length < n; b++) indices.push((start + b) % n); }
        const ratio = median(indices.map(i => row.baseline_samples[i])) / median(indices.map(i => row.candidate_samples[i]));
        distributions[index].push(ratio); return ratio;
      });
      totals.push(geomean(ratios));
    }
    const alpha = 1 - policy.confidence_level;
    statistics.overall_interval = interval(totals, alpha);
    workloads.forEach((row, index) => {
      const ci = interval(distributions[index], alpha / workloads.length);
      row.ci_lower = ci.lower; row.ci_upper = ci.upper;
      row.regression = ci.upper < (row.critical ? thresholds.key_case_ci_lower_min : thresholds.overall_ci_lower_min);
      row.conclusion = ci.lower > 1 ? 'IMPROVED' : ci.upper < 1 ? 'REGRESSED' : 'INCONCLUSIVE';
    });
    statistics.worst_case_lower = Math.min(...workloads.map(row => row.ci_lower!));
    const passes = weighted >= thresholds.weighted_geomean_min && statistics.overall_interval.lower >= Math.max(thresholds.weighted_geomean_min, thresholds.overall_ci_lower_min)
      && workloads.every(row => row.ci_lower! >= thresholds.overall_ci_lower_min && (!row.critical || row.ci_lower! >= thresholds.key_case_ci_lower_min));
    const fails = statistics.overall_interval.upper < thresholds.weighted_geomean_min || workloads.some(row => row.regression);
    statistics.verdict = passes ? 'PASSED' : fails ? 'FAILED' : 'INCONCLUSIVE';
  }
  const critical = workloads.filter(row => row.critical);
  return { gate_version: 3, passed: statistics.verdict === 'PASSED', weighted_geomean: weighted,
    overall_ci_lower: statistics.overall_interval?.lower ?? null, key_case_ci_lower: critical.length && critical.every(row => row.ci_lower !== undefined) ? Math.min(...critical.map(row => row.ci_lower!)) : null,
    case_ratios: Object.fromEntries(workloads.map(row => [row.case_id, row.speedup])), workloads, statistics,
    reason: issues.length ? `性能证据不足或无效：${issues.join('; ')}` : statistics.verdict === 'PASSED' ? '统计区间与全部负载通过固定验收线'
      : statistics.verdict === 'FAILED' ? '统计区间确认存在未达到目标或退化的负载' : '区间跨越验收线，当前证据不足；保留候选。调整采样方案需新版本，不能重复试到通过。' };
}

/** Diagnostic equality check, separate from optimization acceptance. */
export function calibratePerformance(testpack: StatisticalInput, samples: readonly PerformanceCaseMeasurement[]): PerformanceCalibration {
  const result = evaluateStatisticalPerformance(testpack, samples), statistics = result.statistics!;
  const excludesEquality = (ci: ConfidenceInterval) => ci.lower > 1 || ci.upper < 1;
  const intervals = result.workloads.map(row => ({ workload_id: row.case_id, speedup: row.speedup,
    interval: row.ci_lower === undefined || row.ci_upper === undefined ? null : { lower: row.ci_lower, upper: row.ci_upper } }));
  return { kind: 'AA_SAME_ARTIFACT', statistics, overall_speedup: result.weighted_geomean, workloads: intervals,
    status: statistics.verdict === 'INVALID' ? 'INVALID' : !statistics.overall_interval ? 'INSUFFICIENT' : excludesEquality(statistics.overall_interval) || intervals.some(row => row.interval && excludesEquality(row.interval)) ? 'BIAS_DETECTED' : 'COMPATIBLE_WITH_EQUALITY',
    note: '同一产物在两端重复测量；区间应兼容 1×。区间很宽仍表示测量不稳定。单次 A/A 不给出经验误报率，也不构成优化收益或两库资格证据。' };
}
