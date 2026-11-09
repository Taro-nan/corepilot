import type { FormalCaseDefinition, FormalWorkloadDefinition } from './formal-evaluator.js';
import type { RunnerHealth, RunnerMachineInfo } from './runner-rpc.js';
import type { RunnerToolchain } from './build-planning.js';
import type { ValidationCommand } from './validation-testpack.js';
import type { ValidationQualityPlan } from './validation-quality.js';

/** User-owned experiment conditions. AI generation may only read this contract. */
export interface ValidationTestPlan {
  schema_version: 1;
  resources: { cpu_set: string; numa_node: number };
  sampling: { warmup_count: number; sample_count: number; order: 'paired' | 'alternating' };
  seed: number;
  inner_iterations: number;
  timing_scope: 'kernel' | 'end-to-end';
  candidate_api: string;
  baseline_api: string;
  statistics?: import('./performance-statistics.js').PerformanceStatisticsPolicy;
  /** Named, user-owned resource configurations. Inventories are expanded when a draft is saved. */
  execution_matrix?: {
    thread_counts: number[];
    profiles: Array<{ id: string; name: string; cpu_set: string; numa_node: number;
      cpu_allocation: 'per_thread' | 'shared'; omp_proc_bind: 'close' | 'spread' }>;
  };
}

export interface ValidationSourceFile { path: string; content: string }
export type ValidationGenerationScope = 'correctness' | 'performance' | 'both';
export interface ValidationCorrectnessInput extends FormalCaseDefinition {
  /** Stored in the evaluator's correctness/input-generation.json, keyed by logical input ID. */
  input_generation?: string;
}
export interface ValidationPerformanceInput extends FormalWorkloadDefinition {
  /** Stored in benchmark/input-generation.json by logical workload ID. */
  input_generation?: string;
}
export interface CorrectnessPlanProposal {
  kind: 'CORRECTNESS_PLAN';
  generation_id?: string;
  expected_digest: string;
  source_commit: string | null;
  summary: string;
  cases: ValidationCorrectnessInput[];
  oracle_description: string;
  tolerance_rule: string;
  tolerance_absolute: number;
  tolerance_relative: number;
  rationale: string;
  assumptions: string[];
  evidence_files: string[];
}
export type ValidationGenerationOutcome = ValidationAssetEdit | CorrectnessPlanProposal;

export interface ValidationGenerationRecord {
  generation_id: string;
  project_id: string;
  package_id: string;
  package_version: string;
  target_id: string;
  scope: ValidationGenerationScope;
  purpose?: 'TEST_CODE' | 'CORRECTNESS_PLAN';
  instructions?: string;
  evaluator_digest: string;
  status: 'RUNNING' | 'CANCELLING' | 'SUCCEEDED' | 'NEEDS_INPUT' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  phase: string;
  message: string;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  model: { endpoint: string; requested_model: string; request_count: number; sent_model?: string; response_model?: string; request_id?: string;
    usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null } };
  blockers?: string[];
  result?: ValidationAssetEdit;
  proposal?: CorrectnessPlanProposal;
}

export interface ValidationPreparationContext {
  build: ValidationCommand;
  package_digest: string;
  machine: { name: string; hardware: RunnerMachineInfo; health: RunnerHealth; toolchain: RunnerToolchain | null } | null;
  machine_error: string | null;
  baseline: { configured: boolean; library: string; version: string; sha256: string; kind: 'single' | 'binary_bundle'; headers: string[]; source_kind: string;
    source_detail?: string; source_commit?: string; entry_path?: string; artifact_path?: string; library_count?: number;
    checked_at?: string; checked_machine?: string; imported_at?: string };
}

/** Editable content of an unqualified, project-owned evaluator draft. */
export interface ValidationAssetDraft {
  package_id: string;
  package_version: string;
  target_id: string;
  function_name: string;
  evaluator_id: string;
  evaluator_digest: string;
  qualification: string;
  source: 'placeholder' | 'ai' | 'uploaded' | 'edited';
  correctness_script: string;
  performance_script: string;
  cases: ValidationCorrectnessInput[];
  workloads: ValidationPerformanceInput[];
  oracle_description: string;
  benchmark_description: string;
  tolerance_rule: string;
  tolerance_absolute: number;
  tolerance_relative: number;
  candidate_artifact: string;
  test_plan: ValidationTestPlan;
  setup_script: string;
  supporting_files: ValidationSourceFile[];
  correctness_generation_blockers?: string[];
  quality?: ValidationQualityPlan;
  /** Read-only comparison identity from the selected Package, never an editable test rule. */
  comparison_baseline?: { library: string; version: string; sha256: string; source_kind: string; source_detail?: string };
}

export type ValidationAssetEdit = Pick<ValidationAssetDraft,
  'correctness_script' | 'performance_script' | 'cases' | 'workloads' |
  'oracle_description' | 'benchmark_description' | 'tolerance_rule' |
  'tolerance_absolute' | 'tolerance_relative' | 'candidate_artifact'> & {
  /** Optional on older clients; omission preserves the stored values. */
  test_plan?: ValidationTestPlan;
  setup_script?: string;
  supporting_files?: ValidationSourceFile[];
  source: 'ai' | 'uploaded' | 'edited';
  expected_digest: string;
  /** Explanation of generated draft assumptions; execution facts are recorded separately. */
  generation_notes?: string;
  quality?: ValidationQualityPlan;
};
