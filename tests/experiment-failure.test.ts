import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExperimentFailure } from '../src/contracts/experiment-failure.js';
import type { FailureCategory } from '../src/contracts/optimization-domain.js';
import type { RunnerFailure } from '../src/contracts/runner-rpc.js';

function classify(category: FailureCategory, code: RunnerFailure['code'], violationReason?: RunnerFailure['violation_reason']) {
  return classifyExperimentFailure({
    status: 'FAILED',
    failure_category: category,
    failure: { code, message: code, step: 'CORRECTNESS', command_execution_id: 'command:1', ...(violationReason ? { violation_reason: violationReason } : {}) },
  });
}

test('Formal experiment failure classification separates candidate, evaluator, execution, and contract faults', () => {
  assert.deepEqual(classify('CORRECTNESS_FAILURE', 'CANDIDATE_CORRECTNESS_FAILED'), {
    execution_status: 'COMPLETED', evaluation_status: 'FAIL', contract_status: 'VALID', violation_reason: null, failure_origin: 'CANDIDATE',
  });
  assert.deepEqual(classify('EVALUATOR_FAILURE', 'EVALUATOR_IDENTITY_MISMATCH'), {
    execution_status: 'FAILED', evaluation_status: 'UNKNOWN', contract_status: 'VALID', violation_reason: null, failure_origin: 'EVALUATOR',
  });
  assert.deepEqual(classify('INFRASTRUCTURE_FAILURE', 'COMMAND_TIMED_OUT'), {
    execution_status: 'TIMEOUT', evaluation_status: 'UNKNOWN', contract_status: 'VALID', violation_reason: null, failure_origin: 'EXECUTION',
  });
  assert.deepEqual(classify('INVALID_EXPERIMENT', 'FORMAL_CONTRACT_VIOLATION', 'MISSING_MEASUREMENT_FIELD'), {
    execution_status: 'COMPLETED', evaluation_status: 'UNKNOWN', contract_status: 'VIOLATED', violation_reason: 'MISSING_MEASUREMENT_FIELD', failure_origin: 'CONTRACT',
  });
  assert.deepEqual(classify('RESOURCE_UNAVAILABLE', 'MISSING_RESOURCE_CONTEXT'), {
    execution_status: 'COMPLETED', evaluation_status: 'UNKNOWN', contract_status: 'VIOLATED', violation_reason: 'MISSING_RESOURCE_CONTEXT', failure_origin: 'CONTRACT',
  });
  assert.equal(classifyExperimentFailure({ status: 'RUNNING', failure_category: null, failure: null }), null);
});

test('performance rejection after completed execution is a valid Candidate evaluation failure', () => {
  for (const category of ['PERFORMANCE_REGRESSION', 'PERFORMANCE_TARGET_NOT_MET'] as const) {
    assert.deepEqual(classifyExperimentFailure({ status: 'SUCCEEDED', failure_category: category, failure: null }), {
      execution_status: 'COMPLETED', evaluation_status: 'FAIL', contract_status: 'VALID', violation_reason: null, failure_origin: 'CANDIDATE',
    });
  }
});
