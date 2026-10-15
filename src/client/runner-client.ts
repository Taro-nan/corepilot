import type {
  CancelExperimentResponse,
  ExperimentCommandsResponse,
  ExperimentExecutionPlan,
  ExperimentMeasurementsResponse,
  ExperimentStatusResponse,
  RunnerHealth,
  RunnerMachineInfo,
  SubmitExperimentResponse,
} from '../contracts/runner-rpc.js';

interface RunnerErrorBody {
  error?: { code?: string; message?: string };
}

export class RunnerClientError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerClientError';
  }
}

export interface RunnerClientOptions {
  baseUrl: string;
  token: string;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Thin Control Plane client for the Execution Plane HTTP/JSON protocol. */
export class RunnerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: RunnerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!options.token) throw new Error('runner bearer token must not be empty');
    if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1)) {
      throw new Error('runner request timeout must be a positive integer');
    }
  }

  health(signal?: AbortSignal): Promise<RunnerHealth> {
    return this.request('GET', '/health', undefined, signal);
  }

  machine(signal?: AbortSignal): Promise<RunnerMachineInfo> {
    return this.request('GET', '/machine', undefined, signal);
  }

  submitExperiment(plan: ExperimentExecutionPlan, signal?: AbortSignal): Promise<SubmitExperimentResponse> {
    return this.request('POST', '/experiments', plan, signal);
  }

  getExperiment(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}`, undefined, signal);
  }

  cancelExperiment(experimentId: string, signal?: AbortSignal): Promise<CancelExperimentResponse> {
    return this.request('POST', `/experiments/${encodeURIComponent(experimentId)}/cancel`, {}, signal);
  }

  getMeasurements(experimentId: string, signal?: AbortSignal): Promise<ExperimentMeasurementsResponse> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}/measurements`, undefined, signal);
  }

  getCommandExecutions(experimentId: string, signal?: AbortSignal): Promise<ExperimentCommandsResponse> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}/commands`, undefined, signal);
  }

  private async request<T>(method: string, pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    const controller = new AbortController();
    const timeoutMs = this.options.requestTimeoutMs ?? 10_000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      response = await this.fetchImpl(this.baseUrl + pathname, {
        method,
        headers: {
          // Staging currently uses synchronous SSH/scp and can block the
          // Control Plane event loop beyond the Runner's keep-alive timeout.
          // Do not reuse a socket that may have gone stale during staging.
          connection: 'close',
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new RunnerClientError(null, 'REQUEST_TIMEOUT', `runner request timed out after ${timeoutMs}ms`);
      if (signal?.aborted) throw new RunnerClientError(null, 'REQUEST_ABORTED', 'runner request was cancelled');
      throw new RunnerClientError(null, 'CONNECTION_FAILED', `cannot connect to runner: ${(error as Error).message}`);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) as unknown : {}; }
    catch { parsed = {}; }
    if (!response.ok) {
      const error = parsed as RunnerErrorBody;
      throw new RunnerClientError(response.status, error.error?.code ?? 'HTTP_ERROR', error.error?.message ?? `HTTP ${response.status}`);
    }
    return parsed as T;
  }
}
