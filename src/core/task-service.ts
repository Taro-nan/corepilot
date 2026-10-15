import { randomUUID } from 'node:crypto';
import {
  EventType,
  SCHEMA_VERSION,
  TaskStatus,
} from '../contracts/index.js';
import type { Event, MockScenario, RunnerJob, Target, Task } from '../contracts/index.js';
import type { Runner } from '../runner/runner.js';
import type { TaskStore } from '../storage/task-store.js';
import { assertTransition } from './state-machine.js';

export interface RunMockOptions {
  requestId?: string;
  scenario: MockScenario;
  target: Target;
  runner: Runner;
}

export interface RunOutcome {
  task: Task;
  job: RunnerJob;
  /** true when runner.run() was actually invoked (false for no-resources or idempotent replay). */
  ran: boolean;
  /** true when this call replayed an existing request_id instead of creating a new task. */
  replayed: boolean;
}

export class TaskService {
  constructor(private readonly store: TaskStore) {}

  init(): void {
    this.store.init();
  }

  close(): void {
    this.store.close();
  }

  /**
   * Create and run a mock optimization task.
   *
   * Idempotency is keyed on `request_id` (caller-provided or auto-generated),
   * never on the random `job_id`. A repeated `request_id` returns the existing
   * task/job and does not create a new task or invoke the runner.
   */
  runMock(options: RunMockOptions): RunOutcome {
    const { requestId, scenario, target, runner } = options;
    const effectiveRequestId = requestId ?? randomUUID();

    const existing = this.store.getTaskByRequestId(effectiveRequestId);
    if (existing) {
      const job = this.store.getJobByTaskId(existing.task_id);
      if (!job) {
        throw new Error(`task ${existing.task_id} exists but has no job`);
      }
      return { task: existing, job, ran: false, replayed: true };
    }

    const taskId = randomUUID();
    const jobId = randomUUID();

    const task: Task = {
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      request_id: effectiveRequestId,
      status: TaskStatus.PENDING,
      target,
      is_mock: true,
      created_at: this.now(),
      updated_at: this.now(),
      error: null,
      next_check_at: null,
      availability_reason: null,
      report_path: null,
    };
    this.store.createTask(
      task,
      this.makeEvent(EventType.TASK_CREATED, taskId, null, { request_id: effectiveRequestId, is_mock: true }),
    );

    const job: RunnerJob = {
      schema_version: SCHEMA_VERSION,
      job_id: jobId,
      task_id: taskId,
      request_id: effectiveRequestId,
      scenario,
      status: TaskStatus.PENDING,
      attempt_number: 1,
      is_mock: true,
      created_at: this.now(),
      updated_at: this.now(),
      error: null,
    };
    this.store.createJob(
      job,
      this.makeEvent(EventType.JOB_CREATED, taskId, jobId, { scenario, attempt_number: 1, is_mock: true }),
    );

    // Phase 1: resource pre-check. No execution happens here.
    const availability = runner.checkAvailability(target);
    this.store.appendEvent(
      this.makeEvent(EventType.AVAILABILITY_CHECKED, taskId, jobId, {
        available: availability.available,
        reason: availability.reason,
        is_mock: true,
      }),
    );

    if (!availability.available) {
      this.setTaskStatus(task, TaskStatus.WAITING_FOR_RESOURCES, availability.reason);
      this.setJobStatus(job, TaskStatus.WAITING_FOR_RESOURCES, availability.reason);
      this.store.updateTaskNextCheck(taskId, null, availability.reason);
      return { task, job, ran: false, replayed: false };
    }

    this.setTaskStatus(task, TaskStatus.RUNNING, null);
    this.setJobStatus(job, TaskStatus.RUNNING, null);

    // Phase 2: actual (mock) execution. Local mode only supports synchronous
    // scenarios, so a Promise result here is a programming error.
    const rawResult = runner.run(job, target);
    if (rawResult instanceof Promise) {
      throw new Error('async runner scenario is not supported in local (non-host) mode');
    }
    const result = rawResult;
    this.store.appendEvent(
      this.makeEvent(EventType.RUNNER_EXECUTED, taskId, jobId, {
        ok: result.ok,
        cancelled: result.cancelled,
        error: result.error,
        is_mock: true,
      }),
    );

    if (result.cancelled) {
      this.setTaskStatus(task, TaskStatus.CANCELLED, result.error);
      this.setJobStatus(job, TaskStatus.CANCELLED, result.error);
    } else if (result.ok) {
      this.setTaskStatus(task, TaskStatus.COMPLETED, null);
      this.setJobStatus(job, TaskStatus.COMPLETED, null);
    } else {
      this.setTaskStatus(task, TaskStatus.FAILED, result.error);
      this.setJobStatus(job, TaskStatus.FAILED, result.error);
    }

    return { task, job, ran: true, replayed: false };
  }

  getTask(taskId: string): Task | null {
    return this.store.getTask(taskId);
  }

  getJobByTaskId(taskId: string): RunnerJob | null {
    return this.store.getJobByTaskId(taskId);
  }

  listEvents(taskId: string): Event[] {
    return this.store.listEvents(taskId);
  }

  private setTaskStatus(task: Task, to: TaskStatus, error: string | null): void {
    assertTransition(task.status, to);
    const from = task.status;
    const event = this.makeEvent(EventType.TASK_STATUS_CHANGED, task.task_id, null, {
      from,
      to,
      is_mock: true,
    });
    this.store.updateTaskStatus(task.task_id, to, error, event);
    task.status = to;
    task.error = error;
    task.updated_at = event.created_at;
  }

  private setJobStatus(job: RunnerJob, to: TaskStatus, error: string | null): void {
    assertTransition(job.status, to);
    const from = job.status;
    const event = this.makeEvent(EventType.JOB_STATUS_CHANGED, job.task_id, job.job_id, {
      from,
      to,
      is_mock: true,
    });
    this.store.updateJobStatus(job.job_id, to, error, event);
    job.status = to;
    job.error = error;
    job.updated_at = event.created_at;
  }

  private makeEvent(
    type: EventType,
    taskId: string,
    jobId: string | null,
    payload: Record<string, unknown>,
  ): Event {
    return {
      schema_version: SCHEMA_VERSION,
      event_id: randomUUID(),
      task_id: taskId,
      job_id: jobId,
      type,
      payload,
      created_at: this.now(),
    };
  }

  private now(): string {
    return new Date().toISOString();
  }
}
