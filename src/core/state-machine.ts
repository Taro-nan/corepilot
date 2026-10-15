import { TaskStatus } from '../contracts/index.js';

/**
 * WAITING_FOR_RESOURCES and RECOVERING are recoverable pauses, NOT terminal.
 * Only COMPLETED, FAILED and CANCELLED are terminal.
 *
 * FAILED is the terminal state of a single job (attempt). It never re-runs
 * automatically: the task can only be reopened by an explicit `retry`, which
 * creates a NEW job_id with a new (incremented) attempt_number and returns the
 * task to PENDING. Hence FAILED -> PENDING is legal, but only via retry.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  [TaskStatus.PENDING]: [
    TaskStatus.RUNNING,
    TaskStatus.WAITING_FOR_RESOURCES,
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
  ],
  [TaskStatus.WAITING_FOR_RESOURCES]: [TaskStatus.RUNNING, TaskStatus.CANCELLED, TaskStatus.FAILED],
  [TaskStatus.RUNNING]: [
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCEL_REQUESTED,
    TaskStatus.RECOVERING,
  ],
  [TaskStatus.CANCEL_REQUESTED]: [
    TaskStatus.CANCELLED,
    TaskStatus.FAILED,
    TaskStatus.COMPLETED,
    TaskStatus.RECOVERING,
  ],
  [TaskStatus.RECOVERING]: [
    TaskStatus.RUNNING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.WAITING_FOR_RESOURCES,
  ],
  [TaskStatus.COMPLETED]: [],
  [TaskStatus.FAILED]: [TaskStatus.PENDING],
  [TaskStatus.CANCELLED]: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  TaskStatus.COMPLETED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} -> ${to}`);
  }
}
