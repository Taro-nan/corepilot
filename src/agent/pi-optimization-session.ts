import {
  AgentHarness, BACKGROUND_CONTEXT, withAbortSignal, value,
  type AgentLane, type AgentTool, type AgentToolResult,
  type Entry, type HarnessEvent, type Session, type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import type { AssistantMessage, Model, Models } from '@earendil-works/pi-ai';
import type { PiAgentRuntimeResult } from './pi-agent-runtime.js';
import type { OptimizationSessionEvents, OptimizationSessionSummary } from '../contracts/optimization-session.js';

const metricsKey = value<{ turns: number; tool_calls: number; compactions: number }>('corepilot', 'metrics');
const checkpointKey = value<unknown>('corepilot', 'workflow-checkpoint');
const mutatingTools = new Set(['write_file', 'create_file', 'replace_text', 'delete_file', 'move_file', 'revert_file', 'record_hypothesis']);

export interface PiOptimizationSessionOptions {
  id: string;
  directory: string;
  models: Models;
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel?: ThinkingLevel;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onEvent?: (event: HarnessEvent) => void | Promise<void>;
}

/** Pi owns messages, tool batches, compaction and recovery; CorePilot supplies domain tools. */
export class PiOptimizationSession {
  private harness!: AgentHarness;
  private lane!: AgentLane;
  private metrics = { turns: 0, tool_calls: 0, compactions: 0 };
  private deadline = Infinity;
  private budgetExhausted = false;
  private submitted = false;
  private followUps = 0;
  private canFinish = false;
  private finishReason: string | null = null;
  private readonly terminations = new Set<string>();

  private constructor(private readonly repo: SqliteSessionRepo, private readonly session: Session,
    private readonly options: PiOptimizationSessionOptions) {}

  static async open(options: PiOptimizationSessionOptions): Promise<PiOptimizationSession> {
    const repo = new SqliteSessionRepo({ directory: options.directory, databaseFactory: createNodeSqliteFactory() });
    try {
      const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find(item => item.id === options.id);
      const stored = metadata ? await repo.open(metadata, BACKGROUND_CONTEXT) : await repo.create({ id: options.id }, BACKGROUND_CONTEXT);
      const instance = new PiOptimizationSession(repo, stored, options);
      await instance.initialize();
      return instance;
    } catch (error) {
      await repo.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private async initialize(): Promise<void> {
    this.metrics = (await this.session.getValue(metricsKey, BACKGROUND_CONTEXT))?.value ?? this.metrics;
    // Transport adaptation also covers Pi's native compaction requests.
    const models = new Proxy(this.options.models, {
      get: (target, key) => {
        if (key === 'streamSimple' || key === 'completeSimple') {
          return (model: Model<any>, context: any, options: any) => target[key](model, context, {
            ...this.budgetedRequestOptions(options), maxTokens: model.maxTokens, ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
          });
        }
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const created = await AgentHarness.create({
      session: this.session, models, model: this.options.model,
      systemPrompt: this.options.systemPrompt,
      thinkingLevel: this.options.thinkingLevel ?? 'off',
      toolExecution: 'sequential',
      streamOptions: { ...(this.options.timeoutMs && this.options.timeoutMs > 0 ? { timeoutMs: this.options.timeoutMs } : {}) },
      compaction: { enabled: true, reserveTokens: Math.min(this.options.model.maxTokens + 8192, Math.floor(this.options.model.contextWindow / 2)), keepRecentTokens: 16_000 },
    }, BACKGROUND_CONTEXT);
    this.harness = created.harness;
    this.lane = await this.harness.lane('optimization', BACKGROUND_CONTEXT);
    await this.lane.setModel({ provider: this.options.model.provider, modelId: this.options.model.id }, BACKGROUND_CONTEXT);
    await this.lane.setThinkingLevel(this.options.thinkingLevel ?? 'off', BACKGROUND_CONTEXT);
    this.harness.hooks.on('before_request', () => {
      const remaining = this.deadline - Date.now();
      if (remaining <= 0) {
        this.budgetExhausted = true;
        // Pi treats observer-hook errors as diagnostics. The request adapter
        // below enforces this boundary before invoking the provider.
        return { streamOptions: { timeoutMs: 1 } };
      }
      return { streamOptions: { timeoutMs: Math.max(1, Math.min(remaining, this.options.timeoutMs && this.options.timeoutMs > 0 ? this.options.timeoutMs : remaining)) } };
    });
    this.harness.hooks.on('before_tool', () => {
      if (Date.now() < this.deadline) return undefined;
      this.budgetExhausted = true;
      return { block: { reason: 'Continuation time budget exhausted. The workspace and completed experiments are saved; resume to continue.', terminate: true } };
    });
    this.harness.hooks.on('after_tool', event => this.terminations.has(event.toolCallId) ? { terminate: true } : undefined);
    this.harness.hooks.on('before_run_end', () => {
      if (!this.canFinish || this.submitted || this.terminations.size || this.followUps >= 2 || Date.now() >= this.deadline) return undefined;
      this.followUps += 1;
      return { followUp: 'Continue the engineering task with the available tools. A text-only progress update does not finish the task. Finish complete edits with submit_candidate; when evidence supports no further change, call finish_optimization with the reason. Do not manufacture an improvement.' };
    });
    const observe = async (event: HarnessEvent) => {
      if (event.type === 'turn_start') this.metrics.turns += 1;
      if (event.type === 'tool_start') this.metrics.tool_calls += 1;
      if (event.type === 'compaction_end') this.metrics.compactions += 1;
      if (['turn_start', 'tool_start', 'compaction_end'].includes(event.type)) await this.session.setValue(metricsKey, { ...this.metrics }, BACKGROUND_CONTEXT);
      await this.options.onEvent?.(event);
    };
    for (const type of ['turn_start', 'tool_start', 'tool_end', 'message_end', 'compaction_start', 'compaction_end', 'retry_scheduled', 'run_end'] as const) {
      this.harness.events.on(type, observe);
    }
  }

  private budgetedRequestOptions<T>(options: T): T {
    if (Date.now() >= this.deadline) {
      this.budgetExhausted = true;
      throw new Error('Optimization continuation time budget exhausted');
    }
    return options;
  }

  async checkpoint<T>(data: T): Promise<void> {
    await this.session.setValue(checkpointKey, data, BACKGROUND_CONTEXT);
  }

  async readCheckpoint<T>(): Promise<T | undefined> {
    return (await this.session.getValue(checkpointKey, BACKGROUND_CONTEXT))?.value as T | undefined;
  }

  async record<T>(key: string, data: T): Promise<void> {
    await this.session.setValue(value<T>('corepilot', key), data, BACKGROUND_CONTEXT);
  }

  async readRecord<T>(key: string): Promise<T | undefined> {
    return (await this.session.getValue(value<T>('corepilot', key), BACKGROUND_CONTEXT))?.value;
  }

  async progress(data: { phase: string; last_event?: string }): Promise<void> {
    await this.lane.appendCustomEntry('corepilot.progress', data, BACKGROUND_CONTEXT);
  }

  async steer(message: string): Promise<void> {
    const result = await this.lane.steer(message, undefined, BACKGROUND_CONTEXT);
    if (!result.ok) throw result.error;
  }

  async run(prompt: string, tools: readonly AgentTool[], signal: AbortSignal, timeLimitMs: number, afterEvaluation = false): Promise<PiAgentRuntimeResult> {
    this.deadline = Date.now() + timeLimitMs;
    this.budgetExhausted = false;
    this.submitted = false;
    this.followUps = 0;
    this.canFinish = tools.some(tool => tool.name === 'finish_optimization');
    this.finishReason = null;
    this.terminations.clear();
    const before = { ...this.metrics };
    await this.harness.setTools(tools.map(tool => ({
      ...tool,
      execute: async (toolCallId, args, onUpdate, _toolContext, invocation, context) => {
        const cached = await invocation.getMemo('result');
        if (cached) {
          const result = cached as unknown as AgentToolResult<unknown> & { terminate?: boolean };
          if (result.terminate || ['submit_candidate', 'finish_optimization'].includes(tool.name)) this.terminations.add(toolCallId);
          if (tool.name === 'submit_candidate') this.submitted = true;
          return result;
        }
        if (mutatingTools.has(tool.name)) {
          if (await invocation.getMemo('started')) throw new Error(`Interrupted ${tool.name}: inspect the saved workspace and reasoning history before applying another mutation. This call was not replayed.`);
          await invocation.setMemo('started', true);
        }
        const result = await tool.execute(toolCallId, args, context.abortSignal, onUpdate);
        if (tool.name === 'finish_optimization') this.finishReason = (args as { reason: string }).reason;
        await invocation.setMemo('result', JSON.parse(JSON.stringify(result)));
        if ((result as { terminate?: boolean }).terminate || ['submit_candidate', 'finish_optimization'].includes(tool.name)) this.terminations.add(toolCallId);
        if (tool.name === 'submit_candidate') this.submitted = true;
        return result;
      },
    })), BACKGROUND_CONTEXT);
    await this.lane.setActiveTools(tools.map(tool => tool.name), BACKGROUND_CONTEXT);
    const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
    let error: string | null = null;
    try {
      const execution = await this.lane.inspectExecution(BACKGROUND_CONTEXT);
      if (execution.current && !afterEvaluation) await this.steer(prompt);
      let result = execution.current ? await this.lane.resume(context) : await this.lane.prompt(prompt, undefined, context);
      // A crash may leave the SDK finishing a submission already consumed by
      // the domain checkpoint. Settle that boundary before delivering feedback.
      if (execution.current && afterEvaluation && result.ok && result.value.status === 'completed' && !signal.aborted) {
        this.submitted = false; this.terminations.clear();
        result = await this.lane.prompt(prompt, undefined, context);
      }
      if (!result.ok) error = result.error.message;
      else if (result.value.status !== 'completed') error = ('error' in result.value ? result.value.error?.message : null) ?? result.value.status;
    } catch (failure) {
      error = (failure as Error).message;
    }
    if (Date.now() >= this.deadline && error) this.budgetExhausted = true;
    const entries = await this.session.findEntries({ type: 'message', order: 'asc' }, BACKGROUND_CONTEXT);
    const messages = entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant') as AssistantMessage | undefined;
    const text = this.finishReason ?? lastAssistant?.content.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    const noMutation = error === null && !this.budgetExhausted && !this.submitted;
    return { ok: error === null && !this.budgetExhausted && !noMutation, text, hypothesis: null, development_findings: null,
      no_source_mutation: noMutation, turns: this.metrics.turns - before.turns, tool_calls: this.metrics.tool_calls - before.tool_calls,
      messages, error: signal.aborted ? 'cancelled' : this.budgetExhausted ? null : noMutation ? 'agent completed without applying a source mutation' : error,
      ...(this.budgetExhausted ? { budget_exhausted: true } : {}) };
  }

  async summary(): Promise<OptimizationSessionSummary> {
    const stats = await this.session.getStats(BACKGROUND_CONTEXT);
    return { id: this.options.id, directory: this.options.directory, ...this.metrics, reported_tokens: stats.usage.totalTokens > 0 ? stats.usage.totalTokens : null };
  }

  async events(after = 0, limit = 100): Promise<OptimizationSessionEvents> {
    return sessionEvents(this.session, after, limit);
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
    await this.repo.close(BACKGROUND_CONTEXT);
  }
}

function eventEntries(entry: Entry): OptimizationSessionEvents['events'] {
  const common = { id: entry.id, sequence: entry.seq, timestamp: new Date(entry.timestamp).toISOString() };
  if (entry.type === 'compaction') return [{ ...common, kind: 'compaction', text: '会话上下文已压缩，原始记录保留。' }];
  if (entry.type === 'custom' && entry.customType === 'corepilot.progress') {
    const data = entry.data as { phase: string; last_event?: string };
    return [{ ...common, kind: 'progress', text: data.last_event ?? data.phase }];
  }
  if (entry.type !== 'message') return [];
  const message = entry.message;
  if (message.role === 'toolResult') return [{ ...common, kind: 'tool_result', tool_name: message.toolName, is_error: message.isError,
    text: message.content.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 8192) }];
  if (message.role !== 'assistant' && message.role !== 'user') return [];
  if (typeof message.content === 'string') return [{ ...common, kind: 'message', role: message.role, text: message.content.slice(0, 8192) }];
  return message.content.flatMap((item, index): OptimizationSessionEvents['events'] => {
    if (item.type === 'text') return [{ ...common, id: `${entry.id}:${index}`, kind: 'message', role: message.role, text: item.text.slice(0, 8192) }];
    if (item.type === 'toolCall') return [{ ...common, id: `${entry.id}:${index}`, kind: 'tool_call', tool_name: item.name, text: JSON.stringify(item.arguments).slice(0, 2048) }];
    return [];
  });
}

async function sessionEvents(session: Session, after: number, limit: number): Promise<OptimizationSessionEvents> {
  const entries = await session.findEntries({ order: 'asc', cursor: { seq: after }, limit }, BACKGROUND_CONTEXT);
  return { events: entries.flatMap(eventEntries), next_cursor: entries.at(-1)?.seq ?? after };
}

/** Reads SDK-owned history after a worker has closed, without loading a model. */
export async function readOptimizationSessionEvents(directory: string, id: string, after = 0, limit = 100): Promise<OptimizationSessionEvents> {
  const repo = new SqliteSessionRepo({ directory, databaseFactory: createNodeSqliteFactory() });
  try {
    const metadata = (await repo.list(undefined, BACKGROUND_CONTEXT)).find(item => item.id === id);
    if (!metadata) return { events: [], next_cursor: after };
    return await sessionEvents(await repo.open(metadata, BACKGROUND_CONTEXT), after, limit);
  } finally { await repo.close(BACKGROUND_CONTEXT); }
}
