import type { FailureCategory, ExperimentValidity } from './optimization-domain.js';
import type { RunnerFailure } from './runner-rpc.js';
import type { DevelopmentGateResult } from './development-investigation.js';
import type { ExperimentFailureClassification } from './experiment-failure.js';

export interface CandidateEvaluationFeedback {
  schema_version: 1;
  candidate_id: string | null;
  experiment_id: string | null;
  experiment_validity: ExperimentValidity;
  correctness_status: 'PASSED' | 'FAILED' | 'INVALID' | 'INCOMPLETE' | 'NOT_EXECUTED';
  correctness_coverage: { planned: number; executed: number; passed: number; failed: number; complete: boolean };
  failed_cases: Array<{
    case_id: string;
    status: 'FAILED' | 'INVALID';
    domain_payload: Record<string, unknown>;
    error_reason: string | null;
    evidence: {
      source: 'COMMAND_OUTPUT_DIAGNOSTIC';
      command_execution_id: string | null;
      exit_code: number | null;
      stdout: string;
      stderr: string;
      observation: Record<string, unknown> | null;
    };
  }>;
  failure_category: FailureCategory | null;
  failure: RunnerFailure | null;
  failure_classification: ExperimentFailureClassification | null;
  performance_summary: {
    status: 'PASSED' | 'FAILED' | 'INVALID' | 'NOT_EVALUATED' | 'NOT_EXECUTED';
    classification: 'FORMAL' | 'DEVELOPMENT_ONLY' | 'DIAGNOSTIC_ONLY';
    weighted_geomean: number | null;
    overall_ci_lower: number | null;
    key_case_ci_lower: number | null;
    reason: string | null;
    workloads: Array<{
      workload_id: string;
      baseline_median: number;
      candidate_median: number;
      speedup: number;
      critical: boolean;
      regression: boolean;
      ci_lower: number | null;
    }>;
  };
  development_gate: DevelopmentGateResult | null;
  resource_context: {
    validity: 'VALID' | 'INVALID' | 'NOT_ENFORCED' | 'UNKNOWN';
    error_reason: string | null;
    observed: Record<string, unknown> | null;
  };
  recommended_investigation_area: Array<'SOURCE_SEMANTICS' | 'CASE_BOUNDARIES' | 'BUILD_CONFIGURATION' | 'EVALUATOR_OUTPUT_CONTRACT' | 'RESOURCE_CONFIGURATION' | 'PERFORMANCE_HOTPATH'>;
}

export interface CandidateEvaluationDecision {
  hypothesis_id?: string;
  candidate_id: string | null;
  experiment_id: string | null;
  action: 'REPAIR' | 'ABANDON' | 'NEW_HYPOTHESIS';
  reason: string;
  hypothesis: string | null;
}
