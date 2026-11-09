import type { CommandExecution, Measurement } from './optimization-domain.js';
import type { ExperimentStatusResponse, RunnerExecutionOutput, RunnerMachineInfo } from './runner-rpc.js';
import type { ValidationTestPlan } from './validation-assets.js';
import type { ValidationCommand } from './validation-testpack.js';
import type { FormalCaseDefinition, FormalWorkloadDefinition } from './formal-evaluator.js';
import type { ConfidenceInterval } from './performance-statistics.js';

export type TestingMode = 'correctness' | 'performance' | 'both';
export type TestingSubject =
  | { kind: 'source'; project_id: string; branch: string; commit?: string;
      build?: { command: string; cwd?: string }; artifact?: string }
  | { kind: 'binary'; asset_id: string };
export interface TestingPlanRef { package_id: string; package_version: string; target_id: string }
export interface CreateTestingTask {
  name?: string;
  machine_id: string;
  plan: TestingPlanRef;
  candidate: TestingSubject;
  baseline?: TestingSubject;
  mode: TestingMode;
  expected_evaluator_digest?: string;
  expected_package_digest?: string;
}
export interface TestingAssetFile { path: string; sha256: string; bytes: number }
export interface TestingAsset {
  schema_version: 1;
  asset_id: string;
  name: string;
  version: string;
  state: 'UPLOADING' | 'READY';
  files: TestingAssetFile[];
  entries: string[];
  entry_path: string | null;
  sha256: string | null;
  created_at: string;
  finalized_at: string | null;
}
export interface TestingPlanPreview {
  ref: TestingPlanRef;
  function_name: string;
  package_digest: string;
  evaluator: { id: string; version: string; digest: string; qualification: string };
  build: { command: string; cwd: string; artifact: string };
  code: { setup: boolean; correctness: boolean; performance: boolean; issues: string[] };
  /** Absent only in older persisted previews. */
  correctness?: { definition: string; reference: { implementation: string; accumulation: string };
    tolerance: { rule: string; absolute: number; relative: number } };
  test_plan: ValidationTestPlan;
  cases: FormalCaseDefinition[];
  workloads: FormalWorkloadDefinition[];
  note: string;
}
export interface TestingPreparedSubject {
  kind: 'source' | 'binary';
  name: string;
  version: string;
  artifact_path: string;
  artifact_sha256: string | null;
  library_paths: string[];
  dependencies: Array<{ path: string; sha256: string }>;
  source?: { project_id: string; branch: string; commit: string; tree: string; source_sha256?: string;
    archive_sha256?: string; workspace: string; build_root: string; build: ValidationCommand };
  asset_id?: string;
}
export type TestingExecutionStatus = 'PREPARING' | 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export interface TestingTaskRecord {
  schema_version: 1;
  task_id: string;
  name: string;
  request_id: string | null;
  request_digest: string;
  input: CreateTestingTask;
  plan: TestingPlanPreview;
  machine: { machine_id: string; name: string; revision: number; connection_key: string;
    runner_id: string | null; hardware: RunnerMachineInfo | null };
  subjects: { candidate: TestingPreparedSubject | null; baseline: TestingPreparedSubject | null };
  workspace: { run_root: string; logs_root: string; assets_root: string; runtime_root: string };
  execution: { status: TestingExecutionStatus; phase: string; message: string | null; cancel_requested: boolean;
    submission_attempted: boolean; failure: { code: string; stage: string; message: string } | null };
  created_at: string;
  updated_at: string;
  formal_evidence: false;
}
export interface TestingComparison {
  workload_id: string;
  parameters: Record<string, string | number | boolean>;
  threads: number;
  critical: boolean;
  baseline_samples: number[];
  candidate_samples: number[];
  baseline_median: number | null;
  candidate_median: number | null;
  speedup: number | null;
  interval: ConfidenceInterval | null;
  conclusion: 'IMPROVED' | 'REGRESSED' | 'INCONCLUSIVE' | 'NOT_MEASURED' | 'INVALID';
}
export interface TestingSummary {
  correctness: { status: 'NOT_REQUESTED' | 'NOT_MEASURED' | 'PASSED' | 'FAILED' | 'INCOMPLETE' | 'INVALID';
    planned: number; passed: number; failed: number; missing: string[]; invalid: string[] };
  performance: { status: 'NOT_REQUESTED' | 'NOT_MEASURED' | 'IMPROVED' | 'REGRESSED' | 'INCONCLUSIVE' | 'INCOMPLETE' | 'INVALID';
    planned: number; measured: number; speedup: number | null; interval: ConfidenceInterval | null; issues: string[] };
  comparisons: TestingComparison[];
  conclusion_scope: string;
}
export interface TestingTaskDetails {
  task: TestingTaskRecord;
  status: ExperimentStatusResponse | null;
  summary: TestingSummary;
  commands: CommandExecution[];
  measurements: Measurement[];
  output: RunnerExecutionOutput | null;
  formal_evidence: false;
}
