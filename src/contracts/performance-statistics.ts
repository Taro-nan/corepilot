export interface PerformanceStatisticsPolicy {
  method: 'paired-block-bootstrap-v1' | 'paired-block-bootstrap-v2';
  confidence_level: number;
  iterations: number;
  seed: number;
  block_length: number;
  min_samples: number;
}
export interface ConfidenceInterval { lower: number; upper: number }
export interface PerformanceCalibration {
  kind: 'AA_SAME_ARTIFACT';
  status: 'COMPATIBLE_WITH_EQUALITY' | 'BIAS_DETECTED' | 'INSUFFICIENT' | 'INVALID';
  statistics: PerformanceStatistics;
  overall_speedup: number;
  workloads: Array<{ workload_id: string; speedup: number; interval: ConfidenceInterval | null }>;
  note: string;
}
export const DEFAULT_STATISTICS: PerformanceStatisticsPolicy = { method: 'paired-block-bootstrap-v2', confidence_level: 0.95,
  iterations: 4000, seed: 0, block_length: 2, min_samples: 9 };
/** The method identifies both its resampling and acceptance semantics. */
export function statisticsGateVersion(policy: PerformanceStatisticsPolicy): 3 | 4 {
  if (policy.method === 'paired-block-bootstrap-v1') return 3;
  if (policy.method === 'paired-block-bootstrap-v2') return 4;
  throw new Error('不支持该统计方案版本。');
}
export interface PerformanceStatistics {
  policy: PerformanceStatisticsPolicy;
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'INVALID';
  /** v2 only: comparison of the overall interval to 1×, separate from the acceptance target. */
  comparison?: 'IMPROVED' | 'REGRESSED' | 'INCONCLUSIVE';
  overall_interval: ConfidenceInterval | null;
  worst_case_lower: number | null;
  issues: string[];
  sample_digest: string;
  resampling_unit: 'consecutive paired process samples within each workload';
  case_interval_adjustment: 'Bonferroni across declared workloads';
}
