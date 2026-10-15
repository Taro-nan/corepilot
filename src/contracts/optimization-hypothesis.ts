import type { CandidateEvaluationFeedback } from './candidate-evaluation-feedback.js';
import type { Candidate, Experiment, FailureCategory } from './optimization-domain.js';

export type HypothesisOutcomeStatus = 'ACCEPTED' | 'REJECTED' | 'INCONCLUSIVE';

export interface HypothesisEvidence {
  kind: 'SOURCE_INSPECTION' | 'DEVELOPMENT_FEEDBACK' | 'EXPERIMENT_FEEDBACK';
  summary: string;
  experiment_id?: string;
  command_execution_id?: string;
}

export interface HypothesisProposal {
  description: string;
  motivation: string;
  evidence: HypothesisEvidence[];
  expected_effect: string;
  risk: string;
  affected_scope: string[];
}

export interface OptimizationHypothesis extends HypothesisProposal {
  schema_version: 1;
  hypothesis_id: string;
  task_id: string;
  parent_hypothesis_id: string | null;
  status: 'PROPOSED' | HypothesisOutcomeStatus | 'ABANDONED';
  agent_identity: Record<string, unknown>;
  abandonment: { reason: string; recorded_at: string } | null;
  created_at: string;
  updated_at: string;
}

export interface HypothesisOutcome {
  schema_version: 1;
  outcome_id: string;
  hypothesis_id: string;
  task_id: string;
  candidate_id: string;
  experiment_id: string;
  status: HypothesisOutcomeStatus;
  reason: string;
  failure_category: FailureCategory | null;
  feedback: CandidateEvaluationFeedback | null;
  recorded_at: string;
}

export interface OptimizationReasoningHistory {
  task_id: string;
  hypotheses: Array<{
    hypothesis: OptimizationHypothesis;
    candidates: Array<Pick<Candidate, 'candidate_id' | 'parent_candidate_id' | 'hypothesis_id' | 'hypothesis' | 'source'>>;
    experiments: Array<Pick<Experiment, 'experiment_id' | 'candidate_id' | 'type' | 'status' | 'validity' | 'failure_category' | 'evaluation'>>;
    outcomes: HypothesisOutcome[];
  }>;
}
