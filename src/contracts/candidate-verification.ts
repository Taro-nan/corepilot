/** Why persisted experiments do not currently support a delivery recommendation. */
export type CandidateVerificationIssueCode =
  | 'VERIFICATION_NOT_REQUESTED'
  | 'TASK_MISSING' | 'CANDIDATE_MISSING' | 'CANDIDATE_REJECTED' | 'SOURCE_IDENTITY_MISMATCH'
  | 'FORMAL_MISSING' | 'FORMAL_INVALID' | 'REVALIDATION_MISSING' | 'REVALIDATION_INVALID'
  | 'EVALUATOR_MISMATCH' | 'BASELINE_MISMATCH' | 'MACHINE_MISMATCH' | 'REPRODUCTION_INCOMPLETE';

export interface CandidateVerificationIssue {
  code: CandidateVerificationIssueCode;
  message: string;
}

/** A read-time assessment, not frozen Evidence or a human approval. */
export interface CandidateVerificationSummary {
  ready: boolean;
  formal_experiment_id: string | null;
  revalidation_experiment_id: string | null;
  issues: CandidateVerificationIssue[];
}
