import type { DevelopmentFindings, DevelopmentGateResult } from './development-investigation.js';
import type { CandidateEvaluationDecision, CandidateEvaluationFeedback } from './candidate-evaluation-feedback.js';

/** public optimize 工作流的持久化状态；不包含旧候选补丁或授权对象。 */
export type OptimizationWorkflowStatus =
  | 'CREATED'
  | 'GENERATING'
  | 'WAITING_APPROVAL'
  | 'PERFORMANCE_THRESHOLD_NOT_MET'
  | 'DELIVERABLE'
  | 'FAILED'
  | 'CANCELLED';

export interface OptimizationWorkflowProgress {
  phase: string;
  round?: number;
  last_event?: string;
}

export interface OptimizationWorkflowRecord {
  workflow_id: string;
  /** Compatibility links to the append-oriented domain records. */
  optimization_task_id?: string;
  candidate_id?: string;
  hypothesis_id?: string;
  experiment_id?: string;
  revalidation_experiment_id?: string;
  status: OptimizationWorkflowStatus;
  function_name: string;
  entry_file: string | null;
  config_path: string;
  config_file_sha256?: string;
  testpack_digest?: string;
  enable_performance: boolean;
  repository_root?: string;
  baseline_commit?: string;
  workspace_editing?: string;
  workspace_validation?: string;
  candidate_commit?: string;
  candidate_tree?: string;
  candidate_files?: Array<{ path: string; before_sha256: string | null; after_sha256: string | null }>;
  source_archive_sha256?: string;
  testpack_snapshot_path?: string;
  target_identity?: Record<string, unknown>;
  validation_result?: Record<string, unknown>;
  performance_result?: Record<string, unknown>;
  revalidation_result?: Record<string, unknown>;
  development_findings?: DevelopmentFindings | null;
  development_gate?: DevelopmentGateResult | null;
  candidate_evaluation_feedback?: CandidateEvaluationFeedback | null;
  candidate_evaluation_decision?: CandidateEvaluationDecision | null;
  progress?: OptimizationWorkflowProgress;
  error: string | null;
  created_at: string;
  updated_at: string;
}
