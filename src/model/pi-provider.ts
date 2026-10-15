import { createProvider, createModels, type Models } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { contentText } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { ModelCallResult, ModelProvider } from './provider.js';
import { newRequestId, withRetriesAndTimeout, DEFAULT_MODEL_CALL_OPTIONS } from './provider.js';

/** Internal Pi provider id for every user-supplied OpenAI-compatible endpoint. */
export const PHYOPT_PI_PROVIDER_ID = 'phyopt-openai-compatible';

export interface PiRuntimeModelConfig {
  modelId: string;
  endpoint: string;
  apiKey: string;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  maxOutputTokens?: number;
}

export interface PiModelProviderConfig extends PiRuntimeModelConfig {
  /** Injectable Models collection for tests. */
  models?: Models;
  /** Optional model-only transport, for example a configured proxy fetch. */
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/\/+$/, '');
}

function isOfficialOpenAiEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Construct a Pi model for a user endpoint. The provider id is deliberately
 * internal: public YAML contains only endpoint and model_id.
 */
export function createPiModel(config: PiRuntimeModelConfig): Model<'openai-completions'> {
  const endpoint = normalizeEndpoint(config.endpoint);
  const officialOpenAi = isOfficialOpenAiEndpoint(endpoint);
  const reasoningCompatible = officialOpenAi || config.reasoningEffort !== undefined;
  return {
    id: config.modelId,
    name: config.modelId,
    api: 'openai-completions',
    provider: PHYOPT_PI_PROVIDER_ID,
    baseUrl: endpoint,
    reasoning: config.reasoningEffort !== undefined,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: config.maxOutputTokens ?? 16_384,
    compat: {
      supportsStore: officialOpenAi,
      supportsDeveloperRole: reasoningCompatible,
      supportsReasoningEffort: reasoningCompatible,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      maxTokensField: reasoningCompatible ? 'max_completion_tokens' : 'max_tokens',
      supportsStrictMode: officialOpenAi,
      thinkingFormat: 'openai',
    },
  };
}

/**
 * Build a Pi Models collection around one dynamic OpenAI-compatible endpoint.
 * The API key remains in this in-memory auth closure and is never persisted by
 * the Pi model registry.
 */
export function createPiModels(config: PiRuntimeModelConfig): Models {
  const model = createPiModel(config);
  const apiKey = config.apiKey.trim();
  const api = openAICompletionsApi();
  const provider = createProvider({
    id: PHYOPT_PI_PROVIDER_ID,
    name: 'CorePilot OpenAI-compatible endpoint',
    baseUrl: model.baseUrl,
    auth: {
      apiKey: {
        name: 'API key',
        resolve: async ({ credential, signal }) => {
          signal.throwIfAborted();
          const key = credential?.key ?? apiKey;
          if (!key?.trim()) throw new Error('API key is required');
          return { auth: { apiKey: key.trim() }, source: 'configured API key' };
        },
      },
    },
    models: [model],
    api,
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** Pi-backed model provider retained for generic provider callers and tests. */
export class PiModelProvider implements ModelProvider {
  readonly provider = PHYOPT_PI_PROVIDER_ID;
  readonly model: string;
  private readonly models: Models;
  private readonly modelId: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly reasoningEffort: PiRuntimeModelConfig['reasoningEffort'];
  private readonly fetch?: typeof fetch;

  constructor(config: PiModelProviderConfig) {
    this.modelId = config.modelId;
    this.apiKey = config.apiKey.trim();
    this.model = this.modelId ? `${PHYOPT_PI_PROVIDER_ID}/${this.modelId}` : PHYOPT_PI_PROVIDER_ID;
    this.models = config.models ?? createPiModels(config);
    this.maxRetries = config.maxRetries ?? DEFAULT_MODEL_CALL_OPTIONS.maxRetries;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MODEL_CALL_OPTIONS.timeoutMs;
    this.reasoningEffort = config.reasoningEffort;
    this.fetch = config.fetch;
  }

  get configured(): boolean {
    return this.modelId.length > 0;
  }

  async call(task: string, context: string, outputConstraints: string, signal?: AbortSignal): Promise<ModelCallResult> {
    const requestId = newRequestId();
    if (!this.configured) {
      return { ok: false, output: null, provider: this.provider, model: this.model, request_id: requestId, attempts: 0, timed_out: false, error: 'model_id is not configured' };
    }
    const model = this.models.getModel(PHYOPT_PI_PROVIDER_ID, this.modelId);
    if (!model) {
      return { ok: false, output: null, provider: this.provider, model: this.model, request_id: requestId, attempts: 0, timed_out: false, error: `model not found: ${this.modelId}` };
    }
    const piContext: Context = {
      systemPrompt: outputConstraints,
      messages: [{ role: 'user', content: `Task:\n${task}\n\nContext:\n${context}`, timestamp: Date.now() }],
    };
    const result = await withRetriesAndTimeout(
      async (attemptSignal) => {
        const message = await this.models.completeSimple(model, piContext, {
          signal: attemptSignal,
          maxTokens: model.maxTokens,
          ...(this.fetch ? { fetch: this.fetch } : {}),
          ...(this.reasoningEffort ? { reasoning: this.reasoningEffort } : {}),
        });
        if (attemptSignal.aborted) throw Object.assign(new Error(String(attemptSignal.reason ?? 'aborted')), { name: 'AbortError' });
        if (message.errorMessage) throw new Error(message.errorMessage);
        const text = contentText(message.content);
        if (!text) throw new Error('empty model response');
        return text;
      },
      { maxRetries: this.maxRetries, timeoutMs: this.timeoutMs },
      signal,
    );
    return {
      ok: result.output !== null && result.error === null,
      output: result.output,
      provider: this.provider,
      model: this.model,
      request_id: requestId,
      attempts: result.attempts,
      timed_out: result.timed_out,
      error: sanitizePiError(result.error, this.apiKey),
    };
  }
}

/** Keep provider diagnostics useful without allowing credential echo. */
function sanitizePiError(error: string | null, apiKey: string): string | null {
  if (!error) return error;
  let sanitized = apiKey ? error.split(apiKey).join('[redacted]') : error;
  sanitized = sanitized.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return sanitized;
}

export type PiAssistantMessage = AssistantMessage;
export type PiApi = Api;
