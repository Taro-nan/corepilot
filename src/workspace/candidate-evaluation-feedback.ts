import type { CandidateEvaluationFeedback } from '../contracts/candidate-evaluation-feedback.js';
import type { DevelopmentGateResult } from '../contracts/development-investigation.js';
import type { PerformanceGateResult, ValidationCycleResult } from './validation-runner.js';
import { classifyExperimentFailure } from '../contracts/experiment-failure.js';
import { withRunnerValidationStatus } from './validation-outcome.js';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedRecord(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  return serialized.length <= 16_384 ? structuredClone(value) : { truncated: true, preview: serialized.slice(0, 16_384) };
}

function diagnosticObservation(stdout: string, caseId: string): Record<string, unknown> | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('COREPILOT_MEASUREMENT ') || line.length > 65_536) continue;
    try {
      const observation = record(JSON.parse(line.slice('COREPILOT_MEASUREMENT '.length)));
      if (observation?.kind === 'CORRECTNESS_CASE' && observation.subject_id === caseId) return boundedRecord(observation);
    } catch {
      continue;
    }
  }
  return null;
}

export function candidateEvaluationFeedback(input: {
  validation: ValidationCycleResult;
  candidateId?: string | null;
  experimentId?: string | null;
  performance?: PerformanceGateResult | null;
  developmentGate?: DevelopmentGateResult | null;
}): CandidateEvaluationFeedback {
  const { performance } = input;
  const validation = withRunnerValidationStatus(input.validation);
  const status = validation.runner_status;
  const caseResults = validation.correctness_cases;
  const failedCases = caseResults.filter(item => item.status === 'FAILED' || item.status === 'INVALID');
  const failed = failedCases.some(item => item.status === 'FAILED');
  const correctnessStatus = !validation.correctness ? 'NOT_EXECUTED'
    : failed ? 'FAILED'
      : (status?.validity === 'INVALID' && status.failure?.step === 'CORRECTNESS') || failedCases.length > 0 ? 'INVALID'
        : !validation.correctness.ok ? 'FAILED'
          : validation.formal_correctness_complete ? 'PASSED' : 'INCOMPLETE';
  const resourcePolicy = record(status?.observed_context?.resource_policy)
    ?? validation.correctness?.resource_context ?? validation.performance?.resource_context ?? null;
  const validity = resourcePolicy?.validity;
  const resourceValidity = validity === 'VALID' || validity === 'INVALID' || validity === 'NOT_ENFORCED' ? validity : 'UNKNOWN';
  const uncertain = performance?.statistics?.verdict === 'INCONCLUSIVE' || performance?.statistics?.verdict === 'INVALID';
  const performanceFailure = performance?.gate_version === 4 && (performance.statistics?.comparison === 'REGRESSED' || performance.workloads.some(row => row.regression))
    ? 'PERFORMANCE_REGRESSION' : 'PERFORMANCE_TARGET_NOT_MET';
  const failureCategory = status?.failure_category ?? (!validation.build.ok ? 'BUILD_FAILURE' : correctnessStatus === 'FAILED' ? 'CORRECTNESS_FAILURE' : performance?.passed === false && !uncertain ? performanceFailure : null);
  const failureClassification = status ? classifyExperimentFailure({ ...status, failure_category: failureCategory }) : null;
  if (failureClassification?.evaluation_status === 'PASS' &&
      (uncertain || correctnessStatus !== 'PASSED' || !validation.correctness_coverage.complete || (validation.performance && !performance))) {
    failureClassification.evaluation_status = 'UNKNOWN';
  }
  const areas: CandidateEvaluationFeedback['recommended_investigation_area'] = [];
  if (!validation.build.ok) areas.push('BUILD_CONFIGURATION');
  if (correctnessStatus === 'FAILED' || failedCases.some(item => diagnosticObservation(item.command?.stdout ?? '', item.case_id)?.value === 'FAIL')) areas.push('SOURCE_SEMANTICS', 'CASE_BOUNDARIES');
  if (status?.failure_category === 'EVALUATOR_FAILURE' || correctnessStatus === 'INVALID' || failureClassification?.failure_origin === 'CONTRACT') areas.push('EVALUATOR_OUTPUT_CONTRACT');
  if (resourceValidity !== 'VALID' || status?.failure?.code === 'MISSING_RESOURCE_CONTEXT') areas.push('RESOURCE_CONFIGURATION');
  if (validation.performance && (!validation.performance.ok || performance?.passed === false && !uncertain)) areas.push('PERFORMANCE_HOTPATH');
  return {
    schema_version: 1,
    candidate_id: input.candidateId ?? status?.candidate_id ?? null,
    experiment_id: input.experimentId ?? status?.experiment_id ?? null,
    experiment_validity: performance?.statistics?.verdict === 'INVALID' ? 'INVALID' : status?.validity ?? 'UNKNOWN',
    correctness_status: correctnessStatus,
    correctness_coverage: { ...validation.correctness_coverage },
    failed_cases: failedCases.map(item => ({
      case_id: item.case_id,
      status: item.status as 'FAILED' | 'INVALID',
      domain_payload: { parameters: boundedRecord(item.parameters) },
      error_reason: item.error?.slice(0, 4096) ?? null,
      evidence: {
        source: 'COMMAND_OUTPUT_DIAGNOSTIC',
        command_execution_id: item.command?.command_execution_id ?? null,
        exit_code: item.command?.exit_code ?? null,
        stdout: item.command?.stdout.slice(0, 8192) ?? '',
        stderr: item.command?.stderr.slice(0, 4096) ?? '',
        observation: diagnosticObservation(item.command?.stdout ?? '', item.case_id),
      },
    })),
    failure_category: failureCategory,
    failure: status?.failure ? structuredClone(status.failure) : null,
    failure_classification: failureClassification,
    performance_summary: {
      status: !validation.performance ? 'NOT_EXECUTED' : status?.validity === 'INVALID' || performance?.statistics?.verdict === 'INVALID' ? 'INVALID' : !validation.performance.ok ? 'FAILED' : !performance ? 'NOT_EVALUATED' : performance.passed ? 'PASSED' : uncertain ? 'INCONCLUSIVE' : 'FAILED',
      classification: !status ? 'DEVELOPMENT_ONLY' : status.validity === 'VALID' ? 'FORMAL' : 'DIAGNOSTIC_ONLY',
      weighted_geomean: performance?.weighted_geomean ?? null,
      overall_ci_lower: performance?.overall_ci_lower ?? null,
      key_case_ci_lower: performance?.key_case_ci_lower ?? null,
      reason: performance?.reason ?? (status?.failure?.step === 'PERFORMANCE' ? status.failure.message.slice(0, 4096) : validation.performance?.ok === false ? validation.performance.stderr.slice(0, 4096) : null),
      workloads: performance?.workloads.map(item => ({ workload_id: item.case_id, baseline_median: item.baseline_median, candidate_median: item.candidate_median, speedup: item.speedup, critical: item.critical, regression: item.regression, ci_lower: item.ci_lower ?? null })) ?? [],
    },
    development_gate: input.developmentGate ? structuredClone(input.developmentGate) : null,
    resource_context: { validity: resourceValidity, error_reason: resourcePolicy ? status?.failure?.code === 'MISSING_RESOURCE_CONTEXT' ? status.failure.code : null : 'MISSING_RESOURCE_CONTEXT', observed: resourcePolicy ? boundedRecord(resourcePolicy) : null },
    recommended_investigation_area: areas,
  };
}
