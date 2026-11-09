/** A user's recorded delivery request; distinct from a domain Approval Record. */
export interface WorkflowDeliveryOperation {
  schema_version: 1;
  operation_id: string;
  status: 'PREPARING' | 'PREPARED' | 'APPLYING' | 'WAITING' | 'NEEDS_ATTENTION' | 'COMPLETED' | 'WITHDRAWN';
  target: { kind: 'BRANCH'; branch: string } | { kind: 'DETACHED'; worktree: string };
  repository: string;
  editing_workspace: string;
  validation_workspace: string;
  baseline_commit: string;
  candidate_id: string;
  candidate_commit: string;
  candidate_tree: string;
  formal_experiment_id: string;
  revalidation_experiment_id: string;
  /** Absent on historical requests created before domain approval was connected. */
  approval_id?: string;
  evidence_id?: string;
  evidence_digest?: string;
  commit_message: string;
  prepared_commit: string | null;
  requested_at: string;
  updated_at: string;
  last_checked_at: string | null;
  observation: 'UNKNOWN' | 'NOT_APPLIED' | 'DIVERGED' | 'APPLIED';
  message: string;
  /** Computed during reconciliation; absent on older saved operations until checked. */
  can_resume?: boolean;
  /** The prior Git process may still be running after an abrupt Control stop. */
  stop_confirmation_required: boolean;
  stop_confirmed_at: string | null;
  cleanup: 'PENDING' | 'DONE' | 'NEEDS_ATTENTION';
  cleanup_message: string | null;
}
