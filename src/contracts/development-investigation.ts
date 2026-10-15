export const DEVELOPMENT_ONLY = 'DEVELOPMENT_ONLY' as const;

export type DevelopmentInvestigationToolName =
  | 'inspect_machine'
  | 'inspect_binary'
  | 'disassemble'
  | 'run_dev_benchmark'
  | 'profile_perf_stat';

export interface DevelopmentSupportingMeasurement {
  tool: DevelopmentInvestigationToolName;
  subject_id: string;
  summary: string;
  experiment_id?: string;
}

/** Structured engineering judgment retained with a Candidate, never Formal Evidence. */
export interface DevelopmentFindings {
  classification: typeof DEVELOPMENT_ONLY;
  observations: string[];
  suspected_bottleneck: string;
  supporting_measurements: DevelopmentSupportingMeasurement[];
  chosen_transformation: string | null;
  rejected_alternatives: string[];
}

export interface DevelopmentToolResult<T = Record<string, unknown>> {
  classification: typeof DEVELOPMENT_ONLY;
  tool: DevelopmentInvestigationToolName;
  experiment_id: string | null;
  data: T;
  /** Raw output remains in Runner CommandExecution records. */
  raw_command_execution_ids: string[];
}

export interface DevelopmentBenchmarkSummary {
  workload_id: string;
  sample_count_per_role: number;
  baseline_samples_seconds: number[];
  candidate_samples_seconds: number[];
  baseline_median_seconds: number;
  candidate_median_seconds: number;
  speedup: number;
  resource_context: {
    cpu_set: string;
    numa_node: number;
    threads: number;
  };
}

export interface DevelopmentGateWorkload {
  workload_id: string;
  before_candidate_median_seconds: number | null;
  after_candidate_median_seconds: number;
  candidate_ratio_before_over_after: number | null;
  obviously_worse: boolean;
}

export interface DevelopmentGateResult {
  classification: typeof DEVELOPMENT_ONLY;
  passed: boolean;
  reason: string;
  workloads: DevelopmentGateWorkload[];
}

export interface PerfCounterSet {
  cycles?: number;
  instructions?: number;
  branches?: number;
  branch_misses?: number;
  cache_references?: number;
  cache_misses?: number;
  ipc?: number;
  branch_miss_rate?: number;
  cache_miss_rate?: number;
}

export interface DevelopmentPerfStatSummary {
  workload_id: string;
  supported_events: string[];
  unavailable_events: string[];
  baseline: PerfCounterSet;
  candidate: PerfCounterSet;
  benchmark_timing: {
    baseline_samples_seconds: number[];
    candidate_samples_seconds: number[];
    speedup: number | null;
  };
  resource_context: {
    cpu_set: string;
    numa_node: number;
    threads: number;
  };
  warnings: string[];
}
