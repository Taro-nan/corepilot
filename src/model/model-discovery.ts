export interface DiscoveredModel {
  id: string;
  label: string;
}

export class ModelDiscoveryError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

function modelsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/models`;
}

function extractModels(payload: unknown): DiscoveredModel[] {
  if (!payload || typeof payload !== 'object') return [];
  const value = payload as { data?: unknown; models?: unknown };
  const items = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = typeof item === 'string' ? item.trim() : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawLabel = item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name.trim() : '';
    result.push({ id, label: rawLabel || id });
  }
  return result;
}

/** Fetch the standard OpenAI-compatible model list; no static model catalog is used. */
export async function discoverOpenAIModels(
  endpoint: string,
  apiKey: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<DiscoveredModel[]> {
  if (!apiKey.trim()) throw new ModelDiscoveryError('API Key 不能为空');
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  headers.authorization = `Bearer ${apiKey.trim()}`;
  let response: Response;
  try {
    response = await fetchImpl(modelsUrl(endpoint), { method: 'GET', headers, signal: options.signal, redirect: 'error' });
  } catch (error) {
    if (options.signal?.aborted) throw new ModelDiscoveryError('模型列表请求已取消');
    throw new ModelDiscoveryError(`无法连接模型 endpoint：${(error as Error).message}`);
  }
  if (!response.ok) throw new ModelDiscoveryError(`模型列表请求失败：HTTP ${response.status}`, response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelDiscoveryError('模型列表响应不是合法 JSON', response.status);
  }
  const models = extractModels(payload);
  if (models.length === 0) throw new ModelDiscoveryError('模型列表为空或响应不符合 OpenAI-compatible 格式', response.status);
  return models;
}
