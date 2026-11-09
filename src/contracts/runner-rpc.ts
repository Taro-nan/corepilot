import type {
  CommandExecution,
  Experiment,
  ExperimentStatus,
  ExperimentStep,
  Measurement,
} from './optimization-domain.js';
import type { ValidationCommand } from './validation-testpack.js';
import type { ExperimentFailureClassification, ViolationReason } from './experiment-failure.js';

export const RUNNER_PROTOCOL_VERSION = 1;
/** A versioned route prevents old Runners from ignoring an identity guard. */
export const RUNNER_STORE_ROUTE = '/_corepilot/runner-stores/';

export interface RunnerHealth {
  runner_id: string;
  /** Identity of this SQLite store, not the configurable Runner name. */
  store_instance_id?: string;
  version: string;
  protocol_version: typeof RUNNER_PROTOCOL_VERSION;
  status: 'READY';
  resource_enforcement: 'DISABLED' | 'REQUIRED';
  capabilities?: { controlled_validation: 1; source_archive_upload?: 1; execution_logs?: 1; resource_matrix?: 1; exclusive_queue?: 1; store_identity_guard?: 1; artifact_path_check?: 1 };
}

export interface RunnerQueueState {
  policy: 'runner-exclusive-fifo-v1';
  sequence: number;
  enqueued_at: string;
  acquired_at: string | null;
  released_at: string | null;
  wait_ms: number | null;
  position?: number;
  waiting_for?: string | null;
  reason?: string | null;
  stop_confirmation?: { reviewer: string; reason: string; confirmed_at: string };
}

export interface RunnerMachineInfo {
  hostname: string;
  architecture: string;
  platform: string;
  os: string;
  kernel: string;
  cpu_count: number;
  cpu_model: string | null;
  machine_identity_sha256: string;
  node_runtime: string;
  cpu_identity: {
    product_model: string | null;
    hardware: string | null;
    implementer: string | null;
    architecture: string | null;
    variant: string | null;
    part: string | null;
    revision: string | null;
    midr_el1: string | null;
  };
  cpu_topology: {
    online_cpus: string | null;
    possible_cpus: string | null;
    sockets: number | null;
    cores: number | null;
    threads_per_core: number | null;
    node_cpu_lists: Record<string, string>;
  };
  numa_summary: {
    online_nodes: string;
    node_count: number;
  } | null;
  resource_capabilities: {
    taskset: boolean;
    numactl: boolean;
    proc_status: boolean;
  };
}

/** A mechanical command step, not a second Experiment domain object. */
export interface ExperimentExecutionStep {
  step: ExperimentStep;
  command: ValidationCommand;
  /** Selects the immutable root in which the command is allowed to run. */
  execution_domain?: 'CANDIDATE' | 'EVALUATOR';
  /** Parse COREPILOT_MEASUREMENT-prefixed JSON lines emitted on stdout. */
  measurements_from_stdout?: boolean;
  /** Required semantic identity for each Formal Evaluator case/iteration. */
  formal_context?: FormalExecutionContext;
  /** Only DEVELOPMENT_FEEDBACK: run unchanged correctness code against a known-bad artifact. */
  diagnostic_probe?: { probe_id: string; defect: string; input_id: string };
}

export type FormalExecutionPhase = 'CORRECTNESS_CASE' | 'PERFORMANCE_WARMUP' | 'PERFORMANCE_SAMPLE';

export interface FormalExecutionContext {
  phase: FormalExecutionPhase;
  subject_id: string;
  role: 'BASELINE' | 'CANDIDATE' | 'EVALUATOR';
  /** Warmup or raw-sample index; correctness uses null. */
  iteration_index: number | null;
  parameters: Record<string, string | number | boolean>;
  artifact: {
    artifact_id: string;
    path: string;
    /** Null only for a just-built Candidate binary; Runner observes and pins it before first use. */
    sha256: string | null;
    /** Frozen bundled and system runtime dependencies, checked before each Baseline command. */
    dependencies?: Array<{ path: string; sha256: string }>;
  };
  resources: {
    threads: number;
    cpu_set: string;
    numa_node: number;
    omp_proc_bind?: 'close' | 'spread';
  };
}

/** Identity of the already-staged, frozen Candidate consumed by a plan. */
export interface StagedCandidateIdentity {
  candidate_id: string;
  commit: string;
  tree: string;
  source_sha256: string;
  workspace_path: string;
}

/** Identity of a staged Formal Evaluator that is disjoint from the Candidate. */
export interface StagedEvaluatorIdentity {
  evaluator_id: string;
  version: string;
  digest: string;
  workspace_path: string;
}

/** Execution instructions for an existing, Control-Plane-owned Experiment. */
export interface ExperimentExecutionPlan {
  experiment: Experiment;
  /** Required for formal evaluation/revalidation; optional for development fixtures. */
  candidate?: StagedCandidateIdentity;
  /** Required for formal evaluation/revalidation and verified before and after use. */
  evaluator?: StagedEvaluatorIdentity;
  steps: ExperimentExecutionStep[];
  /** Optional exported command logs, disjoint from source and evaluator. SQLite remains authoritative. */
  output_directory?: string;
  /** Optional writable build tree outside the immutable staged source tree. */
  build_directory?: string;
}

export interface StagedSourceArchive {
  workspace_path: string;
  source_sha256: string;
  archive_sha256: string;
  archive_bytes: number;
}

export interface RunnerExecutionOutput {
  stdout: string; stderr: string;
  stdout_path: string; stderr_path: string;
  truncated: boolean;
  artifacts?: RunnerBuildArtifact[];
}

export interface RunnerBuildArtifact {
  relative_path: string; path: string; source_path: string; sha256: string; bytes: number;
}

export interface RunnerFailure {
  code:
    | 'COMMAND_FAILED'
    | 'COMMAND_TIMED_OUT'
    | 'EXECUTION_ERROR'
    | 'MEASUREMENT_PARSE_ERROR'
    | 'CANDIDATE_NOT_FOUND'
    | 'CANDIDATE_IDENTITY_MISMATCH'
    | 'EVALUATOR_NOT_FOUND'
    | 'EVALUATOR_IDENTITY_MISMATCH'
    | 'EVALUATOR_UNQUALIFIED'
    | 'FORMAL_CONTRACT_VIOLATION'
    | 'MISSING_RESOURCE_CONTEXT'
    | 'CANDIDATE_CORRECTNESS_FAILED'
    | 'RESOURCE_CONSTRAINT_UNSATISFIED'
    | 'RUNNER_RESTART'
    | 'STATE_UNKNOWN';
  message: string;
  step: ExperimentStep | null;
  command_execution_id: string | null;
  missing_fields?: string[];
  violation_reason?: ViolationReason;
}

export type SubmitExperimentResponse = Pick<Experiment, 'experiment_id' | 'status'>;

export type ExperimentStatusResponse = Pick<Experiment,
  'experiment_id' | 'task_id' | 'candidate_id' | 'type' | 'status' | 'validity' | 'started_at' | 'ended_at' |
  'failure_category' | 'observed_context' | 'updated_at'> & {
    current_step: ExperimentStep | null;
    cancel_requested: boolean;
    failure: RunnerFailure | null;
    failure_classification?: ExperimentFailureClassification | null;
    queue?: RunnerQueueState;
  };

export interface CancelExperimentResponse {
  experiment_id: string;
  status: ExperimentStatus;
  cancel_requested: boolean;
}

export interface ExperimentMeasurementsResponse {
  experiment_id: string;
  measurements: Measurement[];
}

export interface ExperimentCommandsResponse {
  experiment_id: string;
  command_executions: CommandExecution[];
}

export type MeasurementObservation = Pick<Measurement,
  'kind' | 'role' | 'subject_id' | 'sample_index' | 'value' | 'unit' | 'validity' | 'domain_payload'>;
