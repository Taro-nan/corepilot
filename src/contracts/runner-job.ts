import type { MockScenario, TaskStatus } from './task.js';

export interface RunnerJob {
  schema_version: number;
  job_id: string;
  task_id: string;
  request_id: string;
  scenario: MockScenario;
  status: TaskStatus;
  attempt_number: number;
  is_mock: boolean;
  created_at: string;
  updated_at: string;
  error: string | null;
}
