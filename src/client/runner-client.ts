import type {
  CancelExperimentResponse,
  ExperimentCommandsResponse,
  ExperimentExecutionPlan,
  ExperimentMeasurementsResponse,
  ExperimentStatusResponse,
  RunnerHealth,
  RunnerMachineInfo,
  SubmitExperimentResponse,
  StagedSourceArchive,
  RunnerExecutionOutput,
} from '../contracts/runner-rpc.js';
import { RUNNER_PROTOCOL_VERSION } from '../contracts/runner-rpc.js';
import type { RunnerToolchain } from '../contracts/build-planning.js';
import type { RunnerBundleInspection, RunnerBundleInspectionRequest } from '../contracts/baseline-bundle.js';

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
  toolchain(signal?: AbortSignal): Promise<RunnerToolchain> {
    return this.request('GET', '/toolchain', undefined, signal);
  }

  /** Read-only connectivity and protocol check, independent of an optimization task. */
  async probe(signal?: AbortSignal): Promise<{ health: RunnerHealth; machine: RunnerMachineInfo }> {
    const health = await this.health(signal);
    if (!health || health.status !== 'READY' || health.protocol_version !== RUNNER_PROTOCOL_VERSION || typeof health.runner_id !== 'string'
      || !['REQUIRED', 'DISABLED'].includes(health.resource_enforcement)) {
      throw new RunnerClientError(null, 'PROTOCOL_MISMATCH', 'Runner 未就绪或协议版本不兼容，请检查 RPC 地址与 Runner 版本。');
    }
    const machine = await this.machine(signal);
    if (!machine || typeof machine.hostname !== 'string' || typeof machine.architecture !== 'string'
      || !Number.isInteger(machine.cpu_count) || machine.cpu_count < 1 || typeof machine.machine_identity_sha256 !== 'string') {
      throw new RunnerClientError(null, 'INVALID_MACHINE_INFO', 'Runner 返回的机器信息不完整，请检查 Runner 版本。');
    }
    return { health, machine };
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

  confirmExperimentStopped(experimentId: string, reviewer: string, reason: string): Promise<ExperimentStatusResponse> {
    return this.request('POST', `/experiments/${encodeURIComponent(experimentId)}/confirm-stopped`, { confirmed_stopped: true, reviewer, reason });
  }

  getMeasurements(experimentId: string, signal?: AbortSignal): Promise<ExperimentMeasurementsResponse> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}/measurements`, undefined, signal);
  }

  getCommandExecutions(experimentId: string, signal?: AbortSignal): Promise<ExperimentCommandsResponse> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}/commands`, undefined, signal);
  }

  getExecutionOutput(experimentId: string): Promise<RunnerExecutionOutput | null> {
    return this.request('GET', `/experiments/${encodeURIComponent(experimentId)}/output`);
  }

  async uploadSourceArchive(input: { filename: string; sha256: string; workspacePath: string }, signal?: AbortSignal): Promise<StagedSourceArchive> {
    const { createReadStream } = await import('node:fs');
    const stream = createReadStream(input.filename);
    const query = new URLSearchParams({ sha256: input.sha256, workspace_path: input.workspacePath });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/source-archives?${query}`, { method: 'PUT',
        headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/gzip' },
        body: stream as unknown as RequestInit['body'], duplex: 'half',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900_000)]) : AbortSignal.timeout(900_000),
      } as RequestInit);
      const result = await response.json() as StagedSourceArchive & RunnerErrorBody;
      if (!response.ok) throw new RunnerClientError(response.status, result.error?.code ?? 'SOURCE_UPLOAD_FAILED', result.error?.message ?? `HTTP ${response.status}`);
      return result;
    } finally { stream.destroy(); }
  }

  inspectBaselineBundle(input: RunnerBundleInspectionRequest, signal?: AbortSignal): Promise<RunnerBundleInspection> {
    return this.request('POST', '/baseline-bundles/inspect', input, signal);
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
