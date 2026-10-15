import assert from 'node:assert/strict';
import test from 'node:test';
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, Models } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { createPiRuntimeStream, runPiAgentRuntime } from '../src/agent/pi-agent-runtime.js';
import { candidateDecisionTool } from '../src/agent/candidate-feedback-tool.js';
import type { CandidateEvaluationFeedback } from '../src/contracts/candidate-evaluation-feedback.js';

const model = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://test.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
} as Model<Api>;

function assistant(
  content: AssistantMessage['content'] = [{ type: 'text', text: 'done' }],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'start', partial: message });
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else if (message.stopReason === 'stop' || message.stopReason === 'length' || message.stopReason === 'toolUse' || message.stopReason === 'deferred') {
      stream.push({ type: 'done', reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

test('Pi can finish a failed-Candidate decision without a forced mutation or text-only retries', async () => {
  const feedback: CandidateEvaluationFeedback = { schema_version: 1, candidate_id: 'candidate:1', experiment_id: 'experiment:1', experiment_validity: 'INVALID', correctness_status: 'FAILED', correctness_coverage: { planned: 1, executed: 1, passed: 0, failed: 1, complete: true }, failed_cases: [], failure_category: 'CORRECTNESS_FAILURE', failure: null, failure_classification: null, performance_summary: { status: 'NOT_EXECUTED', classification: 'DIAGNOSTIC_ONLY', weighted_geomean: null, overall_ci_lower: null, key_case_ci_lower: null, reason: null, workloads: [] }, development_gate: null, resource_context: { validity: 'VALID', error_reason: null, observed: {} }, recommended_investigation_area: ['SOURCE_SEMANTICS'] };
  for (const action of ['ABANDON', 'NEW_HYPOTHESIS'] as const) {
    let calls = 0;
    let recorded: string | null = null;
    const result = await runPiAgentRuntime('review failed evidence', {
      systemPrompt: 'test', model,
      tools: [candidateDecisionTool(feedback, decision => { recorded = decision.action; })],
      streamFn: () => {
        calls += 1;
        assert.equal(calls, 1);
        return completedStream(assistant([{ type: 'toolCall', id: 'decision', name: 'record_candidate_decision', arguments: { candidate_id: 'candidate:1', experiment_id: 'experiment:1', action, reason: 'Use the observed failure.', ...(action === 'NEW_HYPOTHESIS' ? { hypothesis: 'A revised boundary handling hypothesis.' } : {}) } }], 'toolUse'));
      },
      stopAfterSuccessfulTools: ['replace_text'], requireSuccessfulStopTool: true,
      textOnlyFollowUp: { maxAttempts: 4, message: 'continue' },
    });
    assert.equal(recorded, action);
    assert.equal(result.no_source_mutation, true);
    assert.equal(result.error, 'agent completed without applying a source mutation');
    assert.equal(result.turns, 1);
  }
});

test('Pi Agent runtime owns multi-turn tool execution and stops after a successful source mutation', async () => {
  const responses = [
    assistant([{ type: 'toolCall', id: 'read-1', name: 'read_file', arguments: { path: 'driver.c' } }], 'toolUse'),
    assistant([
      { type: 'text', text: 'Hypothesis: reduce wide single-thread dispatch overhead.' },
      { type: 'toolCall', id: 'edit-1', name: 'replace_text', arguments: { path: 'driver.c', old_text: 'old', new_text: 'new' } },
    ], 'toolUse'),
    assistant([
      { type: 'text', text: 'The exact edit text needs one short retry.' },
      { type: 'toolCall', id: 'edit-2', name: 'replace_text', arguments: { path: 'driver.c', old_text: 'old', new_text: 'new' } },
    ], 'toolUse'),
  ];
  const contexts: Context[] = [];
  const streamFn: StreamFn = (_model, context) => {
    contexts.push({ ...context, messages: [...context.messages] });
    const response = responses.shift();
    assert.ok(response, 'unexpected extra model turn');
    return completedStream(response);
  };
  const executed: string[] = [];
  let editAttempts = 0;
  const tools: AgentTool[] = [
    {
      name: 'read_file',
      label: 'Read file',
      description: 'read',
      parameters: Type.Object({ path: Type.String() }),
      executionMode: 'sequential',
      execute: async () => {
        executed.push('read_file');
        return { content: [{ type: 'text', text: 'old' }], details: {} };
      },
    },
    {
      name: 'replace_text',
      label: 'Replace text',
      description: 'replace',
      parameters: Type.Object({ path: Type.String(), old_text: Type.String(), new_text: Type.String() }),
      executionMode: 'sequential',
      execute: async () => {
        executed.push('replace_text');
        editAttempts += 1;
        if (editAttempts === 1) throw new Error('old_text must occur exactly once');
        return { content: [{ type: 'text', text: 'changed' }], details: {} };
      },
    },
  ];
  const events: string[] = [];

  const result = await runPiAgentRuntime('optimize', {
    systemPrompt: 'test',
    model,
    tools,
    streamFn,
    stopAfterSuccessfulTools: ['replace_text'],
    requireSuccessfulStopTool: true,
    onEvent: (event) => { events.push(event.type); },
  });

  assert.equal(result.ok, true, result.error ?? undefined);
  assert.equal(result.turns, 3);
  assert.equal(result.tool_calls, 3);
  assert.equal(result.text, 'The exact edit text needs one short retry.');
  assert.equal(result.hypothesis, 'reduce wide single-thread dispatch overhead.');
  assert.equal(result.no_source_mutation, false);
  assert.deepEqual(executed, ['read_file', 'replace_text', 'replace_text']);
  assert.equal(contexts.length, 3);
  assert.ok(contexts[1]?.messages.some((message) => message.role === 'toolResult'));
  assert.ok(contexts[2]?.messages.some((message) => message.role === 'toolResult' && message.isError));
  assert.equal(events.filter((event) => event === 'turn_start').length, 3);
  assert.equal(events.filter((event) => event === 'tool_execution_start').length, 3);
  assert.equal(events.at(-1), 'agent_end');
});

test('tool exceptions become Pi tool-result errors and are returned to the next model turn', async () => {
  const responses = [
    assistant([{ type: 'toolCall', id: 'read-1', name: 'read_file', arguments: { path: 'missing.c' } }], 'toolUse'),
    assistant([{ type: 'text', text: 'Recovered after inspecting the tool error.' }]),
  ];
  let observedErrorResult = false;
  const streamFn: StreamFn = (_model, context) => {
    if (context.messages.some((message) => message.role === 'toolResult' && message.isError)) observedErrorResult = true;
    const response = responses.shift();
    assert.ok(response, 'unexpected extra model turn');
    return completedStream(response);
  };
  const tool: AgentTool = {
    name: 'read_file',
    label: 'Read file',
    description: 'read',
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => { throw new Error('file not found: missing.c'); },
  };

  const result = await runPiAgentRuntime('inspect', {
    systemPrompt: 'test',
    model,
    tools: [tool],
    streamFn,
  });

  assert.equal(result.ok, true, result.error ?? undefined);
  assert.equal(observedErrorResult, true);
  assert.ok(result.messages.some((message) => message.role === 'toolResult' && message.isError));
  assert.equal(result.text, 'Recovered after inspecting the tool error.');
  assert.equal(result.hypothesis, 'Recovered after inspecting the tool error.');
  assert.equal(result.no_source_mutation, false);
});

test('external AbortSignal cancels the active Pi Agent provider turn', async () => {
  const streamFn: StreamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const abort = () => {
      const message = assistant([{ type: 'text', text: '' }], 'aborted');
      message.errorMessage = 'Operation aborted';
      stream.push({ type: 'error', reason: 'aborted', error: message });
      stream.end();
    };
    if (options?.signal?.aborted) queueMicrotask(abort);
    else options?.signal?.addEventListener('abort', abort, { once: true });
    return stream;
  };
  const controller = new AbortController();
  const started = Date.now();
  const pending = runPiAgentRuntime('wait', {
    systemPrompt: 'test',
    model,
    tools: [],
    streamFn,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cancelled');
  assert.ok(Date.now() - started < 500);
});

test('model completion without a required source mutation is a distinct non-crash outcome', async () => {
  const result = await runPiAgentRuntime('optimize', {
    systemPrompt: 'test',
    model,
    tools: [],
    streamFn: () => completedStream(assistant([{ type: 'text', text: 'No defensible change remains.' }])),
    requireSuccessfulStopTool: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.no_source_mutation, true);
  assert.equal(result.error, 'agent completed without applying a source mutation');
});

test('Pi native follow-up resumes a progress-only text turn without an outer agent loop', async () => {
  const responses = [
    assistant([{ type: 'text', text: 'Let me inspect the final call path.' }]),
    assistant([
      { type: 'text', text: 'Hypothesis: remove one redundant dispatch branch.' },
      { type: 'toolCall', id: 'edit-after-follow-up', name: 'replace_text', arguments: { path: 'driver.c', old_text: 'old', new_text: 'new' } },
    ], 'toolUse'),
  ];
  const contexts: Context[] = [];
  const result = await runPiAgentRuntime('optimize', {
    systemPrompt: 'test',
    model,
    tools: [{
      name: 'replace_text',
      label: 'Replace text',
      description: 'replace',
      parameters: Type.Object({ path: Type.String(), old_text: Type.String(), new_text: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: 'changed' }], details: {} }),
    }],
    streamFn: (_model, context) => {
      contexts.push({ ...context, messages: [...context.messages] });
      const response = responses.shift();
      assert.ok(response, 'unexpected extra model turn');
      return completedStream(response);
    },
    stopAfterSuccessfulTools: ['replace_text'],
    requireSuccessfulStopTool: true,
    textOnlyFollowUp: { maxAttempts: 2, message: 'Continue with the next required tool.' },
  });

  assert.equal(result.ok, true, result.error ?? undefined);
  assert.equal(result.turns, 2);
  assert.equal(result.tool_calls, 1);
  assert.equal(contexts[1]?.messages.at(-1)?.role, 'user');
  assert.equal((contexts[1]?.messages.at(-1) as { content?: string }).content, 'Continue with the next required tool.');
});

test('Pi stream adapter preserves the model token budget and omits a zero timeout', () => {
  let observedOptions: Record<string, unknown> | undefined;
  const models = {
    streamSimple: (_model: Model<Api>, _context: Context, options?: Record<string, unknown>) => {
      observedOptions = options;
      return completedStream(assistant());
    },
  } as unknown as Models;
  const streamFn = createPiRuntimeStream(models, { timeoutMs: 0 });

  streamFn(model, { systemPrompt: 'test', messages: [] });

  assert.equal(observedOptions?.maxTokens, 16_384);
  assert.equal('timeoutMs' in (observedOptions ?? {}), false);
});
