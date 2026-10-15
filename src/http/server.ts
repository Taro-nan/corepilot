import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../core/api-error.js';
import type { TaskHost } from '../core/task-host.js';
import type { OptimizationWorkflowService } from '../workflow/optimization-workflow-service.js';
import { parsePublicWorkflowRequest, PublicWorkflowRequestError, PHYOPT_MODEL_API_KEY_HEADER } from '../contracts/public-workflow.js';
import { MOCK_SCENARIOS, type MockScenario } from '../contracts/task.js';
import { makeTarget } from '../contracts/target.js';
import { buildHealth } from '../contracts/health.js';
import { MANAGED_SHUTDOWN_PATH, MANAGED_SHUTDOWN_TOKEN_HEADER } from '../backend/managed-control.js';

const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServerOptions {
  host: string;
  port: number;
  workflowService: OptimizationWorkflowService;
  managedShutdown?: { token: string; requestShutdown: () => void };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'request body is not valid JSON object'); }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ApiError(400, 'INVALID_ARGUMENT', `${field} is required and must be a string`);
  return value.trim();
}

function safeToken(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 同时承载通用任务 API 和新的 public optimize workflow API。 */
export function createHttpServer(host: TaskHost, options: HttpServerOptions): http.Server {
  const server = http.createServer((req, res) => {
    void handle(host, req, res, options).catch((error: unknown) => {
      const err = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL', (error as Error).message);
      sendJson(res, err.statusCode, { error: { code: err.code, message: err.message } });
    });
  });
  server.listen(options.port, options.host);
  return server;
}

async function handle(host: TaskHost, req: http.IncomingMessage, res: http.ServerResponse, options: HttpServerOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/v1/health') {
    sendJson(res, 200, buildHealth({ capabilities: ['workflows', 'tasks', 'events'] }));
    return;
  }
  if (method === 'POST' && pathname === MANAGED_SHUTDOWN_PATH) {
    if (!options.managedShutdown) throw new ApiError(404, 'NOT_FOUND', 'managed shutdown is unavailable');
    if (!safeToken(req.headers[MANAGED_SHUTDOWN_TOKEN_HEADER], options.managedShutdown.token)) throw new ApiError(403, 'FORBIDDEN', 'invalid shutdown token');
    sendJson(res, 202, { status: 'shutting_down' });
    setImmediate(options.managedShutdown.requestShutdown);
    return;
  }

  if (method === 'POST' && pathname === '/v1/workflows') {
    try {
      const request = parsePublicWorkflowRequest(await readJson(req));
      const header = req.headers[PHYOPT_MODEL_API_KEY_HEADER];
      const submitted = options.workflowService.submitPublic(request, { ...(typeof header === 'string' ? { cliApiKey: header } : {}) });
      sendJson(res, 202, { workflow_id: submitted.workflowId, status: 'CREATED', function_name: request.function_name, entry_file: request.entry_file, ...(request.enable_performance === undefined ? {} : { enable_performance: request.enable_performance }) });
    } catch (error) {
      if (error instanceof PublicWorkflowRequestError) throw new ApiError(400, 'INVALID_ARGUMENT', error.message);
      throw new ApiError(400, 'INVALID_WORKFLOW_CONFIG', (error as Error).message);
    }
    return;
  }
  const workflow = pathname.match(/^\/v1\/workflows\/([^/]+)$/);
  if (method === 'GET' && workflow) {
    const record = options.workflowService.get(decodeURIComponent(workflow[1]));
    if (!record) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
    sendJson(res, 200, { workflow: record });
    return;
  }
  const workflowCancel = pathname.match(/^\/v1\/workflows\/([^/]+)\/cancel$/);
  if (method === 'POST' && workflowCancel) {
    const result = options.workflowService.cancel(decodeURIComponent(workflowCancel[1]));
    if (!result.ok && result.status === 'NOT_FOUND') throw new ApiError(404, 'WORKFLOW_NOT_FOUND', result.message);
    sendJson(res, 200, result);
    return;
  }
  const workflowApprove = pathname.match(/^\/v1\/workflows\/([^/]+)\/approve$/);
  if (method === 'POST' && workflowApprove) {
    const body = await readJson(req);
    const result = options.workflowService.approvePublic(decodeURIComponent(workflowApprove[1]), { commitMessage: requireString(body.commit_message, 'commit_message'), ...(body.expected_baseline_commit === undefined ? {} : { expectedBaselineCommit: requireString(body.expected_baseline_commit, 'expected_baseline_commit') }) });
    if (!result.ok) throw new ApiError(409, 'WORKFLOW_APPROVAL_REJECTED', result.message);
    sendJson(res, 200, { status: 'DELIVERABLE', commit: result.commit, tree: result.tree });
    return;
  }

  if (method === 'POST' && pathname === '/v1/tasks') {
    const body = await readJson(req);
    const scenario = requireString(body.scenario, 'scenario');
    if (!(MOCK_SCENARIOS as readonly string[]).includes(scenario)) throw new ApiError(400, 'INVALID_SCENARIO', `invalid scenario '${scenario}'`);
    const targetValue = body.target as { name?: unknown } | undefined;
    const target = makeTarget(typeof targetValue?.name === 'string' ? targetValue.name : 'mock-target');
    const created = host.createTask(typeof body.request_id === 'string' ? body.request_id : undefined, scenario as MockScenario, target);
    sendJson(res, created.replayed ? 200 : 201, { ...created });
    return;
  }
  if (method === 'GET' && pathname === '/v1/tasks') { sendJson(res, 200, { tasks: host.listTasks() }); return; }
  const taskEvents = pathname.match(/^\/v1\/tasks\/([^/]+)\/events$/);
  if (method === 'GET' && taskEvents) { sendJson(res, 200, { events: host.listEvents(decodeURIComponent(taskEvents[1])) }); return; }
  const taskReport = pathname.match(/^\/v1\/tasks\/([^/]+)\/report$/);
  if (method === 'GET' && taskReport) {
    const task = host.getTask(decodeURIComponent(taskReport[1]));
    if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'task not found');
    sendJson(res, 200, { report_path: task.report_path }); return;
  }
  const taskCommand = pathname.match(/^\/v1\/tasks\/([^/]+)\/(cancel|retry|resume)$/);
  if (method === 'POST' && taskCommand) {
    const body = await readJson(req);
    const id = decodeURIComponent(taskCommand[1]);
    const commandId = requireString(body.command_id, 'command_id');
    const action = taskCommand[2];
    const result = action === 'cancel' ? host.cancel(id, commandId) : action === 'retry' ? host.retry(id, commandId) : host.resume(id, commandId);
    sendJson(res, 200, result); return;
  }
  const task = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
  if (method === 'GET' && task) {
    const taskRecord = host.getTask(decodeURIComponent(task[1]));
    if (!taskRecord) throw new ApiError(404, 'TASK_NOT_FOUND', 'task not found');
    sendJson(res, 200, { task: taskRecord, job: host.getJob(taskRecord.task_id) }); return;
  }
  sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `no route for ${method} ${pathname}` } });
}
