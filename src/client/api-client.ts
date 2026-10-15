export class ApiClientError extends Error {
  constructor(
    public readonly status: number | null,
    public readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  health(): Promise<unknown> {
    return this.request('GET', '/v1/health');
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

  submitOptimizationWorkflow(payload: Record<string, unknown>, options: { apiKey?: string } = {}): Promise<unknown> {
    return this.request('POST', '/v1/workflows', payload, options.apiKey ? { 'x-phyopt-model-api-key': options.apiKey } : undefined);
  }

  getOptimizationWorkflow(workflowId: string): Promise<unknown> {
    return this.request('GET', `/v1/workflows/${encodeURIComponent(workflowId)}`);
  }

  cancelOptimizationWorkflow(workflowId: string): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, {});
  }

  requestWorkflowApprove(workflowId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/v1/workflows/${encodeURIComponent(workflowId)}/approve`, payload);
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

  private async request(method: string, path: string, body?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...extraHeaders },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiClientError(null, 'CONNECTION_FAILED', `cannot connect to server ${this.baseUrl}: ${(err as Error).message}`);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = text;
    }

    if (!res.ok) {
      const errBody = json as ApiErrorBody;
      throw new ApiClientError(res.status, errBody?.error?.code ?? 'ERROR', errBody?.error?.message ?? `HTTP ${res.status}`);
    }
    return json;
  }
}
