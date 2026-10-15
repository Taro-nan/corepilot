import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import type { DevelopmentFindings } from '../contracts/development-investigation.js';
import type { CandidateEvaluationDecision } from '../contracts/candidate-evaluation-feedback.js';

export type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';

export interface PiAgentRuntimeResult {
  ok: boolean;
  text: string;
  hypothesis: string | null;
  hypothesis_id?: string;
  development_findings: DevelopmentFindings | null;
  candidate_evaluation_decision?: CandidateEvaluationDecision;
  no_source_mutation: boolean;
  turns: number;
  tool_calls: number;
  messages: AgentMessage[];
  error: string | null;
}

export interface PiAgentRuntimeOptions {
  systemPrompt: string;
  model: Model<any>;
  tools: readonly AgentTool[];
  streamFn: StreamFn;
  thinkingLevel?: ThinkingLevel;
  sessionId?: string;
  maxTurns?: number;
  maxToolCalls?: number;
  /** End this Candidate-editing run after one of these tools succeeds. */
  stopAfterSuccessfulTools?: readonly string[];
  /** Treat a model-complete response without a successful stop tool as a failed editing run. */
  requireSuccessfulStopTool?: boolean;
  /**
   * Use Pi's native follow-up queue when a provider emits a progress-only,
   * text-only turn before satisfying the run's explicit completion contract.
   */
  textOnlyFollowUp?: {
    maxAttempts: number;
    message: string;
  };
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface PiRuntimeStreamOptions {
  fetch?: typeof fetch;
  /** Zero or undefined means that the provider request has no PhyOpt time limit. */
  timeoutMs?: number;
}

/**
 * Adapt the configured Pi Models registry to pi-agent-core's StreamFn.
 * Streaming, retries, cancellation, and response assembly remain owned by Pi.
 */
export function createPiRuntimeStream(models: Models, options: PiRuntimeStreamOptions = {}): StreamFn {
  return (model, context, streamOptions) => models.streamSimple(model, context, {
    ...streamOptions,
    maxTokens: model.maxTokens,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
  });
}

function assistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const text = (message as AssistantMessage).content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

/**
 * Preserve the optimization rationale from Pi's transcript. Agents are asked
 * to emit one `Hypothesis:` line before mutating source. The longest assistant
 * text is a compatibility fallback for providers that omit the marker; using
 * the final text alone can accidentally persist a short tool-retry comment.
 */
function candidateHypothesis(messages: readonly AgentMessage[]): string | null {
  const texts = messages.flatMap((message) => {
    if (message.role !== 'assistant') return [];
    const text = (message as AssistantMessage).content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('')
      .trim();
    return text ? [text] : [];
  });
  for (let textIndex = texts.length - 1; textIndex >= 0; textIndex -= 1) {
    const lines = texts[textIndex]?.split(/\r?\n/) ?? [];
    for (const line of lines) {
      const match = line.match(/^\s*(?:hypothesis|\u5047\u8bbe)\s*[:\uff1a]\s*(.+?)\s*$/i);
      if (match?.[1]) return match[1].slice(0, 16_384);
    }
  }
  const fallback = texts.reduce<string | null>((longest, text) => (
    longest === null || text.length > longest.length ? text : longest
  ), null);
  return fallback?.slice(0, 16_384) ?? null;
}

/**
 * Run one Candidate-editing session with the complete pi-agent-core runtime.
 * PhyOpt supplies tools and stop policy; Pi owns the model/tool loop and transcript.
 */
export async function runPiAgentRuntime(prompt: string, options: PiAgentRuntimeOptions): Promise<PiAgentRuntimeResult> {
  const stopTools = new Set(options.stopAfterSuccessfulTools ?? []);
  const maxTurns = options.maxTurns ?? 32;
  const maxToolCalls = options.maxToolCalls ?? 128;
  let turns = 0;
  let toolCalls = 0;
  let successfulStopTool: string | null = null;
  let limitError: string | null = null;
  let cancelled = options.signal?.aborted === true;
  let noSourceMutation = false;
  let textOnlyFollowUps = 0;

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? 'off',
      tools: [...options.tools],
    },
    streamFn: options.streamFn,
    sessionId: options.sessionId,
    toolExecution: 'sequential',
    shouldStopAfterTurn: ({ toolResults }) => {
      const successfulMutation = toolResults.find((result) => !result.isError && stopTools.has(result.toolName));
      if (successfulMutation) {
        successfulStopTool = successfulMutation.toolName;
        return true;
      }
      if (turns >= maxTurns) {
        limitError = `agent turn limit exceeded (${maxTurns})`;
        return true;
      }
      if (toolCalls >= maxToolCalls) {
        limitError = `agent tool call limit exceeded (${maxToolCalls})`;
        return true;
      }
      return false;
    },
  });

  agent.subscribe(async (event) => {
    if (event.type === 'turn_start') turns += 1;
    if (event.type === 'tool_execution_start') toolCalls += 1;
    if (event.type === 'turn_end' && event.toolResults.length === 0 &&
        options.requireSuccessfulStopTool === true && successfulStopTool === null &&
        options.textOnlyFollowUp && textOnlyFollowUps < options.textOnlyFollowUp.maxAttempts &&
        turns < maxTurns && toolCalls < maxToolCalls && !cancelled) {
      textOnlyFollowUps += 1;
      agent.followUp({
        role: 'user',
        content: options.textOnlyFollowUp.message,
        timestamp: Date.now(),
      });
    }
    // Observability must not replace or interrupt Pi's execution semantics.
    try {
      await options.onEvent?.(event);
    } catch {
      // The durable Agent result remains authoritative if a progress observer fails.
    }
  });

  const onAbort = () => {
    cancelled = true;
    agent.abort();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (!cancelled) {
      await agent.prompt(prompt);
      await agent.waitForIdle();
    }

    const messages = [...agent.state.messages];
    let error = cancelled ? 'cancelled' : (limitError ?? agent.state.errorMessage ?? null);
    if (!error && options.requireSuccessfulStopTool === true && successfulStopTool === null) {
      error = 'agent completed without applying a source mutation';
      noSourceMutation = true;
    }
    return {
      ok: error === null,
      text: assistantText(messages),
      hypothesis: candidateHypothesis(messages),
      development_findings: null,
      no_source_mutation: noSourceMutation,
      turns,
      tool_calls: toolCalls,
      messages,
      error,
    };
  } catch (error) {
    const messages = [...agent.state.messages];
    return {
      ok: false,
      text: assistantText(messages),
      hypothesis: candidateHypothesis(messages),
      development_findings: null,
      no_source_mutation: false,
      turns,
      tool_calls: toolCalls,
      messages,
      error: cancelled ? 'cancelled' : (error as Error).message,
    };
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
