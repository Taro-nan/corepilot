import type { Experiment } from '../contracts/optimization-domain.js';

/** A display-level prerequisite; evidence preparation still recomputes the full gate. */
export function hasCurrentApprovalStatistics(experiment: Experiment | undefined): boolean {
  const gate = experiment?.evaluation?.details?.performance_gate as {
    gate_version?: number; statistics?: { verdict?: string; policy?: { method?: string } };
  } | null | undefined;
  return gate?.statistics?.verdict === 'PASSED' && (
    gate.gate_version === 3 && gate.statistics.policy?.method === 'paired-block-bootstrap-v1' ||
    gate.gate_version === 4 && gate.statistics.policy?.method === 'paired-block-bootstrap-v2');
}
