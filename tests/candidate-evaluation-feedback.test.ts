import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateDecisionTool } from '../src/agent/candidate-feedback-tool.js';
import type { ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import type { CommandExecution } from '../src/contracts/optimization-domain.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { candidateEvaluationFeedback } from '../src/workspace/candidate-evaluation-feedback.js';
import { structuredAgentFeedback, validationCycleFromCommandExecutions, type CommandRunResult, type ValidationCycleResult } from '../src/workspace/validation-runner.js';

function failedValidation(): ValidationCycleResult {
  const observation = { kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'edge-1', sample_index: null, value: 'FAIL', validity: 'VALID', domain_payload: { parameters: { elements: 1, seed: 101 }, observed_summary: { mismatches: 1, status: 0 }, reference_summary: { implementation: 'independent scalar oracle' } } };
  const command: CommandRunResult = { command_execution_id: 'command:failed', command: 'test', args: [], cwd: '.', start_time: '2026-10-12T00:00:00Z', end_time: '2026-10-12T00:00:01Z', timeout_ms: 1000, duration_ms: 1000, ok: false, exit_code: 2, timed_out: false, cancelled: false, stdout: `PHYOPT_MEASUREMENT ${JSON.stringify(observation)}\n`, stderr: '', resource_context: { validity: 'VALID' } };
  const status: ExperimentStatusResponse = { experiment_id: 'experiment:1', candidate_id: 'candidate:1', task_id: 'task:1', type: 'FORMAL_EVALUATION', status: 'FAILED', validity: 'INVALID', started_at: command.start_time, ended_at: command.end_time, updated_at: command.end_time, failure_category: 'EVALUATOR_FAILURE', observed_context: { resource_policy: { validity: 'VALID', observed: { cpu_sets: ['0'], thread_counts: { '1': { max_runtime_threads: 1 } } } } }, current_step: null, cancel_requested: false, failure: { code: 'MISSING_RESOURCE_CONTEXT', message: 'missing measurement threads', missing_fields: ['domain_payload.parameters.threads'], step: 'CORRECTNESS', command_execution_id: command.command_execution_id! } };
  return { build: { ...command, ok: true, exit_code: 0, stdout: '' }, correctness: command, correctness_cases: [{ case_id: 'edge-1', parameters: { elements: 1, seed: 101, threads: 1 }, status: 'FAILED', error: 'command exited with 2', command }], correctness_coverage: { planned: 3, executed: 1, passed: 0, failed: 1, complete: false }, formal_correctness_complete: false, performance: null, passed: false, runner_status: status };
}

test('candidate feedback preserves exact failure evidence and separates diagnostics from Formal results', () => {
  const validation = failedValidation();
  const feedback = candidateEvaluationFeedback({ validation });
  assert.equal(feedback.candidate_id, 'candidate:1');
  assert.equal(feedback.experiment_id, 'experiment:1');
  assert.equal(feedback.correctness_status, 'INVALID');
  assert.deepEqual(feedback.correctness_coverage, { planned: 3, executed: 1, passed: 0, failed: 0, complete: false });
  assert.equal(feedback.failure_classification?.failure_origin, 'CONTRACT');
  assert.equal(feedback.failure_classification?.evaluation_status, 'UNKNOWN');
  assert.equal(feedback.failed_cases[0].evidence.command_execution_id, 'command:failed');
  assert.equal(feedback.failed_cases[0].evidence.source, 'COMMAND_OUTPUT_DIAGNOSTIC');
  assert.deepEqual((feedback.failed_cases[0].evidence.observation?.domain_payload as Record<string, unknown>).observed_summary, { mismatches: 1, status: 0 });
  assert.equal(feedback.failure_category, 'EVALUATOR_FAILURE');
  assert.equal(feedback.failure?.code, 'MISSING_RESOURCE_CONTEXT');
  assert.equal(feedback.resource_context.validity, 'VALID');
  assert.equal(feedback.resource_context.error_reason, 'MISSING_RESOURCE_CONTEXT');
  assert.equal(feedback.performance_summary.status, 'NOT_EXECUTED');
  assert.equal(feedback.performance_summary.classification, 'DIAGNOSTIC_ONLY');
  assert.equal(feedback.performance_summary.weighted_geomean, null);
  assert.deepEqual(feedback.recommended_investigation_area, ['SOURCE_SEMANTICS', 'CASE_BOUNDARIES', 'EVALUATOR_OUTPUT_CONTRACT', 'RESOURCE_CONFIGURATION']);
  assert.deepEqual((structuredAgentFeedback(validation).correctness as Record<string, unknown>).failed_cases, feedback.failed_cases);
});

test('structured correctness without per-case args keeps the originating command evidence', () => {
  const failed = failedValidation();
  const commandFact = (step: CommandExecution['step'], sequence: number, command: CommandRunResult): CommandExecution => ({ ...command, schema_version: 1, command_execution_id: `command:${sequence}`, experiment_id: 'experiment:1', evaluator: null, step, sequence });
  const testpack = {
    correctness: { command: { executable: 'test', args: [], cwd: '.', environment: {}, timeout_ms: 1000 }, cases: [{ case_id: 'edge-1', parameters: { elements: 1, seed: 101 }, threads: 1, critical: true, weight: 1 }], pass_required: 1 },
    performance: { command: { executable: 'test', args: [], cwd: '.', environment: {}, timeout_ms: 1000 } },
  } as ValidationTestpack;
  const validation = validationCycleFromCommandExecutions({ testpack, commands: [commandFact('BUILD', 1, failed.build), commandFact('CORRECTNESS', 2, failed.correctness!)], includePerformance: true });
  const feedback = candidateEvaluationFeedback({ validation });
  assert.equal(feedback.failed_cases[0].case_id, 'edge-1');
  assert.equal(feedback.failed_cases[0].evidence.command_execution_id, 'command:2');
  assert.equal(feedback.failed_cases[0].evidence.observation?.value, 'FAIL');
  assert.equal(feedback.failed_cases[0].evidence.exit_code, 2);
});

test('an invalid Runner observation cannot become a correctness PASS from a zero command exit code', () => {
  const validation = failedValidation();
  validation.correctness!.ok = true;
  validation.correctness!.exit_code = 0;
  validation.correctness_cases[0].status = 'PASSED';
  const feedback = candidateEvaluationFeedback({ validation });
  assert.equal(feedback.correctness_status, 'INVALID');
  assert.equal(feedback.failed_cases[0].status, 'INVALID');
  assert.equal(feedback.failed_cases[0].error_reason, 'missing measurement threads');
  assert.equal(feedback.experiment_validity, 'INVALID');
  assert.equal(feedback.correctness_coverage.passed, 0);
  assert.equal(feedback.correctness_coverage.complete, false);
  assert.ok(feedback.recommended_investigation_area.includes('SOURCE_SEMANTICS'));
});

test('resource context is explicitly missing when no Runner or command observation exists', () => {
  const validation = failedValidation();
  delete validation.runner_status;
  delete validation.correctness!.resource_context;
  const feedback = candidateEvaluationFeedback({ validation, candidateId: 'candidate:local', experimentId: 'experiment:local' });
  assert.equal(feedback.candidate_id, 'candidate:local');
  assert.equal(feedback.resource_context.validity, 'UNKNOWN');
  assert.equal(feedback.resource_context.error_reason, 'MISSING_RESOURCE_CONTEXT');
  assert.ok(feedback.recommended_investigation_area.includes('RESOURCE_CONFIGURATION'));
});

test('feedback bounds raw evidence and never associates an undeclared observation with a failed case', () => {
  const validation = failedValidation();
  validation.correctness!.stdout = 'PHYOPT_MEASUREMENT {invalid}\nPHYOPT_MEASUREMENT {"kind":"CORRECTNESS_CASE","subject_id":"other-case","value":"FAIL"}\n' + 'noise'.repeat(4096);
  const feedback = candidateEvaluationFeedback({ validation });
  assert.equal(feedback.failed_cases[0].evidence.observation, null);
  assert.equal(feedback.failed_cases[0].evidence.stdout.length, 8192);
});

test('performance feedback contains regression workloads and confidence results without mixing development gains', () => {
  const validation = failedValidation();
  validation.correctness!.ok = true;
  validation.correctness!.exit_code = 0;
  validation.correctness_cases[0].status = 'PASSED';
  validation.formal_correctness_complete = true;
  validation.runner_status!.status = 'SUCCEEDED';
  validation.runner_status!.validity = 'VALID';
  validation.runner_status!.failure = null;
  validation.runner_status!.failure_category = null;
  validation.performance = validation.correctness;
  const feedback = candidateEvaluationFeedback({ validation, performance: { passed: false, weighted_geomean: 1.02, overall_ci_lower: 0.99, key_case_ci_lower: 0.96, case_ratios: { 'workload-1': 0.98 }, reason: 'regression', workloads: [{ case_id: 'workload-1', baseline_samples: [1], candidate_samples: [1.02], baseline_median: 1, candidate_median: 1.02, speedup: 0.98, critical: true, regression: true, ci_lower: 0.96 }] } });
  assert.equal(feedback.correctness_status, 'PASSED');
  assert.equal(feedback.performance_summary.status, 'FAILED');
  assert.equal(feedback.performance_summary.weighted_geomean, 1.02);
  assert.equal(feedback.performance_summary.overall_ci_lower, 0.99);
  assert.equal(feedback.performance_summary.workloads[0].ci_lower, 0.96);
  assert.equal(feedback.performance_summary.workloads[0].regression, true);
  assert.equal(feedback.failure_classification?.execution_status, 'COMPLETED');
  assert.equal(feedback.failure_classification?.evaluation_status, 'FAIL');
  assert.equal(feedback.failure_classification?.failure_origin, 'CANDIDATE');
  assert.equal(feedback.development_gate, null);
  const unassessed = candidateEvaluationFeedback({ validation });
  assert.equal(unassessed.failure_classification?.evaluation_status, 'UNKNOWN');
});

test('candidate decisions reject stale identities and require a concrete new hypothesis', async () => {
  const feedback = candidateEvaluationFeedback({ validation: failedValidation() });
  const recorded: string[] = [];
  const tool = candidateDecisionTool(feedback, decision => { recorded.push(decision.action); });
  await assert.rejects(tool.execute('stale', { candidate_id: 'candidate:other', experiment_id: 'experiment:1', action: 'REPAIR', reason: 'repair' }), /identity differs/);
  await assert.rejects(tool.execute('missing-hypothesis', { candidate_id: 'candidate:1', experiment_id: 'experiment:1', action: 'NEW_HYPOTHESIS', reason: 'rethink' }), /requires a hypothesis/);
  const result = await tool.execute('abandon', { candidate_id: 'candidate:1', experiment_id: 'experiment:1', action: 'ABANDON', reason: 'No defensible repair remains.' });
  assert.equal(result.terminate, true);
  assert.deepEqual(recorded, ['ABANDON']);
});
