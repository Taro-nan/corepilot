/** validation testpack 的版本；与旧 testpack 导入格式保持独立。 */
export const VALIDATION_TESTPACK_SCHEMA_VERSION = 1;

export interface ValidationCommand {
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  timeout_ms: number;
}

export interface ValidationCase {
  case_id: string;
  /** Domain-owned scalar parameters. New testpacks should use this mapping. */
  parameters?: Record<string, string | number | boolean>;
  /** Legacy SGEMV migration fields retained for existing testpacks. */
  m?: number;
  /** Legacy SGEMV migration fields retained for existing testpacks. */
  n?: number;
  threads: number;
  /** Legacy SGEMV migration field retained for existing testpacks. */
  seed?: number;
  critical: boolean;
  weight: number;
  args?: string[];
}

export interface ValidationBaseline {
  id: string;
  library: string;
  version: string;
  sha256: string;
  path: string;
}

export interface PerformanceThresholds {
  weighted_geomean_min: number;
  overall_ci_lower_min: number;
  key_case_ci_lower_min: number;
  confidence_level: number;
}

export interface ValidationSampling {
  warmup: number;
  samples: number;
  interleave_seed: number;
  bootstrap_iterations: number;
}

/**
 * Identity and local source of the Candidate-independent Formal Evaluator.
 *
 * `root` is resolved relative to the testpack file when loaded. The complete
 * directory is hashed before a workflow starts and is staged outside every
 * Candidate workspace for RPC execution.
 */
export interface TrustedEvaluatorBundle {
  id: string;
  version: string;
  owner: string;
  root: string;
  sha256: string;
}

export interface RevalidationRequirement {
  required: boolean;
  timeout_ms: number;
  command: ValidationCommand;
}

export interface ValidationTestpack {
  schema_version: typeof VALIDATION_TESTPACK_SCHEMA_VERSION;
  testpack_id: string;
  function_name: string;
  function_family: string;
  operation: string;
  data_type: string;
  /** Optional only for the legacy migration path; RPC formal work requires it. */
  evaluator?: TrustedEvaluatorBundle;
  resources: {
    cpu_set: string;
    numa_nodes: number[];
    thread_counts: number[];
  };
  correctness: {
    command: ValidationCommand;
    cases: ValidationCase[];
    pass_required: number;
  };
  performance: {
    command: ValidationCommand;
    cases: ValidationCase[];
    sampling: ValidationSampling;
    baselines: {
      current: ValidationBaseline;
      comparison: ValidationBaseline;
    };
    thresholds: PerformanceThresholds;
    key_cases: string[];
  };
  revalidation: {
    formal: RevalidationRequirement;
    independent: RevalidationRequirement;
  };
}

export interface LoadedValidationTestpack {
  testpack: ValidationTestpack;
  testpackPath: string;
  testpackDir: string;
  rawSha256: string;
}

export interface FrozenValidationTestpack {
  schema_version: typeof VALIDATION_TESTPACK_SCHEMA_VERSION;
  frozen_at: string;
  digest: string;
  testpack: ValidationTestpack;
}
