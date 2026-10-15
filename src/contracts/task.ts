import type { Target } from './target.js';

export const TaskStatus = {
  PENDING: 'PENDING',
  WAITING_FOR_RESOURCES: 'WAITING_FOR_RESOURCES',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  RECOVERING: 'RECOVERING',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export type MockScenario =
  | 'success'
  | 'failure'
  | 'no-resources'
  | 'unavailable-then-success'
  | 'slow';

export const MOCK_SCENARIOS: readonly MockScenario[] = [
  'success',
  'failure',
  'no-resources',
  'unavailable-then-success',
  'slow',
];

export interface Task {
  schema_version: number;
  task_id: string;
  request_id: string;
  status: TaskStatus;
  target: Target;
  is_mock: boolean;
  created_at: string;
  updated_at: string;
  error: string | null;
  next_check_at: string | null;
  availability_reason: string | null;
  /** Backend-recorded local report artifact path (null when none). */
  report_path: string | null;
}
