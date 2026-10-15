import type { ExperimentStatus, FailureCategory } from './optimization-domain.js';
import type { RunnerFailure } from './runner-rpc.js';

export type ExecutionStatus = 'COMPLETED' | 'FAILED' | 'TIMEOUT';
export type EvaluationStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type ContractStatus = 'VALID' | 'VIOLATED';
export type ViolationReason = 'MISSING_RESOURCE_CONTEXT' | 'MISSING_MEASUREMENT_FIELD' | 'INVALID_EVIDENCE';
export type FailureOrigin = 'CANDIDATE' | 'EVALUATOR' | 'EXECUTION' | 'CONTRACT' | null;

export interface ExperimentFailureClassification {
  execution_status: ExecutionStatus;
  evaluation_status: EvaluationStatus;
  contract_status: ContractStatus;
  violation_reason: ViolationReason | null;
  failure_origin: FailureOrigin;
}

export function classifyExperimentFailure(input: {
  status: ExperimentStatus;
  failure_category: FailureCategory | null;
  failure: RunnerFailure | null;
}): ExperimentFailureClassification | null {
  const { status, failure, failure_category: category } = input;
  if (status !== 'SUCCEEDED' && status !== 'FAILED' && status !== 'CANCELLED') return null;
  const code = failure?.code;
  const contractFailure = code === 'FORMAL_CONTRACT_VIOLATION' || code === 'MISSING_RESOURCE_CONTEXT' || code === 'MEASUREMENT_PARSE_ERROR';
  const violationReason = contractFailure
    ? failure?.violation_reason ?? (code === 'MISSING_RESOURCE_CONTEXT' ? 'MISSING_RESOURCE_CONTEXT' : 'INVALID_EVIDENCE')
    : null;
  const candidateEvaluationFailure = code === 'CANDIDATE_CORRECTNESS_FAILED' || (!failure &&
    (category === 'CORRECTNESS_FAILURE' || category === 'PERFORMANCE_REGRESSION' || category === 'PERFORMANCE_TARGET_NOT_MET'));
  const failureOrigin: FailureOrigin = contractFailure ? 'CONTRACT'
    : candidateEvaluationFailure || category === 'BUILD_FAILURE' ? 'CANDIDATE'
      : category === 'EVALUATOR_FAILURE' ? 'EVALUATOR'
        : status === 'SUCCEEDED' ? null : 'EXECUTION';
  return {
    execution_status: code === 'COMMAND_TIMED_OUT' ? 'TIMEOUT'
      : status === 'SUCCEEDED' || code === 'CANDIDATE_CORRECTNESS_FAILED' || contractFailure ? 'COMPLETED' : 'FAILED',
    evaluation_status: candidateEvaluationFailure ? 'FAIL' : status === 'SUCCEEDED' && !category && !failure ? 'PASS' : 'UNKNOWN',
    contract_status: contractFailure ? 'VIOLATED' : 'VALID',
    violation_reason: violationReason,
    failure_origin: failureOrigin,
  };
}
