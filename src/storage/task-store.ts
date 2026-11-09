import type { CommandRecord } from '../contracts/command.js';
import type { Event, RunnerJob, Task, TaskStatus } from '../contracts/index.js';
import type { OptimizationStore } from './optimization-store.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { ExecutionMachineRecord } from '../contracts/execution-machine.js';
import type { Experiment, OptimizationTask } from '../contracts/optimization-domain.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';

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
  saveRecoveredWorkflow(workflowId: string, workflowJson: string, task: OptimizationTask | null): void;
  /** Create a reproduction and its workflow reference in one transaction, if the workflow has not changed. */
  createReproductionExperiment(experiment: Experiment, expectedWorkflowJson: string, workflowJson: string): void;
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
