export type CommandKind = 'cancel' | 'retry' | 'resume';

/**
 * Idempotency record for cancel/retry/resume operations. A repeated
 * `command_id` returns the stored result instead of re-executing.
 */
export interface CommandRecord {
  command_id: string;
  task_id: string;
  kind: CommandKind;
  result_json: string;
  created_at: string;
}
