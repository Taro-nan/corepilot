import type { Context, Models, Tool, ToolCall } from '@earendil-works/pi-ai';
import { createPiModels, PHYOPT_PI_PROVIDER_ID, type PiRuntimeModelConfig } from './pi-provider.js';

export interface ToolVerificationResult {
  ok: boolean;
  model_id: string;
  tool_call: boolean;
  error: string | null;
}

const PROBE_TOOL: Tool = {
  name: 'phyopt_probe',
  description: '用于验证模型是否能返回工具调用；不要执行任何真实操作。',
  parameters: {
    type: 'object',
    properties: { ready: { type: 'boolean', description: '固定填写 true' } },
    required: ['ready'],
    additionalProperties: false,
  } as Tool['parameters'],
};

function toolCalls(message: { content: unknown[] }): ToolCall[] {
  return message.content.filter((item): item is ToolCall => Boolean(item && typeof item === 'object' && (item as { type?: unknown }).type === 'toolCall'));
}

function sanitizeError(error: string, apiKey?: string | null): string {
  return (apiKey ? error.split(apiKey).join('[redacted]') : error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

/** Make one minimal Pi request and require a real toolCall response. */
export async function verifyToolCalling(
  config: PiRuntimeModelConfig,
  options: { models?: Models; timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ToolVerificationResult> {
  const models = options.models ?? createPiModels(config);
  const model = models.getModel(PHYOPT_PI_PROVIDER_ID, config.modelId);
  if (!model) return { ok: false, model_id: config.modelId, tool_call: false, error: `模型未加载：${config.modelId}` };

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  const timer = timeoutMs <= 0 ? undefined : setTimeout(() => controller.abort('tool verification timeout'), timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason ?? 'cancelled');
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  try {
    const context: Context = {
      systemPrompt: '你正在进行模型能力验证。必须调用 phyopt_probe 工具，并将 ready 设置为 true。不要只返回文字。',
      messages: [{ role: 'user', content: '请调用 phyopt_probe，ready=true。', timestamp: Date.now() }],
      tools: [PROBE_TOOL],
    };
    const message = await models.completeSimple(model, context, {
      signal: controller.signal,
      maxTokens: model.maxTokens,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(config.reasoningEffort ? { reasoning: config.reasoningEffort } : {}),
    });
    if (controller.signal.aborted) return { ok: false, model_id: config.modelId, tool_call: false, error: '模型工具调用验证超时或已取消' };
    if (message.errorMessage) return { ok: false, model_id: config.modelId, tool_call: false, error: sanitizeError(message.errorMessage, config.apiKey) };
    const calls = toolCalls(message);
    const valid = calls.some((call) => call.name === PROBE_TOOL.name);
    return { ok: valid, model_id: config.modelId, tool_call: valid, error: valid ? null : '模型未返回合法的 phyopt_probe tool call' };
  } catch (error) {
    const message = controller.signal.aborted ? '模型工具调用验证超时或已取消' : sanitizeError((error as Error).message, config.apiKey);
    return { ok: false, model_id: config.modelId, tool_call: false, error: message };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
