import type {
  Candidate,
  CommandExecution,
  Experiment,
  Measurement,
  OptimizationTask,
} from '../contracts/optimization-domain.js';
import type { HypothesisOutcome, OptimizationHypothesis } from '../contracts/optimization-hypothesis.js';
import type { OptimizationApprovalRecord } from '../contracts/optimization-approval.js';
import type { StoredBuildFact } from '../contracts/build-planning.js';

export class ExperimentStateChangedError extends Error {
  constructor(experimentId: string) {
    super(`实验 ${experimentId} 的状态已改变，请核对原实验后继续。`);
    this.name = 'ExperimentStateChangedError';
  }
}

/** A locally completed validation's facts, committed with its evaluation. */
export interface LocalExperimentFacts {
  commands: CommandExecution[];
  measurements: Measurement[];
}

/** Append-oriented persistence boundary for real optimization facts. */
export interface OptimizationStore {
  latestBuildForRepository(repository: string): StoredBuildFact | null;
  saveOptimizationTask(task: OptimizationTask): void;
  getOptimizationTask(taskId: string): OptimizationTask | null;
  getOptimizationTaskByWorkflowId(workflowId: string): OptimizationTask | null;

  createHypothesis(hypothesis: OptimizationHypothesis): void;
  getHypothesis(hypothesisId: string): OptimizationHypothesis | null;
  listHypotheses(taskId: string): OptimizationHypothesis[];
  abandonHypothesis(hypothesisId: string, reason: string, recordedAt: string): void;
  listHypothesisOutcomes(taskId: string): HypothesisOutcome[];

  createCandidate(candidate: Candidate): void;
  getCandidate(candidateId: string): Candidate | null;
  listCandidates(taskId: string): Candidate[];
  recordCandidateApproval(record: OptimizationApprovalRecord): void;
  getCandidateApproval(candidateId: string): OptimizationApprovalRecord | null;
  getEvidenceApproval(evidenceId: string): OptimizationApprovalRecord | null;

  createExperiment(experiment: Experiment): void;
  saveExperiment(experiment: Experiment): void;
  saveExperimentIfCurrent(expected: Experiment, next: Experiment): void;
  /** Atomically persist Control's result and the associated hypothesis outcome. */
  commitExperimentResult(expected: Experiment, next: Experiment, outcome: HypothesisOutcome | null, localFacts?: LocalExperimentFacts): Experiment;
  getExperiment(experimentId: string): Experiment | null;
  /** Durable insertion order; wall-clock changes must not reorder experiments. */
  listExperiments(taskId: string): Experiment[];

  appendCommandExecution(execution: CommandExecution): void;
  listCommandExecutions(experimentId: string): CommandExecution[];

  appendMeasurement(measurement: Measurement): void;
  listMeasurements(experimentId: string): Measurement[];
}
