import type { CommandExecution, ExperimentStatus, Measurement } from '../contracts/optimization-domain.js';
import type { ExperimentExecutionPlan, RunnerFailure, RunnerQueueState } from '../contracts/runner-rpc.js';

/** Runner-local durable execution state around the shared Experiment object. */
export interface ExecutionStateRecord {
  experiment: ExperimentExecutionPlan['experiment'];
  candidate?: ExperimentExecutionPlan['candidate'];
  evaluator?: ExperimentExecutionPlan['evaluator'];
  steps: ExperimentExecutionPlan['steps'];
  output_directory?: string;
  build_directory?: string;
  current_step: CommandExecution['step'] | null;
  cancel_requested: boolean;
  failure: RunnerFailure | null;
  queue?: RunnerQueueState;
}

export interface RunnerStore {
  init(): void;
  close(): void;
  resolveRunnerIdentity(preferredId?: string): string;
  allocateQueueSequence(): number;
  createExecution(record: ExecutionStateRecord): void;
  saveExecution(record: ExecutionStateRecord): void;
  getExecution(experimentId: string): ExecutionStateRecord | null;
  listExecutions(statuses?: readonly ExperimentStatus[]): ExecutionStateRecord[];
  recoverInterruptedExecutions(timestamp: string): number;
  appendCommandExecution(execution: CommandExecution): void;
  listCommandExecutions(experimentId: string): CommandExecution[];
  appendMeasurement(measurement: Measurement): void;
  listMeasurements(experimentId: string): Measurement[];
}
