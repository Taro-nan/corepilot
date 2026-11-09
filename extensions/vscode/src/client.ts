import { createHash } from 'node:crypto';
import { ApiClient, ApiClientError } from '../../../src/client/api-client.js';
import { isCorePilotHealth, type BackendHealth } from '../../../src/contracts/health.js';
import type { ProjectRecord } from '../../../src/contracts/project.js';
import type { OptimizationWorkflowRecord } from '../../../src/contracts/workflow.js';
import { COREPILOT_API_VERSION } from '../../../src/version.js';

/** A server address is configuration, never a place to embed credentials. */
export function serverUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入有效的 CorePilot 服务地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('服务地址需要使用 HTTP 或 HTTPS，不能包含凭据、查询参数或片段。');
  }
  return url.toString().replace(/\/+$/, '');
}

/** Scope secrets and workspace selection to the configured service, not a hostname alias. */
export function serverKey(url: string): string {
  return createHash('sha256').update(serverUrl(url)).digest('hex');
}

export interface WorkflowDetail {
  workflow: OptimizationWorkflowRecord;
  execution_attached?: boolean;
}

/** The extension reads the same public API as the web and CLI clients. */
export class CorePilotClient {
  readonly api: ApiClient;
  private constructor(readonly url: string, private readonly token: string, readonly health: BackendHealth) {
    // Passing an empty token explicitly also prevents an unrelated extension-host
    // environment variable from silently selecting a different credential.
    this.api = new ApiClient(url, { token });
  }

  static async connect(address: string, token = ''): Promise<CorePilotClient> {
    const url = serverUrl(address);
    const health = await new ApiClient(url, { token: '' }).health();
    if (!isCorePilotHealth(health) || health.api_version !== COREPILOT_API_VERSION || health.runner !== 'workflow' || !Array.isArray(health.capabilities)) {
      throw new Error('此地址不是兼容的 CorePilot 服务，请检查地址和服务版本。');
    }
    return new CorePilotClient(url, token, health);
  }

  async projects(): Promise<ProjectRecord[]> {
    if (!this.health.capabilities?.includes('projects')) throw new Error('当前服务未启用项目功能，请使用 CorePilot 网页服务。');
    return (await this.api.listProjects()).projects;
  }

  async workflows(project: ProjectRecord): Promise<{ workflows: OptimizationWorkflowRecord[]; activeIds: string[] | null; limited: boolean }> {
    if (!this.health.capabilities?.includes('workflows')) throw new Error('当前服务不支持优化任务，请更新服务。');
    const result = await this.api.listOptimizationWorkflows(200);
    return { workflows: result.workflows.filter(row => row.config_path === project.config_path || row.repository_root === project.repository_root),
      activeIds: result.active_workflow_ids ?? null, limited: result.workflows.length === 200 };
  }

  async workflow(id: string): Promise<WorkflowDetail> {
    return await this.api.getOptimizationWorkflow(id) as WorkflowDetail;
  }

  /** The diff route exists publicly but has no method on the shared ApiClient yet. */
  async candidateDiff(workflowId: string, candidateId: string): Promise<string> {
    const route = `/v1/workflows/${encodeURIComponent(workflowId)}/candidates/${encodeURIComponent(candidateId)}/diff`;
    let response: Response;
    try {
      response = await fetch(this.url + route, { headers: this.token ? { authorization: `Bearer ${this.token}` } : {}, signal: AbortSignal.timeout(30_000) });
    } catch { throw new ApiClientError(null, 'CONNECTION_FAILED', '无法连接 CorePilot 服务，请检查地址后重试。'); }
    const parsed: unknown = await response.json().catch(() => null);
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as { diff?: unknown; error?: { code?: string; message?: string } } : {};
    if (!response.ok) throw new ApiClientError(response.status, body.error?.code ?? 'HTTP_ERROR', body.error?.message ?? `HTTP ${response.status}`);
    if (typeof body.diff !== 'string') throw new Error('服务未返回可读取的候选补丁。');
    return body.diff;
  }
}
