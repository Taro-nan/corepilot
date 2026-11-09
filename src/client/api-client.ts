import type { OptimizationReportResponse } from '../contracts/optimization-report.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { OptimizationSessionBudget, OptimizationSessionEvents } from '../contracts/optimization-session.js';
import type { OptimizationIntakeStatus } from '../contracts/optimization-intake.js';
import { CONTROL_GUARD_HEADER, isControlIdentity, type ControlIdentity } from '../contracts/control-identity.js';
import { controlRoute } from './control-identity-route.js';
import { TestingClient } from './testing-client.js';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string | null,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export class ApiClient {
  readonly testing: TestingClient;
  getReproduction(workflowId: string): Promise<unknown> { return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}/reproduction`); }
  reproduceWorkflow(workflowId: string): Promise<unknown> { return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/reproduction`, {}); }
  cancelReproduction(workflowId: string): Promise<unknown> { return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/reproduction/cancel`, {}); }
  constructor(private readonly baseUrl: string, private readonly options: { token?: string } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.testing = new TestingClient((method, path, body, headers) => this.request(method, path, body, headers), (path, body) => this.upload(path, body));
  }

  health(signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', '/v1/health', undefined, undefined, signal);
  }

  createTask(payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/v1/tasks', payload);
  }

  getTask(taskId: string): Promise<unknown> {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  listTasks(): Promise<unknown> {
    return this.request('GET', '/v1/tasks');
  }

  getReportPath(taskId: string): Promise<unknown> {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}/report`);
  }

  getEvents(taskId: string): Promise<unknown> {
    return this.request('GET', `/v1/tasks/${encodeURIComponent(taskId)}/events`);
  }

  async getControlIdentity(): Promise<ControlIdentity> {
    const value = await this.request('GET', '/v1/control-identity');
    if (!isControlIdentity(value)) throw new Error('控制端身份信息不完整，请由维护者核对服务版本。');
    return value;
  }

  submitOptimizationWorkflow(payload: Record<string, unknown>, options: { apiKey?: string; requestId?: string; controlIdentity?: ControlIdentity } = {}): Promise<unknown> {
    return this.request('POST', options.controlIdentity ? controlRoute(options.controlIdentity, '/workflows') : '/v1/workflows', payload,
      { ...(options.apiKey ? { 'x-corepilot-model-api-key': options.apiKey } : {}), ...(options.requestId ? { 'idempotency-key': options.requestId } : {}),
        ...(options.controlIdentity ? { [CONTROL_GUARD_HEADER]: '1' } : {}) });
  }

  getOptimizationIntake(requestId: string, identity?: ControlIdentity): Promise<OptimizationIntakeStatus> {
    const path = `/workflow-requests/${encodeURIComponent(requestId)}`;
    return this.request('GET', identity ? controlRoute(identity, path) : '/v1' + path, undefined,
      identity ? { [CONTROL_GUARD_HEADER]: '1' } : undefined) as Promise<OptimizationIntakeStatus>;
  }

  closeOptimizationIntake(requestId: string, identity?: ControlIdentity): Promise<Exclude<OptimizationIntakeStatus, { status: 'NOT_FOUND' }>> {
    const path = `/workflow-requests/${encodeURIComponent(requestId)}/close`;
    return this.request('POST', identity ? controlRoute(identity, path) : '/v1' + path, {},
      identity ? { [CONTROL_GUARD_HEADER]: '1' } : undefined) as Promise<Exclude<OptimizationIntakeStatus, { status: 'NOT_FOUND' }>>;
  }

  getOptimizationWorkflow(workflowId: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}`, undefined, undefined, signal);
  }

  listOptimizationWorkflows(limit = 50): Promise<{ workflows: OptimizationWorkflowRecord[]; active_workflow_ids?: string[] }> {
    return this.request('GET', `/v1/workflows?limit=${limit}`) as Promise<{ workflows: OptimizationWorkflowRecord[]; active_workflow_ids?: string[] }>;
  }

  getOptimizationReport(workflowId: string): Promise<OptimizationReportResponse> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}/report`) as Promise<OptimizationReportResponse>;
  }

  cancelOptimizationWorkflow(workflowId: string): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, {});
  }

  getOptimizationSessionEvents(workflowId: string, after = 0, limit = 100): Promise<OptimizationSessionEvents> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}/events?after=${after}&limit=${limit}`) as Promise<OptimizationSessionEvents>;
  }

  resumeOptimizationWorkflow(workflowId: string, input: { message?: string; budget?: Partial<OptimizationSessionBudget>; candidate_scope?: import('../contracts/library-package.js').CandidateSourceScope } = {}): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/resume`, input);
  }

  sendOptimizationMessage(workflowId: string, message: string): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/messages`, { message });
  }

  retryOptimizationValidation(workflowId: string, expectedCandidateId?: string): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/retry-validation`,
      expectedCandidateId ? { expected_candidate_id: expectedCandidateId } : {});
  }

  requestWorkflowApprove(workflowId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/approve`, payload);
  }
  prepareWorkflowEvidence(workflowId: string): Promise<{ snapshot: import('../contracts/optimization-approval.js').WorkflowEvidenceSnapshot }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/evidence`, {}) as Promise<{ snapshot: import('../contracts/optimization-approval.js').WorkflowEvidenceSnapshot }>;
  }
  getWorkflowEvidence(workflowId: string): Promise<{ snapshot: import('../contracts/optimization-approval.js').WorkflowEvidenceSnapshot; evidence: Record<string, unknown> }> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}/evidence`) as Promise<{ snapshot: import('../contracts/optimization-approval.js').WorkflowEvidenceSnapshot; evidence: Record<string, unknown> }>;
  }
  downloadWorkflowEvidence(workflowId: string): Promise<Uint8Array> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}/evidence/archive`, undefined, undefined, undefined, true) as Promise<Uint8Array>;
  }
  approveWorkflowEvidence(workflowId: string, input: { expected_evidence_digest: string; reviewer: string; authorization_reference: string }): Promise<{ approval: import('../contracts/optimization-approval.js').OptimizationApprovalRecord }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/approval`, input) as Promise<{ approval: import('../contracts/optimization-approval.js').OptimizationApprovalRecord }>;
  }
  reconcileWorkflowDelivery(workflowId: string): Promise<{ workflow: OptimizationWorkflowRecord }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/delivery/reconcile`, {}) as Promise<{ workflow: OptimizationWorkflowRecord }>;
  }
  resumeWorkflowDelivery(workflowId: string, confirmedStopped = false): Promise<{ commit: string; tree: string; cleanup_warning?: string }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/delivery/resume`, { confirmed_stopped: confirmedStopped }) as Promise<{ commit: string; tree: string; cleanup_warning?: string }>;
  }
  withdrawWorkflowDelivery(workflowId: string, operationId: string, confirmedStopped = false): Promise<{ workflow: OptimizationWorkflowRecord }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/delivery/withdraw`, { expected_operation_id: operationId, confirmed_stopped: confirmedStopped }) as Promise<{ workflow: OptimizationWorkflowRecord }>;
  }
  cleanupWorkflowDelivery(workflowId: string): Promise<{ workflow: OptimizationWorkflowRecord }> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/delivery/cleanup`, {}) as Promise<{ workflow: OptimizationWorkflowRecord }>;
  }

  listProjects(): Promise<{ projects: ProjectRecord[] }> { return this.request('GET', '/v1/projects') as Promise<{ projects: ProjectRecord[] }>; }
  listExecutionMachines(): Promise<{ machines: import('../contracts/execution-machine.js').ExecutionMachineSummary[] }> {
    return this.request('GET', '/v1/machines') as Promise<{ machines: import('../contracts/execution-machine.js').ExecutionMachineSummary[] }>;
  }
  machineAction(id: string, action = '', payload?: Record<string, unknown>, method?: string): Promise<unknown> {
    return this.request(method ?? (payload ? 'POST' : 'GET'), `/v1/machines${id ? '/' + encodeURIComponent(id) : ''}${action ? '/' + action : ''}`, payload);
  }
  addProject(payload: { name: string; repository_root: string; config_path?: string; source_branch?: string }): Promise<{ project: ProjectRecord }> { return this.request('POST', '/v1/projects', payload) as Promise<{ project: ProjectRecord }>; }
  inspectRepository(directory: string): Promise<import('../contracts/project.js').RepositoryInspection> { return this.request('GET', `/v1/repository?path=${encodeURIComponent(directory)}`) as Promise<import('../contracts/project.js').RepositoryInspection>; }
  projectAction(projectId: string, action = '', payload?: Record<string, unknown>, method?: string): Promise<unknown> {
    return this.request(method ?? (payload ? 'POST' : 'GET'), `/v1/projects/${encodeURIComponent(projectId)}${action ? '/' + action : ''}`, payload);
  }

  startProjectTrial(projectId: string, payload: Record<string, unknown>, requestId?: string): Promise<unknown> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/validation-trials`, payload,
      requestId === undefined ? {} : { 'idempotency-key': requestId });
  }

  downloadProjectTests(projectId: string, action: string): Promise<Uint8Array> {
    return this.request('GET', `/v1/projects/${encodeURIComponent(projectId)}/${action}`, undefined, undefined, undefined, true) as Promise<Uint8Array>;
  }


  cancel(taskId: string, commandId: string): Promise<unknown> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { command_id: commandId });
  }

  retry(taskId: string, commandId: string): Promise<unknown> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/retry`, { command_id: commandId });
  }

  resume(taskId: string, commandId: string): Promise<unknown> {
    return this.request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/resume`, { command_id: commandId });
  }

  private async upload(path: string, body: Uint8Array | Blob): Promise<unknown> {
    const token = this.options.token ?? (typeof process !== 'undefined' ? process.env.COREPILOT_SERVER_TOKEN : undefined);
    const res = await fetch(this.baseUrl + path, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body as unknown as RequestInit['body'], signal: AbortSignal.timeout(600_000) });
    const result = await res.json() as ApiErrorBody;
    if (!res.ok) throw new ApiClientError(res.status, result.error?.code ?? 'ERROR', result.error?.message ?? `HTTP ${res.status}`, result.error?.details);
    return result;
  }

  private async request(method: string, path: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>, signal?: AbortSignal, binary = false): Promise<unknown> {
    let res: Response;
    try {
      const token = this.options.token ?? (typeof process !== 'undefined' ? process.env.COREPILOT_SERVER_TOKEN : undefined);
      const signals = [...(path.endsWith('/generate') ? [] : [AbortSignal.timeout(path.endsWith('/validation-trials') ? 180_000 : 30_000)]), ...(signal ? [signal] : [])];
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
        ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      });
    } catch (err) {
      throw new ApiClientError(null, 'CONNECTION_FAILED', `cannot connect to server ${this.baseUrl}: ${(err as Error).message}`);
    }

    if (res.ok && binary) return new Uint8Array(await res.arrayBuffer());
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }

    if (!res.ok) {
      const errBody = json as ApiErrorBody;
      if (res.status === 404 && errBody?.error?.code === 'NOT_FOUND' && path.startsWith('/v1/workflows')) {
        throw new ApiClientError(404, 'BACKEND_UPDATE_REQUIRED', '当前后台不支持此工作流功能。请在活动任务结束后使用 corepilot backend stop/start --config <path> 重启已更新的后台。');
      }
      throw new ApiClientError(res.status, errBody?.error?.code ?? 'ERROR', errBody?.error?.message ?? `HTTP ${res.status}`, errBody?.error?.details);
    }
    return json;
  }
}
