import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { ApiError } from '../core/api-error.js';
import { RUNNER_PROTOCOL_VERSION, type RunnerHealth } from '../contracts/runner-rpc.js';
import { DuplicateExperimentError, ExperimentExecutor, RunnerPlanError } from './experiment-executor.js';
import { probeRunnerMachine } from './machine-probe.js';
import { SqliteRunnerStore } from './sqlite-runner-store.js';
import type { FormalResourceCommandRunner, ResourceEnforcementMode } from './resource-enforcement.js';

const MAX_BODY_BYTES = 1024 * 1024;
export const PHYOPT_RUNNER_VERSION = '0.4.0';

export interface RunnerHttpServerOptions {
  host: string;
  port: number;
  token: string;
  dbPath: string;
  workspaceRoot: string;
  runnerId?: string;
  resourceEnforcement?: ResourceEnforcementMode;
  formalResourceCommandRunner?: FormalResourceCommandRunner;
  allowTargetValidatedDigest?: string;
}

export interface RunningRunnerServer {
  runnerId: string;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startRunnerHttpServer(options: RunnerHttpServerOptions): Promise<RunningRunnerServer> {
  if (!options.token) throw new Error('runner bearer token must not be empty');
  const store = new SqliteRunnerStore(options.dbPath);
  const executor = new ExperimentExecutor(store, {
    workspaceRoot: options.workspaceRoot,
    ...(options.runnerId ? { runnerId: options.runnerId } : {}),
    ...(options.resourceEnforcement ? { resourceEnforcement: options.resourceEnforcement } : {}),
    ...(options.formalResourceCommandRunner ? { formalResourceCommandRunner: options.formalResourceCommandRunner } : {}),
    ...(options.allowTargetValidatedDigest ? { allowTargetValidatedDigest: options.allowTargetValidatedDigest } : {}),
  });
  let initialized: ReturnType<ExperimentExecutor['initialize']>;
  try {
    initialized = executor.initialize();
  } catch (error) {
    executor.closeStore();
    throw error;
  }
  const server = http.createServer((req, res) => {
    void handle(req, res, options.token, executor).catch((error: unknown) => {
      const apiError = toApiError(error);
      if (!res.headersSent) {
        if (apiError.statusCode === 401) res.setHeader('www-authenticate', 'Bearer');
        sendJson(res, apiError.statusCode, { error: { code: apiError.code, message: apiError.message } });
      } else {
        res.destroy();
      }
    });
  });

  try {
    await listen(server, options.host, options.port);
  } catch (error) {
    await executor.shutdown();
    executor.closeStore();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('runner did not bind a TCP address');
  let closed = false;
  return {
    runnerId: initialized.runnerId,
    host: options.host,
    port: address.port,
    url: `http://${formatHost(options.host)}:${address.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeHttpServer(server);
      await executor.shutdown();
      executor.closeStore();
    },
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  executor: ExperimentExecutor,
): Promise<void> {
  if (!authorized(req.headers.authorization, token)) throw new ApiError(401, 'UNAUTHORIZED', 'valid bearer token required');
  const url = new URL(req.url ?? '/', 'http://runner.local');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/health') {
    const response: RunnerHealth = {
      runner_id: executor.runnerId,
      version: PHYOPT_RUNNER_VERSION,
      protocol_version: RUNNER_PROTOCOL_VERSION,
      status: 'READY',
      resource_enforcement: executor.resourceEnforcementMode,
    };
    sendJson(res, 200, response);
    return;
  }
  if (method === 'GET' && pathname === '/machine') {
    sendJson(res, 200, probeRunnerMachine());
    return;
  }
  if (method === 'POST' && pathname === '/experiments') {
    const result = executor.submit(await readJson(req));
    sendJson(res, 202, result);
    return;
  }

  const statusMatch = pathname.match(/^\/experiments\/([^/]+)$/);
  if (method === 'GET' && statusMatch) {
    const experimentId = decodeId(statusMatch[1]);
    const result = executor.getExperiment(experimentId);
    if (!result) throw new ApiError(404, 'EXPERIMENT_NOT_FOUND', 'experiment not found');
    sendJson(res, 200, result);
    return;
  }
  const cancelMatch = pathname.match(/^\/experiments\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    const experimentId = decodeId(cancelMatch[1]);
    const result = executor.cancel(experimentId);
    if (!result) throw new ApiError(404, 'EXPERIMENT_NOT_FOUND', 'experiment not found');
    sendJson(res, result.status === 'RUNNING' || result.status === 'UNKNOWN' ? 202 : 200, result);
    return;
  }
  const measurementMatch = pathname.match(/^\/experiments\/([^/]+)\/measurements$/);
  if (method === 'GET' && measurementMatch) {
    const experimentId = decodeId(measurementMatch[1]);
    const result = executor.getMeasurements(experimentId);
    if (!result) throw new ApiError(404, 'EXPERIMENT_NOT_FOUND', 'experiment not found');
    sendJson(res, 200, result);
    return;
  }
  const commandMatch = pathname.match(/^\/experiments\/([^/]+)\/commands$/);
  if (method === 'GET' && commandMatch) {
    const experimentId = decodeId(commandMatch[1]);
    const result = executor.getCommandExecutions(experimentId);
    if (!result) throw new ApiError(404, 'EXPERIMENT_NOT_FOUND', 'experiment not found');
    sendJson(res, 200, result);
    return;
  }

  throw new ApiError(404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof RunnerPlanError) return new ApiError(400, 'INVALID_EXPERIMENT_PLAN', error.message);
  if (error instanceof DuplicateExperimentError) return new ApiError(409, 'EXPERIMENT_ALREADY_EXISTS', error.message);
  return new ApiError(500, 'INTERNAL', (error as Error).message);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new ApiError(400, 'INVALID_JSON', 'JSON request body required');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new ApiError(400, 'INVALID_JSON', 'request body is not valid JSON'); }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeId(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error('empty');
    return decoded;
  } catch {
    throw new ApiError(400, 'INVALID_EXPERIMENT_ID', 'experiment id is invalid');
  }
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}
