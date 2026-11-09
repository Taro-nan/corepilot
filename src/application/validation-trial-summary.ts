import type { Measurement } from '../contracts/optimization-domain.js';
import type { ValidationTestPlan } from '../contracts/validation-assets.js';
import type { ValidationCase } from '../contracts/validation-testpack.js';
import type { ValidationQualityPlan } from '../contracts/validation-quality.js';
import { calibratePerformance } from '../evaluator/performance-statistics.js';
import { validationQualityResult } from '../evaluator/validation-quality.js';

type TrialSummaryInput = {
  trial_id: string;
  mode?: 'correctness' | 'comparison' | 'smoke' | 'calibration';
  case_ids: string[];
  workload_ids: string[];
  test_plan?: ValidationTestPlan;
  quality?: ValidationQualityPlan;
  correctness_inputs?: Array<{ input_id: string }>;
  workload_specs?: ValidationCase[];
  workload_conditions?: Array<{ workload_id: string; input_id: string; profile_name: string; threads: number; cpu_set: string; numa_node: number; omp_proc_bind?: 'close' | 'spread' }>;
};

type Slot = { id: string; key: string; observations: Measurement[] };
const key = (kind: string, subject: string, role: string | null, index: number | null) => JSON.stringify([kind, subject, role, index]);
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Check the complete trial inventory without hiding duplicate or unplanned observations. */
export function trialSummary(record: TrialSummaryInput, measurements: Measurement[]) {
  const slots = new Map<string, Slot>();
  const add = (id: string, kind: string, subject: string, role: string, index: number | null) => {
    const slot = { id, key: key(kind, subject, role, index), observations: [] as Measurement[] };
    slots.set(slot.key, slot);
    return slot;
  };
  const correctness = record.case_ids.map(id => add(id, 'CORRECTNESS_CASE', id, 'EVALUATOR', null));
  const sampleCount = record.test_plan?.sampling.sample_count ?? 1;
  const roles = record.mode === 'comparison' || record.mode === 'calibration' ? ['BASELINE', 'CANDIDATE'] : ['CANDIDATE'];
  const performance = record.workload_ids.flatMap(id => roles.flatMap(role => Array.from({ length: sampleCount }, (_, index) =>
    add(`${id}/${role}/${index}`, 'PERFORMANCE_SAMPLE', id, role, index))));

  let unexpected = 0;
  for (const observation of measurements) {
    if (observation.kind !== 'CORRECTNESS_CASE' && observation.kind !== 'PERFORMANCE_SAMPLE') {
      if (observation.experiment_id !== record.trial_id) unexpected++;
      continue;
    }
    const slot = slots.get(key(observation.kind, observation.subject_id, observation.role, observation.sample_index));
    if (slot) slot.observations.push(observation);
    else unexpected++;
  }
  const one = (slot: Slot) => slot.observations.length === 1 ? slot.observations[0] : null;
  const identityValid = (observation: Measurement) => observation.experiment_id === record.trial_id && observation.validity === 'VALID';
  const validCorrectness = (slot: Slot) => {
    const row = one(slot);
    return !!row && identityValid(row) && row.unit === null && (row.value === 'PASS' || row.value === 'FAIL');
  };
  const validSample = (slot: Slot) => {
    const row = one(slot);
    return !!row && identityValid(row) && row.unit === 'seconds' && typeof row.value === 'number' && Number.isFinite(row.value) && row.value > 0;
  };
  const invalidCorrectness = correctness.filter(slot => slot.observations.length > 0 && !validCorrectness(slot)).map(slot => slot.id);
  const invalidPerformance = performance.filter(slot => slot.observations.length > 0 && !validSample(slot)).map(slot => slot.id);
  const issues = [
    ...(invalidCorrectness.length ? [`正确性测量无效、重复或实验身份不匹配：${invalidCorrectness.slice(0, 10).join('、')}${invalidCorrectness.length > 10 ? '等' : ''}`] : []),
    ...(invalidPerformance.length ? [`性能样本无效、重复或实验身份不匹配：${invalidPerformance.slice(0, 10).join('、')}${invalidPerformance.length > 10 ? '等' : ''}`] : []),
    ...(unexpected ? [`发现 ${unexpected} 条不属于本次固定测试计划的测量记录。`] : []),
  ];
  const comparisons = record.mode === 'comparison' || record.mode === 'calibration' ? record.workload_ids.map(id => {
    const samples = (role: string) => Array.from({ length: sampleCount }, (_, index) => slots.get(key('PERFORMANCE_SAMPLE', id, role, index))!)
      .filter(validSample).map(slot => one(slot)!.value as number);
    const baseline = samples('BASELINE'), candidate = samples('CANDIDATE');
    const complete = baseline.length === sampleCount && candidate.length === sampleCount;
    return { workload_id: id, ...record.workload_conditions?.find(item => item.workload_id === id), baseline_samples: baseline, candidate_samples: candidate,
      baseline_median: complete ? median(baseline) : null, candidate_median: complete ? median(candidate) : null,
      speedup: complete ? median(baseline) / median(candidate) : null };
  }) : [];
  const calibration = record.mode === 'calibration' && record.test_plan?.statistics && record.workload_specs ? calibratePerformance({ performance: {
    statistics: record.test_plan.statistics, cases: record.workload_specs, sampling: { warmup: record.test_plan.sampling.warmup_count,
      samples: record.test_plan.sampling.sample_count, interleave_seed: record.test_plan.seed, bootstrap_iterations: record.test_plan.statistics.iterations },
    thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: record.test_plan.statistics.confidence_level }, key_cases: [],
  } }, comparisons.map(row => ({ case_id: row.workload_id, baseline_samples: row.baseline_samples, candidate_samples: row.candidate_samples,
    sample_indices: { baseline: measurements.filter(m => m.kind === 'PERFORMANCE_SAMPLE' && m.subject_id === row.workload_id && m.role === 'BASELINE').map(m => m.sample_index!).sort((a,b) => a-b),
      candidate: measurements.filter(m => m.kind === 'PERFORMANCE_SAMPLE' && m.subject_id === row.workload_id && m.role === 'CANDIDATE').map(m => m.sample_index!).sort((a,b) => a-b) } }))) : undefined;
  if (calibration && issues.length) {
    calibration.status = 'INVALID';
    calibration.statistics = { ...calibration.statistics, verdict: 'INVALID', overall_interval: null, worst_case_lower: null,
      issues: [...calibration.statistics.issues, ...issues] };
    calibration.workloads = calibration.workloads.map(row => ({ ...row, interval: null }));
    calibration.note = '本次测量记录不符合固定计划，不能判断 A/A 偏差；请检查原始记录后重新试跑。';
  }
  return {
    correctness: { planned: correctness.length, passed: correctness.filter(slot => validCorrectness(slot) && one(slot)!.value === 'PASS').length,
      failed: correctness.filter(slot => validCorrectness(slot) && one(slot)!.value === 'FAIL').length,
      missing: correctness.filter(slot => !slot.observations.length).map(slot => slot.id), invalid: invalidCorrectness },
    performance: { planned: performance.length, measured: performance.filter(validSample).length,
      missing: performance.filter(slot => !slot.observations.length).map(slot => slot.id), invalid: invalidPerformance },
    issues, comparisons, ...(calibration ? { calibration } : {}),
    quality: validationQualityResult(record.quality, record.correctness_inputs ?? record.case_ids.map(input_id => ({ input_id })),
      measurements.filter(row => row.experiment_id === record.trial_id)),
  };
}
