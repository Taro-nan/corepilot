import type { RunnerJob, Target } from '../contracts/index.js';

export interface AvailabilityResult {
  available: boolean;
  reason: string | null;
}

export interface RunResult {
  ok: boolean;
  cancelled: boolean;
  error: string | null;
  /** Local report artifact path produced by the run (null when none). */
  report_path?: string | null;
  /** Set when the remote job's stop was NOT confirmed (local connection closed
   * but the remote command may still be running). The host keeps the task
   * RECOVERING and retains the target resource occupation. */
  remote_state?: 'unknown';
}

export type ReconcileResult = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'NOT_FOUND' | 'UNKNOWN';

/**
 * Runner protocol.
 *
 * - `checkAvailability()` decides whether resources are currently granted.
 *   When unavailable, the task enters WAITING_FOR_RESOURCES and `run()` must
 *   NOT be called.
 * - `run()` performs the execution and must respect the AbortSignal.
 * - `cancel()` asks the runner to stop a running job.
 * - `reconcile()` reports the remote state of a previously running job after
 *   a host restart; it must NOT re-submit work.
 */
export interface Runner {
  checkAvailability(target: Target): AvailabilityResult;
  run(job: RunnerJob, target: Target, signal?: AbortSignal): Promise<RunResult> | RunResult;
  cancel?(job: RunnerJob): void;
  reconcile?(job: RunnerJob): ReconcileResult | Promise<ReconcileResult>;
}
