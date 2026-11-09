import type { Measurement } from '../contracts/optimization-domain.js';
import type { TestingTaskRecord, TestingSummary, TestingComparison } from '../contracts/testing.js';
import { evaluateStatisticalPerformance } from '../evaluator/performance-statistics.js';

const median = (input: number[]) => { const values = [...input].sort((a, b) => a - b), index = values.length >> 1;
  return values.length % 2 ? values[index] : (values[index - 1] + values[index]) / 2; };

/** Derived view only: execution completion never implies correctness, speedup or approval. */
export function summarizeTestingTask(task: TestingTaskRecord, measurements: Measurement[]): TestingSummary {
  const caseIds = task.input.mode === 'performance' ? [] : task.plan.cases.map(row => row.case_id);
  const failed: string[] = [], missing: string[] = [], invalid: string[] = []; let passed = 0;
  for (const id of caseIds) {
    const matches = measurements.filter(row => row.kind === 'CORRECTNESS_CASE' && row.subject_id === id && row.role === 'EVALUATOR' && row.sample_index === null);
    if (!matches.length) missing.push(id);
    else if (matches.length !== 1 || matches[0].validity !== 'VALID' || matches[0].unit !== null || !['PASS', 'FAIL'].includes(String(matches[0].value))) invalid.push(id);
    else if (matches[0].value === 'FAIL') failed.push(id); else passed++;
  }
  if (task.input.mode !== 'performance' && measurements.some(row => row.kind === 'CORRECTNESS_CASE' &&
    (!caseIds.includes(row.subject_id) || row.role !== 'EVALUATOR' || row.sample_index !== null))) invalid.push('unexpected-correctness-observation');
  const requestedPerformance = task.input.mode !== 'correctness';
  const count = task.plan.test_plan.sampling.sample_count;
  const specs = requestedPerformance ? task.plan.workloads : [];
  const issues: string[] = [];
  const comparisons: TestingComparison[] = specs.map(spec => {
    let bad = false;
    const samples = (role: 'BASELINE' | 'CANDIDATE') => {
      const rows = measurements.filter(row => row.kind === 'PERFORMANCE_SAMPLE' && row.subject_id === spec.workload_id && row.role === role);
      const seen = new Set<number>(); const valid: Array<{ index: number; value: number }> = [];
      for (const row of rows) {
        if (row.sample_index === null || row.sample_index < 0 || row.sample_index >= count || seen.has(row.sample_index)
          || row.validity !== 'VALID' || row.unit !== 'seconds' || typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value <= 0) bad = true;
        else { seen.add(row.sample_index); valid.push({ index: row.sample_index, value: row.value }); }
      }
      return valid.sort((a, b) => a.index - b.index).map(row => row.value);
    };
    const baseline = samples('BASELINE'), candidate = samples('CANDIDATE');
    const complete = !bad && baseline.length === count && candidate.length === count;
    if (bad) issues.push(`无效或重复采样：${spec.workload_id}`);
    return { workload_id: spec.workload_id, parameters: spec.parameters, threads: spec.threads, critical: spec.critical,
      baseline_samples: baseline, candidate_samples: candidate, baseline_median: complete ? median(baseline) : null,
      candidate_median: complete ? median(candidate) : null, speedup: complete ? median(baseline) / median(candidate) : null,
      interval: null, conclusion: bad ? 'INVALID' : baseline.length || candidate.length ? 'INCONCLUSIVE' : 'NOT_MEASURED' };
  });
  if (requestedPerformance && measurements.some(row => row.kind === 'PERFORMANCE_SAMPLE' && (!specs.some(spec => spec.workload_id === row.subject_id) || !['BASELINE', 'CANDIDATE'].includes(row.role ?? '')))) issues.push('出现未声明的性能样本。');
  const measured = comparisons.reduce((sum, row) => sum + row.baseline_samples.length + row.candidate_samples.length, 0);
  const planned = specs.length * count * 2;
  const complete = planned > 0 && comparisons.every(row => row.speedup !== null) && !issues.length;
  let speedup: number | null = null;
  let interval: TestingSummary['performance']['interval'] = null;
  let status: TestingSummary['performance']['status'] = !requestedPerformance ? 'NOT_REQUESTED' : issues.length ? 'INVALID'
    : !measured ? 'NOT_MEASURED' : !complete ? 'INCOMPLETE' : 'INCONCLUSIVE';
  if (complete) {
    const weights = specs.reduce((sum, spec) => sum + spec.weight, 0);
    speedup = Math.exp(comparisons.reduce((sum, row, i) => sum + Math.log(row.speedup!) * specs[i].weight, 0) / weights);
    const policy = task.plan.test_plan.statistics;
    if (!policy) issues.push('测试方案未声明统计规则；仅报告中位数比值，不给出提升或退化结论。');
    else {
      const result = evaluateStatisticalPerformance({ performance: { statistics: policy,
        cases: specs.map(spec => ({ case_id: spec.workload_id, parameters: spec.parameters, threads: spec.threads, critical: spec.critical, weight: spec.weight })),
        sampling: { warmup: task.plan.test_plan.sampling.warmup_count, samples: count, interleave_seed: task.plan.test_plan.seed, bootstrap_iterations: policy.iterations },
        thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: policy.confidence_level }, key_cases: specs.filter(spec => spec.critical).map(spec => spec.workload_id) } },
        comparisons.map(row => ({ case_id: row.workload_id, baseline_samples: row.baseline_samples, candidate_samples: row.candidate_samples,
          sample_indices: { baseline: Array.from({ length: count }, (_, i) => i), candidate: Array.from({ length: count }, (_, i) => i) } })));
      interval = result.statistics?.overall_interval ?? null;
      issues.push(...(result.statistics?.issues ?? []));
      for (const row of comparisons) {
        const estimate = result.workloads.find(item => item.case_id === row.workload_id);
        if (estimate?.ci_lower !== undefined && estimate.ci_upper !== undefined) row.interval = { lower: estimate.ci_lower, upper: estimate.ci_upper };
        row.conclusion = estimate?.conclusion ?? 'INCONCLUSIVE';
      }
      status = result.statistics?.verdict === 'INVALID' ? 'INVALID'
        : comparisons.some(row => row.critical && row.conclusion === 'REGRESSED') || (interval && interval.upper < 1) ? 'REGRESSED'
        : interval && interval.lower > 1 ? 'IMPROVED' : 'INCONCLUSIVE';
    }
  }
  return { correctness: { status: task.input.mode === 'performance' ? 'NOT_REQUESTED' : invalid.length ? 'INVALID' : failed.length ? 'FAILED'
      : !passed ? 'NOT_MEASURED' : missing.length ? 'INCOMPLETE' : 'PASSED', planned: caseIds.length, passed, failed: failed.length, missing, invalid },
    performance: { status, planned, measured, speedup, interval, issues }, comparisons,
    conclusion_scope: '仅适用于本次固定的两端版本、测试方案、目标机器及资源条件；独立测试不是正式优化证据，也不代表获批或已交付。' };
}
