import { classifyExperimentFailure } from '../contracts/experiment-failure.js';
import type { ExperimentStatusResponse } from '../contracts/runner-rpc.js';
import type { ValidationCycleResult } from './validation-runner.js';

/** Keep raw command output, but apply Runner's post-command checks before counting results. */
export function withRunnerValidationStatus(validation: ValidationCycleResult, status = validation.runner_status): ValidationCycleResult {
  if (!status) return validation;
  const classification = classifyExperimentFailure(status);
  const cases = validation.correctness_cases.map(item => status.failure?.step === 'CORRECTNESS' && status.failure.command_execution_id
    && item.command?.command_execution_id === status.failure.command_execution_id
    ? { ...item, status: classification?.failure_origin === 'CANDIDATE' && classification.evaluation_status === 'FAIL'
      ? 'FAILED' as const : 'INVALID' as const, error: status.failure.message }
    : item);
  const invalid = cases.some(item => item.status === 'INVALID');
  return { ...validation, runner_status: status, correctness_cases: cases,
    correctness_coverage: { ...validation.correctness_coverage,
      passed: cases.filter(item => item.status === 'PASSED').length,
      failed: cases.filter(item => item.status === 'FAILED').length,
      complete: validation.correctness_coverage.complete && !invalid },
    formal_correctness_complete: validation.formal_correctness_complete && !invalid,
    passed: validation.passed && status.status === 'SUCCEEDED' && status.validity !== 'INVALID' && !invalid };
}

/** System-side failures have no actionable signal for candidate source repair. */
export function isValidationBlocked(status: ExperimentStatusResponse | undefined): boolean {
  if (!status) return false;
  const origin = classifyExperimentFailure(status)?.failure_origin;
  return origin === 'EVALUATOR' || origin === 'EXECUTION' || origin === 'CONTRACT'
    || status.validity === 'INVALID' && origin !== 'CANDIDATE';
}
