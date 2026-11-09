import type { ConfidenceInterval } from './performance-statistics.js';
import type { ValidationQualityResult } from './validation-quality.js';
import type { CandidateVerificationSummary } from './candidate-verification.js';

export interface CustomerOptimizationSummary {
  schema_version: 1;
  state: 'CANDIDATE_READY' | 'READY_FOR_REVIEW' | 'READY_FOR_DELIVERY' | 'DELIVERY_PENDING' | 'DELIVERED' | 'DELIVERY_UNVERIFIED' | 'BLOCKED' | 'RUNNING' | 'NO_VERIFIED_RESULT';
  conclusion: string;
  /** Current stored-fact assessment; it is not an approval or frozen Evidence. */
  verification: CandidateVerificationSummary;
  candidate_id: string | null;
  source_commit: string | null;
  formal_experiment_id: string | null;
  revalidation_experiment_id: string | null;
  formal_speedup: number | null;
  revalidation_speedup: number | null;
  overall_interval: ConfidenceInterval | null;
  logical_inputs: number | null;
  correctness_executions: number;
  quality: ValidationQualityResult | null;
  regressions: string[];
  groups: Array<{ dimension: string; value: string; workloads: number; weighted_speedup: number; worst_speedup: number }>;
  limits: string[];
  next_step: { kind: 'TEST' | 'WAIT' | 'REVIEW' | 'RESUME' | 'RETRY_VALIDATION' | 'INSPECT' | 'REPRODUCE'; message: string; command: string | null };
  resource_wait_ms: number;
}
