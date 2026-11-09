import type { DevelopmentFindings } from './development-investigation.js';
import type { LibraryPackageTaskReference } from './library-package.js';
import type { RunnerFailure } from './runner-rpc.js';

/**
 * Core optimization facts shared by the existing public workflow and its
 * durable store. Domain-specific parameters (for example dimensions or strides)
 * belong in opaque domain payloads rather than fields in this core model.
 */
export const OPTIMIZATION_DOMAIN_SCHEMA_VERSION = 1;

export type OptimizationTaskStatus =
  | 'CREATED'
  | 'RUNNING'
  | 'BUDGET_EXHAUSTED'
  | 'INTERRUPTED'
  | 'VALIDATION_BLOCKED'
  | 'WAITING_APPROVAL'
  | 'CANDIDATE_READY'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type CandidateStatus = 'FROZEN' | 'EVALUATED' | 'ACCEPTED' | 'REJECTED' | 'APPROVED';

export type ExperimentStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type ExperimentValidity = 'UNKNOWN' | 'VALID' | 'INVALID';

export type ExperimentType = 'FORMAL_EVALUATION' | 'REVALIDATION' | 'DEVELOPMENT_FEEDBACK';

export type ExperimentStep = 'BUILD' | 'EVALUATOR_SETUP' | 'CORRECTNESS' | 'PERFORMANCE' | 'REVALIDATION';

export type FailureCategory =
  | 'BUILD_FAILURE'
  | 'CORRECTNESS_FAILURE'
  | 'PERFORMANCE_REGRESSION'
  | 'PERFORMANCE_TARGET_NOT_MET'
  | 'INFRASTRUCTURE_FAILURE'
  | 'RESOURCE_UNAVAILABLE'
  | 'EVALUATOR_FAILURE'
  | 'UNKNOWN'
  | 'CANCELLED'
  | 'AGENT_FAILURE'
  | 'INVALID_EXPERIMENT';

export interface DomainIdentity {
  id: string;
  version?: string;
  digest?: string;
  details?: Record<string, unknown>;
}

export interface OptimizationTask {
  schema_version: typeof OPTIMIZATION_DOMAIN_SCHEMA_VERSION;
  task_id: string;
  /** Compatibility link while the public workflow API is being migrated. */
  workflow_id: string | null;
  library_package?: LibraryPackageTaskReference;
  status: OptimizationTaskStatus;
  target: {
    kind: string;
    name: string;
    scope: Record<string, unknown>;
  };
  source_baseline: DomainIdentity;
  performance_baseline: DomainIdentity | null;
  /** No evaluator is bound while preparing an unverified source-only candidate. */
  evaluator: DomainIdentity | null;
  declared_context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CandidateChangedFile {
  path: string;
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface Candidate {
  schema_version: typeof OPTIMIZATION_DOMAIN_SCHEMA_VERSION;
  candidate_id: string;
  task_id: string;
  hypothesis_id: string;
  parent_candidate_id: string | null;
  sequence: number;
  status: CandidateStatus;
  source: {
    repository: string;
    commit: string;
    tree: string;
    archive_sha256: string;
    changed_files: CandidateChangedFile[];
  };
  hypothesis: string | null;
  /** Development-only diagnosis that led to this Candidate. */
  development_findings: DevelopmentFindings | null;
  agent_identity: Record<string, unknown>;
  created_at: string;
}

export interface PerformanceWorkloadSummary {
  workload_id: string;
  baseline_samples: number[];
  candidate_samples: number[];
  baseline_median: number;
  candidate_median: number;
  speedup: number;
  critical: boolean;
  regression: boolean;
  ci_lower?: number;
  ci_upper?: number;
  conclusion?: 'IMPROVED' | 'REGRESSED' | 'INCONCLUSIVE';
}

export interface ExperimentEvaluationSummary {
  build: 'PASSED' | 'FAILED' | 'NOT_EXECUTED';
  correctness: 'PASSED' | 'FAILED' | 'INVALID' | 'INCOMPLETE' | 'NOT_EXECUTED';
  performance: 'PASSED' | 'FAILED' | 'INVALID' | 'INCONCLUSIVE' | 'NOT_EXECUTED';
  correctness_coverage?: {
    planned: number;
    executed: number;
    passed: number;
    failed: number;
    complete: boolean;
  };
  performance_workloads?: PerformanceWorkloadSummary[];
  details?: Record<string, unknown>;
}

/** Runner's terminal report before Control derives an evaluation from its facts. */
export interface RunnerTerminalFacts {
  status: Extract<ExperimentStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
  validity: ExperimentValidity;
  failure_category: FailureCategory | null;
  failure: RunnerFailure | null;
  observed_context: Record<string, unknown> | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface Experiment {
  schema_version: typeof OPTIMIZATION_DOMAIN_SCHEMA_VERSION;
  experiment_id: string;
  task_id: string;
  candidate_id: string;
  type: ExperimentType;
  status: ExperimentStatus;
  validity: ExperimentValidity;
  failure_category: FailureCategory | null;
  evaluator: DomainIdentity;
  baseline: DomainIdentity;
  declared_context: Record<string, unknown>;
  observed_context: Record<string, unknown> | null;
  evaluation: ExperimentEvaluationSummary | null;
  /** Absent in historical records that predate terminal fact preservation. */
  runner_terminal_facts?: RunnerTerminalFacts;
  /** Control-plane diagnostic; not an observation that a test step ran or did not run. */
  last_control_diagnostic?: { code: 'REMOTE_STATE_UNKNOWN' | 'CANCELLED' | 'EXECUTION_FAILED'; message: string; resolved_at?: string };
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommandExecution {
  diagnostic_probe?: { probe_id: string; defect: string; input_id: string };
  schema_version: typeof OPTIMIZATION_DOMAIN_SCHEMA_VERSION;
  command_execution_id: string;
  experiment_id: string;
  /** Immutable Formal Evaluator identity, or null for development-only execution. */
  evaluator: DomainIdentity | null;
  step: ExperimentStep;
  sequence: number;
  command: string;
  args: string[];
  cwd: string;
  start_time: string;
  end_time: string;
  duration_ms: number;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timeout_ms: number;
  timed_out: boolean;
  cancelled: boolean;
  /** Runner-owned declared/applied/observed resource facts for Formal commands. */
  resource_context?: Record<string, unknown> | null;
}

export type MeasurementKind = 'CORRECTNESS_CASE' | 'PERFORMANCE_SAMPLE' | 'PERFORMANCE_MEDIAN' | 'OBSERVATION';
export type MeasurementRole = 'BASELINE' | 'CANDIDATE' | 'EVALUATOR' | null;
export type MeasurementValidity = 'VALID' | 'INVALID' | 'UNKNOWN';

export interface Measurement {
  schema_version: typeof OPTIMIZATION_DOMAIN_SCHEMA_VERSION;
  measurement_id: string;
  experiment_id: string;
  /** Immutable Formal Evaluator identity, or null for development-only evidence. */
  evaluator: DomainIdentity | null;
  kind: MeasurementKind;
  role: MeasurementRole;
  /** Workload, correctness case, or other measured subject identity. */
  subject_id: string;
  sample_index: number | null;
  value: number | string | boolean | null;
  unit: string | null;
  validity: MeasurementValidity;
  /** Domain-specific scalar parameters and execution context. */
  domain_payload: Record<string, unknown>;
  recorded_at: string;
}
