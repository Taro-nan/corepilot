import { randomUUID } from 'node:crypto';
import {
  EventType,
  SCHEMA_VERSION,
  TaskStatus,
} from '../contracts/index.js';
import type {
  Event,
  MockScenario,
  RunnerJob,
  Target,
  Task,
} from '../contracts/index.js';
import type { ReconcileResult, Runner, RunResult } from '../runner/runner.js';
import { MockRunner } from '../runner/mock-runner.js';
import type { TaskStore } from '../storage/task-store.js';
import { ApiError } from './api-error.js';
import { assertTransition } from './state-machine.js';

const REMOTE_JOB_NOT_FOUND = 'REMOTE_JOB_NOT_FOUND_AFTER_RESTART';

export interface TaskHostOptions {
  tickMs?: number;
  retryIntervalMs?: number;
  slowRunMs?: number;
  leaseTtlMs?: number;
  /** Heartbeat interval; defaults to leaseTtlMs / 3 (must be < TTL). */
  heartbeatIntervalMs?: number;
  /** Creates a Runner for a job. Defaults to a MockRunner for the job's scenario. */
  runnerFactory?: (job: RunnerJob) => Runner;
}

export interface CreateTaskResult {
  task: Task;
  job: RunnerJob;
  replayed: boolean;
}

export interface CancelResult {
  task_id: string;
  status: 'cancelled' | 'cancel_requested' | 'already_cancelled';
}

export interface RetryResult {
  task_id: string;
  job_id: string;
  attempt_number: number;
}

export interface ResumeResult {
  task_id: string;
  status: 'resumed' | 'already_resumed';
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE');
}

export class TaskHost {
  private readonly options: Required<Omit<TaskHostOptions, 'runnerFactory'>> & {
    runnerFactory: (job: RunnerJob) => Runner;
  };
  readonly ownerId = randomUUID();
  private readonly runners = new Map<string, Runner>();
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly stopController = new AbortController();
  private stopping = false;
  private leaseLost = false;
  private schedulerPromise: Promise<void> | null = null;
  private lastLeaseRenew = 0;
  private leaseAcquired = false;
  private storeClosed = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly store: TaskStore,
    options: TaskHostOptions = {},
  ) {
    const leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.options = {
      tickMs: options.tickMs ?? 200,
      retryIntervalMs: options.retryIntervalMs ?? 60_000,
      slowRunMs: options.slowRunMs ?? 30_000,
      leaseTtlMs,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? Math.max(1, Math.floor(leaseTtlMs / 3)),
      runnerFactory: options.runnerFactory ?? ((job) => new MockRunner(job.scenario, { slowRunMs: options.slowRunMs })),
    };
  }

  /** true while the host still owns its lease (false once the lease is lost). */
  get healthy(): boolean {
    return !this.leaseLost;
  }

  async start(): Promise<void> {
    try {
      this.store.init();
      if (!this.store.tryAcquireLease(this.ownerId, this.options.leaseTtlMs)) {
        throw new ApiError(409, 'LEASE_HELD', 'another task host already holds the lease for this database');
      }
      this.leaseAcquired = true;
      this.lastLeaseRenew = Date.now();
      await this.recover();
      this.schedulerPromise = this.schedulerLoop();
    } catch (err) {
      // Startup owns its cleanup. In particular, preserve LEASE_HELD instead
      // of letting a caller's second DatabaseSync.close() mask it with
      // "database is not open".
      this.releaseLeaseOnce(true);
      this.closeStoreOnce(true);
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    let failure: unknown;
    try {
      // Mark in-flight runs as CANCEL_REQUESTED so the aborted run settles as
      // CANCELLED rather than being left RUNNING.
      for (const [jobId, controller] of this.activeRuns) {
        const job = this.store.getJob(jobId);
        if (job) {
          const task = this.store.getTask(job.task_id);
          if (task && task.status === TaskStatus.RUNNING) {
            this.transition(job.task_id, jobId, TaskStatus.CANCEL_REQUESTED, 'host shutting down');
          }
        }
        controller.abort();
      }
      if (this.schedulerPromise) {
        await this.schedulerPromise;
      }
    } catch (err) {
      failure = err;
    } finally {
      // Even if status settlement failed, make every run observe shutdown and
      // always release the lease before the managed HTTP listener disappears.
      for (const controller of this.activeRuns.values()) controller.abort();
      try {
        this.releaseLeaseOnce(false);
      } catch (err) {
        failure ??= err;
      }
      try {
        this.closeStoreOnce(false);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  /**
   * Simulates an unclean exit (crash): stops the scheduler without releasing
   * the lease. The lease is left to expire naturally; another host may take
   * over once the TTL elapses. Used by tests and recovery tooling.
   */
  async crash(): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    for (const controller of this.activeRuns.values()) {
      controller.abort();
    }
    if (this.schedulerPromise) {
      await this.schedulerPromise;
    }
    // Intentionally do not release the durable lease on a crash simulation.
    this.leaseAcquired = false;
    this.closeStoreOnce(false);
  }

  private releaseLeaseOnce(ignoreErrors: boolean): void {
    if (!this.leaseAcquired) return;
    this.leaseAcquired = false;
    try {
      this.store.releaseLease(this.ownerId);
    } catch (err) {
      if (!ignoreErrors) throw err;
    }
  }

  private closeStoreOnce(ignoreErrors: boolean): void {
    if (this.storeClosed) return;
    this.storeClosed = true;
    try {
      this.store.close();
    } catch (err) {
      if (!ignoreErrors) throw err;
    }
  }

  // ---- API surface (synchronous) ----

  createTask(
    requestId: string | undefined,
    scenario: MockScenario,
    target: Target,
  ): CreateTaskResult {
    const effectiveRequestId = requestId ?? randomUUID();

    const existing = this.store.getTaskByRequestId(effectiveRequestId);
    if (existing) {
      const job = this.store.getJobByTaskId(existing.task_id);
      if (!job) {
        throw new ApiError(500, 'INTERNAL', `task ${existing.task_id} exists but has no job`);
      }
      return { task: existing, job, replayed: true };
    }

    const taskId = randomUUID();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const isMock = true;

    const task: Task = {
      schema_version: SCHEMA_VERSION,
      task_id: taskId,
      request_id: effectiveRequestId,
      status: TaskStatus.PENDING,
      target,
      is_mock: isMock,
      created_at: now,
      updated_at: now,
      error: null,
      next_check_at: null,
      availability_reason: null,
      report_path: null,
    };
    const job: RunnerJob = {
      schema_version: SCHEMA_VERSION,
      job_id: jobId,
      task_id: taskId,
      request_id: effectiveRequestId,
      scenario,
      status: TaskStatus.PENDING,
      attempt_number: 1,
      is_mock: isMock,
      created_at: now,
      updated_at: now,
      error: null,
    };

    try {
      this.store.createTaskWithJob(
        task,
        this.makeEvent(EventType.TASK_CREATED, taskId, null, { request_id: effectiveRequestId, is_mock: isMock }),
        job,
        this.makeEvent(EventType.JOB_CREATED, taskId, jobId, { scenario, attempt_number: 1, is_mock: isMock }),
      );
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        const t = this.store.getTaskByRequestId(effectiveRequestId);
        if (t) {
          const j = this.store.getJobByTaskId(t.task_id);
          if (j) return { task: t, job: j, replayed: true };
        }
      }
      throw err;
    }

    return { task, job, replayed: false };
  }

  getTask(taskId: string): Task | null {
    return this.store.getTask(taskId);
  }

  getJob(taskId: string): RunnerJob | null {
    return this.store.getJobByTaskId(taskId);
  }

  listEvents(taskId: string): Event[] {
    return this.store.listEvents(taskId);
  }

  /** All tasks (newest first) for the client task list. */
  listTasks(): Task[] {
    return this.store
      .listTasksByStatus([
        TaskStatus.PENDING,
        TaskStatus.WAITING_FOR_RESOURCES,
        TaskStatus.RUNNING,
        TaskStatus.COMPLETED,
        TaskStatus.FAILED,
        TaskStatus.CANCEL_REQUESTED,
        TaskStatus.CANCELLED,
        TaskStatus.RECOVERING,
      ])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  /** Record a backend-generated local report artifact path for a task. */
  setReportPath(taskId: string, reportPath: string): void {
    this.store.updateTaskReportPath(taskId, reportPath);
  }

  cancel(taskId: string, commandId: string): CancelResult {
    const replayed = this.replayCommand(commandId);
    if (replayed) return JSON.parse(replayed) as CancelResult;

    const task = this.requireTask(taskId);
    const job = this.store.getJobByTaskId(taskId);

    let result: CancelResult;
    if (task.status === TaskStatus.PENDING || task.status === TaskStatus.WAITING_FOR_RESOURCES) {
      this.transition(taskId, job?.job_id ?? null, TaskStatus.CANCELLED, 'cancelled before execution');
      result = { task_id: taskId, status: 'cancelled' };
    } else if (task.status === TaskStatus.RUNNING) {
      this.transition(taskId, job?.job_id ?? null, TaskStatus.CANCEL_REQUESTED, 'cancel requested');
      const controller = this.activeRuns.get(job?.job_id ?? '');
      controller?.abort();
      result = { task_id: taskId, status: 'cancel_requested' };
    } else if (task.status === TaskStatus.CANCEL_REQUESTED || task.status === TaskStatus.CANCELLED) {
      result = { task_id: taskId, status: 'already_cancelled' };
    } else {
      throw new ApiError(409, 'INVALID_STATE', `cannot cancel task in status ${task.status}`);
    }

    this.saveCommand(commandId, taskId, 'cancel', result);
    return result;
  }

  retry(taskId: string, commandId: string): RetryResult {
    const replayed = this.replayCommand(commandId);
    if (replayed) return JSON.parse(replayed) as RetryResult;

    const task = this.requireTask(taskId);
    if (task.status !== TaskStatus.FAILED) {
      if (task.status === TaskStatus.COMPLETED) {
        throw new ApiError(409, 'COMPLETED_CANNOT_RETRY', 'completed tasks cannot be retried');
      }
      throw new ApiError(409, 'INVALID_STATE', `cannot retry task in status ${task.status}`);
    }

    const attemptNumber = this.store.nextAttemptNumber(taskId);
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: RunnerJob = {
      schema_version: SCHEMA_VERSION,
      job_id: jobId,
      task_id: taskId,
      request_id: task.request_id,
      scenario: (this.store.getJobByTaskId(taskId)?.scenario ?? 'success') as MockScenario,
      status: TaskStatus.PENDING,
      attempt_number: attemptNumber,
      is_mock: task.is_mock,
      created_at: now,
      updated_at: now,
      error: null,
    };

    this.store.createJob(job, this.makeEvent(EventType.JOB_CREATED, taskId, jobId, { scenario: job.scenario, attempt_number: attemptNumber, is_mock: task.is_mock }));

    // Task FAILED -> PENDING (explicit retry)
    assertTransition(TaskStatus.FAILED, TaskStatus.PENDING);
    this.store.updateTaskStatus(
      taskId,
      TaskStatus.PENDING,
      null,
      this.makeEvent(EventType.TASK_STATUS_CHANGED, taskId, null, { from: TaskStatus.FAILED, to: TaskStatus.PENDING, is_mock: true }),
    );

    const result: RetryResult = { task_id: taskId, job_id: jobId, attempt_number: attemptNumber };
    this.saveCommand(commandId, taskId, 'retry', result);
    return result;
  }

  resume(taskId: string, commandId: string): ResumeResult {
    const replayed = this.replayCommand(commandId);
    if (replayed) return JSON.parse(replayed) as ResumeResult;

    const task = this.requireTask(taskId);
    if (task.status !== TaskStatus.WAITING_FOR_RESOURCES) {
      throw new ApiError(409, 'INVALID_STATE', `cannot resume task in status ${task.status}`);
    }

    // Trigger an immediate re-check (next_check_at set to now).
    this.store.updateTaskNextCheck(taskId, new Date().toISOString(), task.availability_reason);
    const result: ResumeResult = { task_id: taskId, status: 'resumed' };
    this.saveCommand(commandId, taskId, 'resume', result);
    return result;
  }

  // ---- scheduler ----

  private async schedulerLoop(): Promise<void> {
    while (!this.stopping) {
      this.renewLeaseIfDue();
      if (this.leaseLost) {
        break;
      }
      try {
        await this.tickOnce();
      } catch (err) {
        // log and keep going; the loop is the background worker
        console.error('[phyopt-host] scheduler error:', (err as Error).message);
      }
      await this.interruptibleSleep(this.options.tickMs);
    }
  }

  private interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      this.stopController.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private async tickOnce(): Promise<void> {
    const candidates = this.store.listTasksByStatus([
      TaskStatus.PENDING,
      TaskStatus.WAITING_FOR_RESOURCES,
    ]);
    const now = Date.now();
    const task = candidates.find(
      (t) =>
        t.status === TaskStatus.PENDING ||
        (t.status === TaskStatus.WAITING_FOR_RESOURCES && t.next_check_at !== null && Date.parse(t.next_check_at) <= now),
    );
    if (!task) return;

    if (task.status === TaskStatus.PENDING) {
      await this.processPending(task);
    } else if (task.status === TaskStatus.WAITING_FOR_RESOURCES) {
      await this.processWaiting(task);
    }
  }

  private async processPending(task: Task): Promise<void> {
    const job = this.store.getJobByTaskId(task.task_id);
    if (!job) return;
    let runner: Runner;
    try {
      runner = this.runnerFor(job);
    } catch (err) {
      // Runner construction failed (e.g. bound context mutated): fail the task,
      // never retry in a loop.
      this.transition(task.task_id, job.job_id, TaskStatus.FAILED, (err as Error).message);
      return;
    }

    const availability = runner.checkAvailability(task.target);
    this.store.appendEvent(
      this.makeEvent(EventType.AVAILABILITY_CHECKED, task.task_id, job.job_id, {
        available: availability.available,
        reason: availability.reason,
        is_mock: true,
      }),
    );

    if (!availability.available) {
      this.transition(task.task_id, job.job_id, TaskStatus.WAITING_FOR_RESOURCES, availability.reason);
      this.store.updateTaskNextCheck(task.task_id, new Date(Date.now() + this.options.retryIntervalMs).toISOString(), availability.reason);
      return;
    }

    if (!this.store.claimTask(task.task_id, TaskStatus.PENDING, TaskStatus.RUNNING)) {
      return;
    }
    this.recordStatusChange(task.task_id, job.job_id, TaskStatus.PENDING, TaskStatus.RUNNING, null);
    await this.runJob(task.task_id, job.job_id);
  }

  private async processWaiting(task: Task): Promise<void> {
    const job = this.store.getJobByTaskId(task.task_id);
    if (!job) return;
    let runner: Runner;
    try {
      runner = this.runnerFor(job);
    } catch (err) {
      this.transition(task.task_id, job.job_id, TaskStatus.FAILED, (err as Error).message);
      return;
    }

    const availability = runner.checkAvailability(task.target);
    this.store.appendEvent(
      this.makeEvent(EventType.AVAILABILITY_CHECKED, task.task_id, job.job_id, {
        available: availability.available,
        reason: availability.reason,
        is_mock: true,
      }),
    );

    if (!availability.available) {
      this.store.updateTaskNextCheck(task.task_id, new Date(Date.now() + this.options.retryIntervalMs).toISOString(), availability.reason);
      return;
    }

    if (!this.store.claimTask(task.task_id, TaskStatus.WAITING_FOR_RESOURCES, TaskStatus.RUNNING)) {
      return;
    }
    this.recordStatusChange(task.task_id, job.job_id, TaskStatus.WAITING_FOR_RESOURCES, TaskStatus.RUNNING, null);
    await this.runJob(task.task_id, job.job_id);
  }

  private async runJob(taskId: string, jobId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    const job = this.store.getJob(jobId);
    if (!task || !job) return;

    const runner = this.runnerFor(job);
    const controller = new AbortController();
    this.activeRuns.set(jobId, controller);

    try {
      const raw = runner.run(job, task.target, controller.signal);
      const result: RunResult = raw instanceof Promise ? await raw : raw;
      if (result.report_path) {
        this.store.updateTaskReportPath(taskId, result.report_path);
      }
      this.store.appendEvent(
        this.makeEvent(EventType.RUNNER_EXECUTED, taskId, jobId, {
          ok: result.ok,
          cancelled: result.cancelled,
          error: result.error,
          is_mock: job.is_mock,
        }),
      );
      this.finishRun(taskId, jobId, result);
    } finally {
      this.activeRuns.delete(jobId);
    }
  }

  private finishRun(taskId: string, jobId: string, result: RunResult): void {
    const fresh = this.store.getTask(taskId);
    if (!fresh) return;

    let to: TaskStatus;
    let error: string | null;
    if (result.remote_state === 'unknown') {
      // The local connection closed but the remote stop was NOT confirmed. Keep
      // the task RECOVERING and retain the target resource occupation; never
      // claim CANCELLED, never auto-rerun.
      to = TaskStatus.RECOVERING;
      error = result.error ?? 'remote stop unconfirmed';
    } else if (result.cancelled) {
      // The runner CONFIRMED the stop (e.g. AbortSignal stopped it between
      // commands). Only then is CANCELLED honest.
      to = TaskStatus.CANCELLED;
      error = result.error ?? 'cancelled';
    } else if (fresh.status === TaskStatus.CANCEL_REQUESTED) {
      // Cancel requested, but the runner did NOT confirm a stop: the remote
      // command completed or its state is unknown. Never claim CANCELLED;
      // reflect the run's actual outcome (cancel lost the race).
      if (result.ok) {
        to = TaskStatus.COMPLETED;
        error = null;
      } else {
        to = TaskStatus.FAILED;
        error = result.error ?? 'cancel not confirmed';
      }
    } else if (result.ok) {
      to = TaskStatus.COMPLETED;
      error = null;
    } else {
      to = TaskStatus.FAILED;
      error = result.error;
    }

    assertTransition(fresh.status, to);
    this.recordStatusChange(taskId, jobId, fresh.status, to, error);
  }

  private async recover(): Promise<void> {
    const statuses = [
      TaskStatus.RUNNING,
      TaskStatus.CANCEL_REQUESTED,
      TaskStatus.RECOVERING,
    ] as const;
    const tasks = this.store.listTasksByStatus(statuses);

    for (const task of tasks) {
      const job = this.store.getJobByTaskId(task.task_id);
      if (!job) continue;

      if (task.status === TaskStatus.CANCEL_REQUESTED) {
        await this.recoverCancelRequested(task, job);
        continue;
      }

      // RUNNING or RECOVERING -> RECOVERING, then reconcile
      if (task.status === TaskStatus.RUNNING) {
        this.transition(task.task_id, job.job_id, TaskStatus.RECOVERING, 'host restarted');
      }

      const runner = this.runnerFor(job);
      const reconcile = runner.reconcile ? await runner.reconcile(job) : 'UNKNOWN';
      this.store.appendEvent(
        this.makeEvent(EventType.RECONCILE_RESULT, task.task_id, job.job_id, { result: reconcile, is_mock: true }),
      );

      switch (reconcile) {
        case 'RUNNING':
          this.transition(task.task_id, job.job_id, TaskStatus.RUNNING, null);
          break;
        case 'COMPLETED':
          this.transition(task.task_id, job.job_id, TaskStatus.COMPLETED, null);
          break;
        case 'FAILED':
          this.transition(task.task_id, job.job_id, TaskStatus.FAILED, 'remote job failed');
          break;
        case 'CANCELLED':
          this.transition(task.task_id, job.job_id, TaskStatus.CANCELLED, 'remote stop confirmed');
          break;
        case 'NOT_FOUND':
          this.transition(task.task_id, job.job_id, TaskStatus.FAILED, REMOTE_JOB_NOT_FOUND);
          this.store.appendEvent(
            this.makeEvent(EventType.RECOVERY_FAILED, task.task_id, job.job_id, {
              reason: REMOTE_JOB_NOT_FOUND,
              is_mock: true,
            }),
          );
          break;
        case 'UNKNOWN':
        default:
          // keep RECOVERING; do not re-submit
          this.store.appendEvent(
            this.makeEvent(EventType.RECOVERY_FAILED, task.task_id, job.job_id, {
              reason: 'RECONCILE_UNKNOWN',
              is_mock: true,
            }),
          );
          break;
      }
    }
  }

  /**
   * Reconciles a CANCEL_REQUESTED task after a restart. The pending cancel
   * intent is never applied blindly: the remote state decides the outcome.
   */
  private async recoverCancelRequested(task: Task, job: RunnerJob): Promise<void> {
    const runner = this.runnerFor(job);
    this.store.appendEvent(
      this.makeEvent(EventType.CANCEL_RECONCILE_STARTED, task.task_id, job.job_id, { is_mock: true }),
    );

    const reconcile = runner.reconcile ? await runner.reconcile(job) : 'UNKNOWN';

    switch (reconcile) {
      case 'RUNNING': {
        // still running remotely: re-issue the cancel and confirm the stop
        this.store.appendEvent(
          this.makeEvent(EventType.CANCEL_REISSUED, task.task_id, job.job_id, { is_mock: true }),
        );
        runner.cancel?.(job);
        const deadline = Date.now() + 30_000;
        let state: ReconcileResult = 'RUNNING';
        while (state === 'RUNNING' && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          state = runner.reconcile ? await runner.reconcile(job) : 'UNKNOWN';
        }
        if (state === 'CANCELLED' || state === 'NOT_FOUND') {
          this.transition(task.task_id, job.job_id, TaskStatus.CANCELLED, 'remote stop confirmed');
          this.store.appendEvent(
            this.makeEvent(EventType.CANCEL_CONFIRMED, task.task_id, job.job_id, { is_mock: true }),
          );
        } else if (state === 'COMPLETED') {
          this.transition(task.task_id, job.job_id, TaskStatus.COMPLETED, null);
          this.store.appendEvent(
            this.makeEvent(EventType.CANCEL_LOST_RACE, task.task_id, job.job_id, { reason: 'cancel raced with completion', is_mock: true }),
          );
        } else if (state === 'FAILED') {
          this.transition(task.task_id, job.job_id, TaskStatus.FAILED, 'remote job failed');
        } else {
          this.transition(task.task_id, job.job_id, TaskStatus.RECOVERING, 'cancel recovery blocked');
          this.store.appendEvent(
            this.makeEvent(EventType.CANCEL_RECOVERY_BLOCKED, task.task_id, job.job_id, { is_mock: true }),
          );
        }
        break;
      }
      case 'NOT_FOUND': {
        // remote job no longer exists; safe to mark CANCELLED
        this.transition(task.task_id, job.job_id, TaskStatus.CANCELLED, REMOTE_JOB_NOT_FOUND);
        this.store.appendEvent(
          this.makeEvent(EventType.CANCEL_CONFIRMED, task.task_id, job.job_id, {
            reason: REMOTE_JOB_NOT_FOUND,
            is_mock: true,
          }),
        );
        break;
      }
      case 'COMPLETED': {
        // cancel lost the race against completion; do not fake a cancel
        this.transition(task.task_id, job.job_id, TaskStatus.COMPLETED, null);
        this.store.appendEvent(
          this.makeEvent(EventType.CANCEL_LOST_RACE, task.task_id, job.job_id, {
            reason: 'cancel raced with completion',
            is_mock: true,
          }),
        );
        break;
      }
      case 'FAILED':
        this.transition(task.task_id, job.job_id, TaskStatus.FAILED, 'remote job failed');
        break;
      case 'UNKNOWN':
      default:
        // keep blocked/recovering; never CANCELLED, never re-run
        this.transition(task.task_id, job.job_id, TaskStatus.RECOVERING, 'cancel recovery blocked');
        this.store.appendEvent(
          this.makeEvent(EventType.CANCEL_RECOVERY_BLOCKED, task.task_id, job.job_id, { is_mock: true }),
        );
        break;
    }
  }

  // ---- helpers ----

  private runnerFor(job: RunnerJob): Runner {
    let runner = this.runners.get(job.task_id);
    if (!runner) {
      runner = this.options.runnerFactory(job);
      this.runners.set(job.task_id, runner);
    }
    return runner;
  }

  private transition(taskId: string, jobId: string | null, to: TaskStatus, error: string | null): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    assertTransition(task.status, to);
    this.recordStatusChange(taskId, jobId, task.status, to, error);
  }

  private recordStatusChange(taskId: string, jobId: string | null, from: TaskStatus, to: TaskStatus, error: string | null): void {
    this.store.updateTaskStatus(
      taskId,
      to,
      error,
      this.makeEvent(EventType.TASK_STATUS_CHANGED, taskId, null, { from, to, is_mock: true }),
    );
    if (jobId) {
      const job = this.store.getJob(jobId);
      if (job) {
        this.store.updateJobStatus(
          jobId,
          to,
          error,
          this.makeEvent(EventType.JOB_STATUS_CHANGED, taskId, jobId, { from, to, is_mock: true }),
        );
      }
    }
  }

  private replayCommand(commandId: string): string | null {
    const record = this.store.getCommand(commandId);
    return record ? record.result_json : null;
  }

  private saveCommand(commandId: string, taskId: string, kind: 'cancel' | 'retry' | 'resume', result: unknown): void {
    this.store.createCommand({
      command_id: commandId,
      task_id: taskId,
      kind,
      result_json: JSON.stringify(result),
      created_at: new Date().toISOString(),
    });
  }

  private requireTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new ApiError(404, 'TASK_NOT_FOUND', `task '${taskId}' not found`);
    }
    return task;
  }

  private renewLeaseIfDue(): void {
    if (this.leaseLost) return;
    if (Date.now() - this.lastLeaseRenew < this.options.heartbeatIntervalMs) return;

    const renewed = this.store.renewLease(this.ownerId, this.options.leaseTtlMs);
    if (renewed) {
      this.lastLeaseRenew = Date.now();
      return;
    }

    // The lease is gone (taken over or expired without us). Stop claiming
    // work and enter an unhealthy state; never schedule a Runner again.
    this.leaseLost = true;
    console.error(
      `[phyopt-host] lease lost for owner ${this.ownerId}; entering unhealthy state and stopping scheduling`,
    );
  }

  private makeEvent(type: EventType, taskId: string, jobId: string | null, payload: Record<string, unknown>): Event {
    return {
      schema_version: SCHEMA_VERSION,
      event_id: randomUUID(),
      task_id: taskId,
      job_id: jobId,
      type,
      payload,
      created_at: new Date().toISOString(),
    };
  }
}
