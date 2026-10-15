import type {
  Candidate,
  CommandExecution,
  Experiment,
  Measurement,
  OptimizationTask,
} from '../contracts/optimization-domain.js';
import type { HypothesisOutcome, OptimizationHypothesis } from '../contracts/optimization-hypothesis.js';
import type { OptimizationApprovalRecord } from '../contracts/optimization-approval.js';

/** Append-oriented persistence boundary for real optimization facts. */
export interface OptimizationStore {
  saveOptimizationTask(task: OptimizationTask): void;
  getOptimizationTask(taskId: string): OptimizationTask | null;
  getOptimizationTaskByWorkflowId(workflowId: string): OptimizationTask | null;

  createHypothesis(hypothesis: OptimizationHypothesis): void;
  getHypothesis(hypothesisId: string): OptimizationHypothesis | null;
  listHypotheses(taskId: string): OptimizationHypothesis[];
  abandonHypothesis(hypothesisId: string, reason: string, recordedAt: string): void;
  appendHypothesisOutcome(outcome: HypothesisOutcome): void;
  listHypothesisOutcomes(taskId: string): HypothesisOutcome[];

  createCandidate(candidate: Candidate): void;
  getCandidate(candidateId: string): Candidate | null;
  listCandidates(taskId: string): Candidate[];
  recordCandidateApproval(record: OptimizationApprovalRecord): void;
  getCandidateApproval(candidateId: string): OptimizationApprovalRecord | null;
  getEvidenceApproval(evidenceId: string): OptimizationApprovalRecord | null;

  createExperiment(experiment: Experiment): void;
  saveExperiment(experiment: Experiment): void;
  getExperiment(experimentId: string): Experiment | null;
  listExperiments(taskId: string): Experiment[];

  appendCommandExecution(execution: CommandExecution): void;
  listCommandExecutions(experimentId: string): CommandExecution[];

  appendMeasurement(measurement: Measurement): void;
  listMeasurements(experimentId: string): Measurement[];
}
