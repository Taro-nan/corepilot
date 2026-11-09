import type { Experiment } from '../contracts/optimization-domain.js';

/** A display-level prerequisite; evidence preparation still recomputes the full gate. */
export function hasCurrentApprovalStatistics(experiment: Experiment | undefined): boolean {
  const gate = experiment?.evaluation?.details?.performance_gate as {
    gate_version?: number; statistics?: { verdict?: string; policy?: { method?: string } };
  } | null | undefined;
  return gate?.gate_version === 3 && gate.statistics?.verdict === 'PASSED'
    && gate.statistics.policy?.method === 'paired-block-bootstrap-v1';
}
