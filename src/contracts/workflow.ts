import type { DevelopmentFindings, DevelopmentGateResult } from './development-investigation.js';
import type { CandidateEvaluationDecision, CandidateEvaluationFeedback } from './candidate-evaluation-feedback.js';
import type { OptimizationSessionBudget, OptimizationSessionSummary } from './optimization-session.js';
import type { WorkflowDeliveryOperation } from './delivery.js';
import type { WorkflowEvidenceSnapshot } from './optimization-approval.js';
import type { OptimizationVerificationMode } from './public-workflow.js';

/** public optimize 工作流的持久化状态；不包含旧候选补丁或授权对象。 */
export type OptimizationWorkflowStatus =
  | 'CREATED'
  | 'GENERATING'
  | 'BUDGET_EXHAUSTED'
  | 'INTERRUPTED'
  | 'VALIDATION_BLOCKED'
  | 'WAITING_APPROVAL'
  | 'CANDIDATE_READY'
  | 'PERFORMANCE_THRESHOLD_NOT_MET'
  | 'NO_CANDIDATE'
  | 'DELIVERABLE'
  | 'FAILED'
  | 'CANCELLED';

export interface OptimizationWorkflowProgress {
  phase: string;
  round?: number;
  last_event?: string;
  runner_experiment_id?: string;
  runner_status?: string;
  runner_step?: string | null;
  runner_queue?: import('./runner-rpc.js').RunnerQueueState;
}

export interface OptimizationWorkflowRecord {
  /** Missing on historical workflows means verified. */
  verification_mode?: OptimizationVerificationMode;
  review_evidence?: WorkflowEvidenceSnapshot;
  review_evidence_history?: WorkflowEvidenceSnapshot[];
  /** Persisted before Git changes; absent for historical deliveries. */
  delivery_operation?: WorkflowDeliveryOperation;
  /** Earlier delivery requests explicitly withdrawn after reconciling their target. */
  delivery_history?: WorkflowDeliveryOperation[];
  reproduction?: { experiment_id: string; status: 'PREPARING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INCONCLUSIVE' | 'UNKNOWN' | 'CANCELLED';
    phase: string; created_at: string; updated_at: string; error: string | null; source_commit: string; evaluator_digest: string;
    original_experiment_id: string; remote_root: string; machine_identity: string; passed?: boolean };
  delivery?: { commit: string; tree: string; candidate_id: string | null; approved_at: string; commit_message: string; approval_id?: string; evidence_id?: string };
  agent_session?: OptimizationSessionSummary;
  session_budget?: OptimizationSessionBudget;
  continuation_count?: number;
  validation_retry_count?: number;
  execution_machine?: { machine_id: string; name: string; revision: number };
  workflow_id: string;
  request_id?: string;
  request_digest?: string;
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
  execution_contract_digest?: string;
  enable_performance: boolean;
  repository_root?: string;
  source_branch?: string;
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
  /** Automatic local report export; failure here does not change experiment outcomes. */
  report_files?: { markdown: string; json: string };
  report_error?: string | null;
  error: string | null;
  stop_reason?: string;
  created_at: string;
  updated_at: string;
}

/** UI eligibility; the service additionally requires a confirmed remote terminal state. */
export function canRetryWorkflowValidation(workflow: OptimizationWorkflowRecord): boolean {
  return !!workflow.candidate_id && !!workflow.agent_session
    && (!workflow.delivery_operation || workflow.delivery_operation.status === 'COMPLETED')
    && ['VALIDATION_BLOCKED', 'FAILED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(workflow.status)
    && !!workflow.candidate_evaluation_feedback?.experiment_id;
}

export function isWorkflowValidationBlocked(workflow: OptimizationWorkflowRecord): boolean {
  const origin = workflow.candidate_evaluation_feedback?.failure_classification?.failure_origin;
  return workflow.status === 'VALIDATION_BLOCKED' || origin === 'EVALUATOR' || origin === 'EXECUTION' || origin === 'CONTRACT';
}
