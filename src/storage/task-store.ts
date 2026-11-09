import type { CommandRecord } from '../contracts/command.js';
import type { Event, RunnerJob, Task, TaskStatus } from '../contracts/index.js';
import type { OptimizationStore } from './optimization-store.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { ExecutionMachineRecord } from '../contracts/execution-machine.js';
import type { Candidate, Experiment, OptimizationTask } from '../contracts/optimization-domain.js';
import type { OptimizationWorkflowRecord, WorkflowExecutionOutcomePatch, WorkflowExperimentIntent } from '../contracts/workflow.js';
import type { OptimizationIntakeStatus } from '../contracts/optimization-intake.js';

export interface LeaseRecord {
  owner_id: string;
  expires_at: string;
}

/** 通用任务与 public workflow 的持久化边界。 */
export interface TaskStore extends OptimizationStore {
  init(): void;
  close(): void;
  createTaskWithJob(task: Task, taskEvent: Event, job: RunnerJob, jobEvent: Event): void;
  createTask(task: Task, event: Event): void;
  createJob(job: RunnerJob, event: Event): void;
  getTask(taskId: string): Task | null;
  getTaskByRequestId(requestId: string): Task | null;
  updateTaskStatus(taskId: string, status: TaskStatus, error: string | null, event: Event): void;
  updateTaskNextCheck(taskId: string, nextCheckAt: string | null, availabilityReason: string | null): void;
  updateTaskReportPath(taskId: string, reportPath: string): void;
  listTasksByStatus(statuses: readonly TaskStatus[]): Task[];
  claimTask(taskId: string, from: TaskStatus, to: TaskStatus): boolean;
  getJob(jobId: string): RunnerJob | null;
  getJobByTaskId(taskId: string): RunnerJob | null;
  updateJobStatus(jobId: string, status: TaskStatus, error: string | null, event: Event): void;
  nextAttemptNumber(taskId: string): number;
  appendEvent(event: Event): void;
  listEvents(taskId: string): Event[];
  getCommand(commandId: string): CommandRecord | null;
  createCommand(record: CommandRecord): void;
  tryAcquireLease(ownerId: string, ttlMs: number): boolean;
  renewLease(ownerId: string, ttlMs: number): boolean;
  releaseLease(ownerId: string): void;
  getActiveLease(): LeaseRecord | null;
  saveOptimizationWorkflowJson(workflowId: string, workflowJson: string): void;
  /** Atomically create the task and workflow, or return the existing matching request. */
  createOptimizationIntake(task: OptimizationTask, workflow: OptimizationWorkflowRecord): { workflowId: string; created: boolean };
  /** A read can return NOT_FOUND while an earlier submission is still in flight. */
  getOptimizationIntakeStatus(requestId: string): OptimizationIntakeStatus;
  /** Atomically close an uncreated request or return the task that won the race. */
  closeOptimizationIntake(requestId: string): Exclude<OptimizationIntakeStatus, { status: 'NOT_FOUND' }>;
  /** Atomically attach a verified workflow checkpoint, reconciling a recovered candidate identity. */
  attachOptimizationCandidate(workflowId: string, candidate: Candidate): Candidate;
  /** Create and link one fixed formal/independent-validation intent atomically. */
  attachOptimizationExperiment(workflowId: string, experiment: Experiment, intent: WorkflowExperimentIntent): Experiment;
  /** Append a non-retroactive scope authorization when resuming an older source-only task. */
  authorizeLegacySourceContinuation(expectedWorkflowJson: string, workflow: OptimizationWorkflowRecord): void;
  /** Commit the worker outcome and its Task status together without changing experiments or approval. */
  finishOptimizationWorkflow(workflowId: string, taskId: string, patch: WorkflowExecutionOutcomePatch): void;
  /** Save a diagnostic only if this task is still the active workflow. */
  recordWorkflowPersistenceFailure(workflowId: string, taskId: string, message: string): boolean;
  saveRecoveredWorkflow(workflowId: string, workflowJson: string, task: OptimizationTask | null): void;
  /** Create a reproduction and its workflow reference in one transaction, if the workflow has not changed. */
  createReproductionExperiment(experiment: Experiment, expectedWorkflowJson: string, workflowJson: string): void;
  /** Claim one prepared reproduction submission before the first Runner POST. */
  claimReproductionSubmission(workflowId: string, expected: Experiment, plan: Record<string, unknown>, remoteRoot: string, timestamp: string, runnerStoreInstanceId?: string): void;
  /** Patch the linked active reproduction without losing concurrent updates. */
  updateReproduction(workflowId: string, experimentId: string, patch: Partial<Omit<NonNullable<OptimizationWorkflowRecord['reproduction']>, 'experiment_id'>>): boolean;
  saveCompletedDelivery(workflowId: string, workflowJson: string, task: OptimizationTask | null): void;
  getOptimizationWorkflowJson(workflowId: string): string | null;
  listOptimizationWorkflowJson(limit: number): string[];
  listRecoverableWorkflowJson(): string[];
  listPendingDeliveryWorkflowIds(): string[];
  getOptimizationWorkflowByRequestId(requestId: string): string | null;
  listProjects(): ProjectRecord[];
  getProject(projectId: string): ProjectRecord | null;
  saveProject(project: ProjectRecord): void;
  migrateProjectConfigPath(projectId: string, previousPath: string, nextPath: string): void;
  listExecutionMachines(): ExecutionMachineRecord[];
  getExecutionMachine(machineId: string): ExecutionMachineRecord | null;
  saveExecutionMachine(machine: ExecutionMachineRecord, expectedRevision?: number): boolean;
}
