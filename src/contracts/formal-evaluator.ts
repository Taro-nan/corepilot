export const FORMAL_EVALUATOR_SCHEMA_VERSION = 1;
export const FORMAL_EVALUATOR_DIGEST_ALGORITHM = 'phyopt-evaluator-content-sha256-v1';

export type EvaluatorQualificationState =
  | 'DRAFT'
  | 'QUALIFICATION_PENDING'
  | 'TARGET_VALIDATED'
  | 'QUALIFIED'
  | 'REJECTED'
  | 'SUPERSEDED';

export type TargetQualificationResult =
  | 'NOT_RUN'
  | 'TARGET_EXECUTION_FAILED'
  | 'TARGET_EXECUTION_PASSED';

export type QualificationCheckStatus = 'PASS' | 'FAIL' | 'REQUIRES_TARGET_QUALIFICATION';

export interface EvaluatorQualificationCheck {
  check_id: string;
  scope: 'STATIC' | 'TARGET';
  status: QualificationCheckStatus;
  summary: string;
}

export interface EvaluatorQualificationRecord {
  schema_version: typeof FORMAL_EVALUATOR_SCHEMA_VERSION;
  evaluator_id: string;
  version: string;
  subject_digest: string;
  status: EvaluatorQualificationState;
  target: {
    platform: string;
    build_target: string;
    compatibility_scope: string;
    machine_identity_sha256: string | null;
  };
  qualification_run: {
    run_id: string | null;
    result: TargetQualificationResult;
    started_at: string | null;
    completed_at: string | null;
  };
  owner: string;
  reviewer: string | null;
  approved_at: string | null;
  evidence: {
    report_sha256: string | null;
    raw_measurements_sha256: string | null;
  };
  updated_at: string;
  checks: EvaluatorQualificationCheck[];
}

export type EvaluatorParameter = string | number | boolean;

/**
 * One immutable correctness case owned by a Formal Evaluator bundle.
 *
 * `parameters` is deliberately domain-neutral. `threads` remains a first-class
 * field because the Runner must enforce it independently of the evaluator
 * command line.
 */
export interface FormalCaseDefinition {
  case_id: string;
  parameters: Record<string, EvaluatorParameter>;
  threads: number;
}

export interface FormalCorrectnessInventory {
  schema_version: typeof FORMAL_EVALUATOR_SCHEMA_VERSION;
  cases: FormalCaseDefinition[];
}

/** One performance workload with domain-owned scalar parameters. */
export interface FormalWorkloadDefinition {
  workload_id: string;
  parameters: Record<string, EvaluatorParameter>;
  threads: number;
  critical: boolean;
  weight: number;
}

export interface FormalWorkloadInventory {
  schema_version: typeof FORMAL_EVALUATOR_SCHEMA_VERSION;
  workloads: FormalWorkloadDefinition[];
}

/** @deprecated Compatibility aliases for integrations compiled before v0.5. */
export type SgemvCaseDefinition = FormalCaseDefinition;
/** @deprecated Compatibility aliases for integrations compiled before v0.5. */
export type SgemvCorrectnessInventory = FormalCorrectnessInventory;
/** @deprecated Compatibility aliases for integrations compiled before v0.5. */
export type SgemvWorkloadDefinition = FormalWorkloadDefinition;
/** @deprecated Compatibility aliases for integrations compiled before v0.5. */
export type SgemvWorkloadInventory = FormalWorkloadInventory;

export interface FormalEvaluatorCommandContract {
  executable: string;
  script: string;
  arguments: string[];
  measurement_prefix: string;
}

export interface FormalEvaluatorManifest {
  schema_version: typeof FORMAL_EVALUATOR_SCHEMA_VERSION;
  evaluator_id: string;
  version: string;
  owner: string;
  domain: {
    name: string;
    api: string;
    layout: string;
    operation: string;
    datatype: string;
  };
  target: {
    platform: string;
    build_target: string;
    compatibility_scope: string;
  };
  digest_algorithm: typeof FORMAL_EVALUATOR_DIGEST_ALGORITHM;
  digest: string;
  qualification: {
    record: string;
    requires_target_qualification: true;
    requires_owner_approval: true;
  };
  correctness: {
    definition: string;
    inventory: string;
    case_ids: string[];
    command: FormalEvaluatorCommandContract;
    reference: {
      implementation: string;
      accumulation: string;
      qualification_required: true;
    };
    tolerance: {
      rule: string;
      absolute: number;
      relative: number;
      qualification_required: true;
    };
  };
  performance: {
    definition: string;
    inventory: string;
    workload_ids: string[];
    command: FormalEvaluatorCommandContract;
    sampling: {
      warmup_count: number;
      sample_count: number;
      statistic: 'median';
      process_model: 'one-process-per-sample';
    };
    measurement: {
      unit: 'seconds';
      value: 'latency_seconds';
      derived: string[];
      raw_samples_retained: true;
      output_schema: string;
    };
  };
  resource_requirements: {
    cpu_set: string;
    numa_node: number;
    thread_counts: number[];
    enforcement: {
      threads: 'NOT_ENFORCED' | 'ENFORCED';
      cpu_set: 'NOT_ENFORCED' | 'ENFORCED';
      numa_node: 'NOT_ENFORCED' | 'ENFORCED';
    };
  };
  baseline_definition: {
    mode: 'live-symmetric-execution';
    historical_measurements_are_formal_evidence: false;
    identity_required: string[];
    symmetry_required: string[];
  };
  acceptance_policy: {
    correctness: string;
    performance: string;
    regression: string;
  };
  artifact_identity_policy: {
    required_files: string[];
    source_files: string[];
    benchmark_binary: string;
    candidate_binary: string;
    baseline_binary: string;
    runtime_resolution: string;
    mutable_dependencies: 'explicit-artifact-inputs-only';
  };
}

export interface LoadedFormalEvaluatorBundle {
  root: string;
  manifest: FormalEvaluatorManifest;
  qualification: EvaluatorQualificationRecord;
  correctness: FormalCorrectnessInventory;
  workloads: FormalWorkloadInventory;
  content_digest: string;
  qualification_digest: string;
  /** Compatibility alias; this is the evaluator content digest, not an attestation digest. */
  observed_digest: string;
}
