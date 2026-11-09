import type { Candidate, CommandExecution, Experiment, Measurement, OptimizationTask } from './optimization-domain.js';
import type { OptimizationApprovalRecord } from './optimization-approval.js';
import type { HypothesisOutcome, OptimizationHypothesis } from './optimization-hypothesis.js';
import type { OptimizationWorkflowRecord } from './workflow.js';

/** A read-only snapshot of persisted facts, never an approval or frozen Evidence. */
export interface OptimizationReport {
  summary?: import('./customer-report.js').CustomerOptimizationSummary;
  schema_version: 1;
  generated_at: string;
  workflow: OptimizationWorkflowRecord;
  task: OptimizationTask | null;
  hypotheses: OptimizationHypothesis[];
  outcomes: HypothesisOutcome[];
  candidates: Array<{ candidate: Candidate; approval: OptimizationApprovalRecord | null }>;
  experiments: Array<{ experiment: Experiment; commands: CommandExecution[]; measurements: Measurement[] }>;
  notices: string[];
}

export interface OptimizationReportResponse {
  report: OptimizationReport;
  markdown: string;
}
