export interface PerformanceStatisticsPolicy {
  method: 'paired-block-bootstrap-v1';
  confidence_level: number;
  iterations: number;
  seed: number;
  block_length: number;
  min_samples: number;
}
export interface ConfidenceInterval { lower: number; upper: number }
export interface PerformanceCalibration {
  kind: 'AA_SAME_ARTIFACT';
  status: 'COMPATIBLE_WITH_EQUALITY' | 'BIAS_DETECTED' | 'INSUFFICIENT';
  statistics: PerformanceStatistics;
  overall_speedup: number;
  workloads: Array<{ workload_id: string; speedup: number; interval: ConfidenceInterval | null }>;
  note: string;
}
export const DEFAULT_STATISTICS: PerformanceStatisticsPolicy = { method: 'paired-block-bootstrap-v1', confidence_level: 0.95,
  iterations: 4000, seed: 0, block_length: 2, min_samples: 9 };
export interface PerformanceStatistics {
  policy: PerformanceStatisticsPolicy;
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'INVALID';
  overall_interval: ConfidenceInterval | null;
  worst_case_lower: number | null;
  issues: string[];
  sample_digest: string;
  resampling_unit: 'consecutive paired process samples within each workload';
  case_interval_adjustment: 'Bonferroni across declared workloads';
}
