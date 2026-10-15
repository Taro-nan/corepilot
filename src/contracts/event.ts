export const EventType = {
  TASK_CREATED: 'TASK_CREATED',
  TASK_STATUS_CHANGED: 'TASK_STATUS_CHANGED',
  JOB_CREATED: 'JOB_CREATED',
  JOB_STATUS_CHANGED: 'JOB_STATUS_CHANGED',
  AVAILABILITY_CHECKED: 'AVAILABILITY_CHECKED',
  RUNNER_EXECUTED: 'RUNNER_EXECUTED',
  RECONCILE_RESULT: 'RECONCILE_RESULT',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  CANCEL_RECONCILE_STARTED: 'CANCEL_RECONCILE_STARTED',
  CANCEL_REISSUED: 'CANCEL_REISSUED',
  CANCEL_CONFIRMED: 'CANCEL_CONFIRMED',
  CANCEL_LOST_RACE: 'CANCEL_LOST_RACE',
  CANCEL_RECOVERY_BLOCKED: 'CANCEL_RECOVERY_BLOCKED',
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export interface Event {
  schema_version: number;
  event_id: string;
  task_id: string;
  job_id: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  created_at: string;
  /** Monotonic global sequence assigned by the store on insert. */
  sequence?: number;
}
