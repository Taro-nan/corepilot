import type { CandidateEvaluationFeedback } from '../contracts/candidate-evaluation-feedback.js';
import type { HypothesisOutcomeStatus } from '../contracts/optimization-hypothesis.js';

export function assessHypothesisOutcome(feedback: CandidateEvaluationFeedback): { status: HypothesisOutcomeStatus; reason: string } {
  if (feedback.resource_context.validity !== 'VALID') return { status: 'INCONCLUSIVE', reason: feedback.resource_context.error_reason ?? `resource context is ${feedback.resource_context.validity}` };
  if (feedback.failure && feedback.failure_category !== 'CORRECTNESS_FAILURE') return { status: 'INCONCLUSIVE', reason: `${feedback.failure.code}: ${feedback.failure.message}` };
  if (feedback.failure_category && !['CORRECTNESS_FAILURE', 'PERFORMANCE_TARGET_NOT_MET', 'PERFORMANCE_REGRESSION'].includes(feedback.failure_category)) return { status: 'INCONCLUSIVE', reason: feedback.failure_category };
  if (feedback.correctness_status === 'FAILED') return { status: 'REJECTED', reason: 'Candidate failed the unchanged correctness contract' };
  if (feedback.correctness_status !== 'PASSED' || !feedback.correctness_coverage.complete || feedback.correctness_coverage.failed !== 0) return { status: 'INCONCLUSIVE', reason: 'correctness evidence is incomplete or invalid' };
  if (feedback.experiment_validity !== 'VALID' || feedback.performance_summary.classification !== 'FORMAL') return { status: 'INCONCLUSIVE', reason: 'experiment evidence is not valid Formal feedback' };
  if (feedback.performance_summary.status === 'FAILED') return { status: 'REJECTED', reason: feedback.performance_summary.reason ?? 'Candidate failed the unchanged performance acceptance policy' };
  if (feedback.performance_summary.status !== 'PASSED') return { status: 'INCONCLUSIVE', reason: 'Formal performance acceptance was not evaluated' };
  return { status: 'ACCEPTED', reason: 'valid resource context, complete correctness and Formal performance acceptance passed; this is not Human Approval' };
}
