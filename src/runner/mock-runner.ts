import type { MockScenario, RunnerJob, Target } from '../contracts/index.js';
import type { AvailabilityResult, ReconcileResult, RunResult, Runner } from './runner.js';

export interface MockRunnerOptions {
  /** Duration of the `slow` scenario's run (default 30s). */
  slowRunMs?: number;
}

/**
 * Deterministic mock runner. Never touches a real ARM server.
 *
 * Scenarios:
 *  - success                 -> availability granted, run() succeeds
 *  - failure                 -> availability granted, run() fails
 *  - no-resources            -> availability denied forever, run() never invoked
 *  - unavailable-then-success-> first availability check denied, second granted
 *  - slow                    -> run() blocks (respecting AbortSignal), then succeeds
 *
 * The runner keeps internal state for `unavailable-then-success`, so a single
 * runner instance must be reused across availability checks for one task.
 * Every result is explicitly marked as mock output.
 */
export class MockRunner implements Runner {
  private availabilityChecks = 0;
  private readonly slowRunMs: number;

  constructor(
    private readonly scenario: MockScenario,
    options: MockRunnerOptions = {},
  ) {
    this.slowRunMs = options.slowRunMs ?? 30_000;
  }

  checkAvailability(_target: Target): AvailabilityResult {
    if (this.scenario === 'no-resources') {
      return { available: false, reason: '[MOCK] resource unavailable (simulated)' };
    }
    if (this.scenario === 'unavailable-then-success') {
      this.availabilityChecks += 1;
      if (this.availabilityChecks === 1) {
        return { available: false, reason: '[MOCK] resource unavailable (first check, simulated)' };
      }
      return { available: true, reason: '[MOCK] availability granted (subsequent check, simulated)' };
    }
    return { available: true, reason: '[MOCK] availability granted (simulated)' };
  }

  run(_job: RunnerJob, _target: Target, signal?: AbortSignal): Promise<RunResult> | RunResult {
    if (this.scenario === 'slow') {
      return this.slowRun(signal);
    }
    if (this.scenario === 'failure') {
      return { ok: false, cancelled: false, error: '[MOCK] simulated execution failure' };
    }
    return { ok: true, cancelled: false, error: null };
  }

  cancel(_job: RunnerJob): void {
    // Mock has no remote process to stop; cancellation is delivered via the
    // AbortSignal passed to run().
  }

  reconcile(_job: RunnerJob): ReconcileResult {
    // Mock holds no persistent remote state, so after a host restart a
    // previously running job can no longer be found.
    return 'NOT_FOUND';
  }

  private async slowRun(signal?: AbortSignal): Promise<RunResult> {
    await abortableSleep(this.slowRunMs, signal);
    if (signal?.aborted) {
      return { ok: false, cancelled: true, error: '[MOCK] cancelled by request' };
    }
    return { ok: true, cancelled: false, error: null };
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort);
  });
}
