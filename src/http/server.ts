import http from 'node:http';
import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../core/api-error.js';
import type { TaskHost } from '../core/task-host.js';
import type { OptimizationWorkflowService } from '../workflow/optimization-workflow-service.js';
import { parsePublicWorkflowRequest, PublicWorkflowRequestError, COREPILOT_MODEL_API_KEY_HEADER } from '../contracts/public-workflow.js';
import { MOCK_SCENARIOS, type MockScenario } from '../contracts/task.js';
import { makeTarget } from '../contracts/target.js';
import { buildHealth } from '../contracts/health.js';
import { MANAGED_SHUTDOWN_PATH, MANAGED_SHUTDOWN_TOKEN_HEADER } from '../backend/managed-control.js';
import { readJson, sendJson } from './json.js';
import { ServerAccess } from './access.js';
import { serveWeb } from './static.js';
import { projectRoutes } from './project-routes.js';
import { machineRoutes } from './machine-routes.js';
import { testingRoutes } from './testing-routes.js';
import type { TestingService } from '../application/testing-service.js';
import type { ProjectService } from '../application/project-service.js';
import { redactRecord, redactReportText } from '../report/optimization-report.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  workflowService: OptimizationWorkflowService;
  projectService?: ProjectService;
  testingService?: TestingService;
  webRoot?: string;
  accessToken?: string;
  managedShutdown?: { token: string; requestShutdown: () => void };
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
  const access = new ServerAccess(options.accessToken);
  const server = http.createServer((req, res) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (await access.handle(req, res, pathname)) return;
      if (options.webRoot && await serveWeb(req, res, options.webRoot, pathname)) return;
      await handle(host, req, res, options);
    })().catch((error: unknown) => {
      const err = error instanceof ApiError ? error : new ApiError(500, 'INTERNAL', (error as Error).message);
      if (!res.headersSent) sendJson(res, err.statusCode, { error: { code: err.code, message: redactReportText(err.message), ...(err.details ? { details: redactRecord(err.details) } : {}) } });
      else res.destroy();
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
    sendJson(res, 200, buildHealth({ capabilities: ['workflows', 'workflow-reports', 'optimization-sessions', 'tasks', 'events', ...(options.projectService ? ['projects'] : []), ...(options.testingService ? ['testing-tasks'] : []), ...(options.webRoot ? ['web'] : [])] }));
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
      const body = await readJson(req);
      const resolved = typeof body.project_id === 'string' && options.projectService
        ? options.projectService.request(body.project_id, body) : body;
      const request = parsePublicWorkflowRequest(resolved);
      const header = req.headers[COREPILOT_MODEL_API_KEY_HEADER];
      const requestId = req.headers['idempotency-key'];
      if (requestId && (typeof requestId !== 'string' || requestId.length > 200)) throw new Error('invalid Idempotency-Key');
      const submitted = options.workflowService.submitPublic(request, { ...(typeof header === 'string' ? { cliApiKey: header } : {}), ...(typeof requestId === 'string' ? { requestId } : {}), packageLoader: options.projectService?.packageLoader });
      sendJson(res, 202, { workflow_id: submitted.workflowId, status: options.workflowService.get(submitted.workflowId)?.status ?? 'CREATED', function_name: request.function_name, entry_file: request.entry_file, ...(request.enable_performance === undefined ? {} : { enable_performance: request.enable_performance }) });
    } catch (error) {
      if (error instanceof PublicWorkflowRequestError) throw new ApiError(400, 'INVALID_ARGUMENT', error.message);
      throw new ApiError(400, 'INVALID_WORKFLOW_CONFIG', (error as Error).message);
    }
    return;
  }
  if (options.testingService && await testingRoutes(req, res, url, options.testingService)) return;
  if (options.projectService) {
    try {
      if (await machineRoutes(req, res, url, options.projectService.machines)) return;
      if (await projectRoutes(req, res, url, options.projectService, options.workflowService)) return;
    }
    catch (error) {
      if (error instanceof ApiError) throw error;
      const message = (error as Error).message;
      throw new ApiError(message === 'project not found' ? 404 : 400, 'PROJECT_OPERATION_FAILED', message);
    }
  }
  if (method === 'GET' && pathname === '/v1/workflows') {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'INVALID_ARGUMENT', 'limit must be an integer in 1..200');
    sendJson(res, 200, { workflows: options.workflowService.list(limit), active_workflow_ids: options.workflowService.activeWorkflowIds() });
    return;
  }
  const workflowReport = pathname.match(/^\/v1\/workflows\/([^/]+)\/report$/);
  const workflowEvents = pathname.match(/^\/v1\/workflows\/([^/]+)\/events$/);
  if (method === 'GET' && workflowEvents) {
    const after = Number(url.searchParams.get('after') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError(400, 'INVALID_ARGUMENT', 'invalid event cursor or limit');
    const events = await options.workflowService.sessionEvents(decodeURIComponent(workflowEvents[1]), after, limit);
    if (!events) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
    sendJson(res, 200, events); return;
  }
  const workflowSessionAction = pathname.match(/^\/v1\/workflows\/([^/]+)\/(resume|messages|retry-validation)$/);
  if (method === 'POST' && workflowSessionAction) {
    const body = await readJson(req);
    const id = decodeURIComponent(workflowSessionAction[1]);
    if (!options.workflowService.get(id)) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
    try {
      if (workflowSessionAction[2] === 'retry-validation') {
        if (Object.keys(body).some(key => key !== 'expected_candidate_id')) throw new Error('retry-validation accepts only expected_candidate_id');
        const header = req.headers['x-corepilot-model-api-key'];
        sendJson(res, 202, options.workflowService.retryValidationPublic(id, {
          ...(body.expected_candidate_id === undefined ? {} : { expectedCandidateId: requireString(body.expected_candidate_id, 'expected_candidate_id') }),
          ...(typeof header === 'string' ? { cliApiKey: header } : {}), packageLoader: options.projectService?.packageLoader,
        }));
      } else if (workflowSessionAction[2] === 'messages') {
        await options.workflowService.sendMessage(id, requireString(body.message, 'message'));
        sendJson(res, 202, { workflow_id: id, status: 'QUEUED' });
      } else {
        if (body.budget !== undefined && (!body.budget || typeof body.budget !== 'object' || Array.isArray(body.budget))) throw new Error('budget must be an object');
        const budget = body.budget as import('../contracts/optimization-session.js').OptimizationSessionBudget | undefined;
        if (budget && Object.keys(budget).some(key => !['time_limit_ms', 'max_candidates'].includes(key))) throw new Error('unknown budget field');
        const header = req.headers['x-corepilot-model-api-key'];
        const result = options.workflowService.resumePublic(id, { ...(body.message === undefined ? {} : { message: requireString(body.message, 'message') }),
          ...(budget ? { budget } : {}), ...(typeof header === 'string' ? { cliApiKey: header } : {}), packageLoader: options.projectService?.packageLoader });
        sendJson(res, 202, result);
      }
    } catch (error) { throw new ApiError(409, 'WORKFLOW_CONTINUATION_REJECTED', (error as Error).message); }
    return;
  }
  if (method === 'GET' && workflowReport) {
    const report = options.workflowService.report(decodeURIComponent(workflowReport[1]));
    if (!report) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
    sendJson(res, 200, report);
    return;
  }
  const reproduction = pathname.match(/^\/v1\/workflows\/([^/]+)\/reproduction(?:\/(cancel))?$/);
  if (reproduction && options.workflowService) {
    const id = decodeURIComponent(reproduction[1]);
    try {
      if (method === 'GET' && !reproduction[2]) { sendJson(res, 200, options.workflowService.reproductions.manifest(id)); return; }
      if (method === 'POST' && reproduction[2] === 'cancel') { await options.workflowService.reproductions.cancel(id); sendJson(res, 202, { status: 'CANCEL_REQUESTED' }); return; }
      if (method === 'POST' && !reproduction[2]) {
        if (options.workflowService.activeWorkflowIds().includes(id)) throw new Error('优化任务仍在运行，请等待它结束后复现冻结候选');
        sendJson(res, 202, options.workflowService.reproductions.start(id)); return;
      }
    } catch (error) { throw new ApiError(409, 'REPRODUCTION_REJECTED', (error as Error).message); }
  }
  const workflow = pathname.match(/^\/v1\/workflows\/([^/]+)$/);
  if (method === 'GET' && workflow) {
    const record = options.workflowService.get(decodeURIComponent(workflow[1]));
    if (!record) throw new ApiError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
    sendJson(res, 200, { workflow: record, execution_attached: options.workflowService.activeWorkflowIds().includes(record.workflow_id) });
    return;
  }
  const workflowCancel = pathname.match(/^\/v1\/workflows\/([^/]+)\/cancel$/);
  if (method === 'POST' && workflowCancel) {
    const result = options.workflowService.cancel(decodeURIComponent(workflowCancel[1]));
    if (!result.ok && result.status === 'NOT_FOUND') throw new ApiError(404, 'WORKFLOW_NOT_FOUND', result.message);
    sendJson(res, 200, result);
    return;
  }
  const workflowEvidence = pathname.match(/^\/v1\/workflows\/([^/]+)\/evidence(?:\/(archive))?$/);
  if (workflowEvidence && (method === 'GET' || method === 'POST')) {
    const id = decodeURIComponent(workflowEvidence[1]);
    try {
      if (method === 'POST' && !workflowEvidence[2]) {
        await readJson(req);
        sendJson(res, 200, { snapshot: options.workflowService.approvals.prepare(id) }); return;
      }
      if (method === 'GET') {
        const result = options.workflowService.approvals.evidence(id);
        if (!workflowEvidence[2]) { sendJson(res, 200, result); return; }
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': 'attachment; filename="corepilot-evidence.json.gz"' });
        fs.createReadStream(result.snapshot.artifact.archive_path).on('error', error => res.destroy(error)).pipe(res); return;
      }
    } catch (error) { throw new ApiError(409, 'WORKFLOW_EVIDENCE_REJECTED', (error as Error).message); }
  }
  const workflowHumanApproval = pathname.match(/^\/v1\/workflows\/([^/]+)\/approval$/);
  if (method === 'POST' && workflowHumanApproval) {
    const body = await readJson(req);
    try {
      const approval = options.workflowService.approvals.approve(decodeURIComponent(workflowHumanApproval[1]), {
        expectedDigest: requireString(body.expected_evidence_digest, 'expected_evidence_digest'),
        reviewer: requireString(body.reviewer, 'reviewer'), authorizationReference: requireString(body.authorization_reference, 'authorization_reference'),
      });
      sendJson(res, 200, { approval }); return;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(409, 'WORKFLOW_HUMAN_APPROVAL_REJECTED', (error as Error).message); }
  }
  const workflowDelivery = pathname.match(/^\/v1\/workflows\/([^/]+)\/delivery\/(reconcile|resume|withdraw|cleanup)$/);
  if (method === 'POST' && workflowDelivery) {
    const id = decodeURIComponent(workflowDelivery[1]);
    const body = await readJson(req);
    try {
      if (workflowDelivery[2] === 'reconcile') { sendJson(res, 200, { workflow: await options.workflowService.deliveries.reconcile(id) }); return; }
      if (workflowDelivery[2] === 'cleanup') { sendJson(res, 200, { workflow: await options.workflowService.deliveries.retryCleanup(id) }); return; }
      if (body.confirmed_stopped !== undefined && typeof body.confirmed_stopped !== 'boolean') throw new Error('confirmed_stopped 必须是布尔值');
      if (workflowDelivery[2] === 'withdraw') { sendJson(res, 200, { workflow: await options.workflowService.deliveries.withdraw(id, requireString(body.expected_operation_id, 'expected_operation_id'), body.confirmed_stopped === true) }); return; }
      const result = await options.workflowService.deliveries.resume(id, body.confirmed_stopped === true);
      if (!result.ok) throw new ApiError(409, 'WORKFLOW_DELIVERY_REJECTED', result.message, result.verification ? { verification: result.verification } : undefined);
      sendJson(res, 200, { status: 'DELIVERABLE', commit: result.commit, tree: result.tree, ...(result.cleanup_warning ? { cleanup_warning: result.cleanup_warning } : {}) }); return;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(409, 'WORKFLOW_DELIVERY_REJECTED', (error as Error).message);
    }
  }
  const workflowApprove = pathname.match(/^\/v1\/workflows\/([^/]+)\/approve$/);
  if (method === 'POST' && workflowApprove) {
    const body = await readJson(req);
    const result = await options.workflowService.approvePublic(decodeURIComponent(workflowApprove[1]), { commitMessage: requireString(body.commit_message, 'commit_message'), ...(body.expected_baseline_commit === undefined ? {} : { expectedBaselineCommit: requireString(body.expected_baseline_commit, 'expected_baseline_commit') }) });
    if (!result.ok) throw new ApiError(409, 'WORKFLOW_APPROVAL_REJECTED', result.message, result.verification ? { verification: result.verification } : undefined);
    sendJson(res, 200, { status: 'DELIVERABLE', commit: result.commit, tree: result.tree, ...(result.cleanup_warning ? { cleanup_warning: result.cleanup_warning } : {}) });
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
