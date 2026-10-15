import { randomUUID } from 'node:crypto';

/**
 * Thin, replaceable model-provider interface. Providers take a task, a
 * sanitized context and output constraints, and return the raw model output
 * plus call metadata (provider/model/request_id). Providers must support
 * timeout, cancellation (AbortSignal) and bounded retries.
 */
export interface ModelProvider {
  readonly provider: string;
  readonly model: string;
  call(
    task: string,
    context: string,
    outputConstraints: string,
    signal?: AbortSignal,
  ): Promise<ModelCallResult>;
}

export interface ModelCallResult {
  ok: boolean;
  output: string | null;
  provider: string;
  model: string;
  request_id: string;
  attempts: number;
  timed_out: boolean;
  error: string | null;
}

export interface ModelCallOptions {
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_MODEL_CALL_OPTIONS: ModelCallOptions = {
  maxRetries: 2,
  timeoutMs: 30_000,
};

/**
 * Wrap a single-shot `invoke(signal)` with bounded retries and a hard timeout.
 *
 * The invoke callback receives an AbortSignal that is aborted on BOTH a
 * timeout and an outer cancellation, so the underlying request (e.g. fetch)
 * actually receives the abort — Promise.race would only end the wait without
 * terminating the request. On outer cancellation we never retry; on timeout we
 * retry up to the configured bound.
 */
export async function withRetriesAndTimeout(
  invoke: (signal: AbortSignal) => Promise<string>,
  options: ModelCallOptions,
  signal?: AbortSignal,
): Promise<{ output: string | null; attempts: number; timed_out: boolean; error: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      return { output: null, attempts: attempt - 1, timed_out: false, error: 'cancelled' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), options.timeoutMs);
    const onOuterAbort = () => controller.abort(signal?.reason ?? 'cancelled');
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const output = await invoke(controller.signal);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      return { output, attempts: attempt, timed_out: false, error: null };
    } catch (err) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);

      if (signal?.aborted) {
        // user cancellation: never retry
        return { output: null, attempts: attempt, timed_out: false, error: 'cancelled' };
      }
      if (controller.signal.aborted) {
        // timeout fired and the request received the abort
        lastError = 'timed out';
        continue;
      }
      lastError = (err as Error).message;
    }
  }
  return { output: null, attempts: options.maxRetries + 1, timed_out: lastError === 'timed out', error: lastError };
}

/** Create a unique request id per call. */
export function newRequestId(): string {
  return randomUUID();
}
