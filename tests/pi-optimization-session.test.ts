import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Type } from 'typebox';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { createPiModels, COREPILOT_PI_PROVIDER_ID } from '../src/model/pi-provider.js';
import { PiOptimizationSession, readOptimizationSessionEvents } from '../src/agent/pi-optimization-session.js';

function fixture() {
  const models = createPiModels({ modelId: 'fixture', endpoint: 'http://fixture.invalid/v1', apiKey: 'never-persist-this-key' });
  const model = models.getModel(COREPILOT_PI_PROVIDER_ID, 'fixture')!;
  const contexts: Context[] = [];
  const responses: AssistantMessage['content'][] = [];
  models.streamSimple = (_model, context) => {
    contexts.push(structuredClone(context));
    const content = responses.shift();
    assert.ok(content, 'unexpected model request');
    const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      stopReason: content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now(),
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(); });
    return stream;
  };
  return { models, model, contexts, responses };
}

test('native Pi harness retains tools and investigation history across candidate boundaries and worker reopen', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-pi-session-'));
  const f = fixture();
  const options = { directory, id: 'durable', models: f.models, model: f.model, systemPrompt: 'Optimize with evidence.' };
  let session = await PiOptimizationSession.open(options);
  const tools = [{ name: 'submit_candidate', label: 'Submit', description: 'Submit', parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text' as const, text: 'correctness failed at case edge-7' }], details: {}, terminate: true }) }];
  try {
    f.responses.push([{ type: 'toolCall', id: 'submit-1', name: 'submit_candidate', arguments: {} }]);
    const first = await session.run('Inspect kernel.c and optimize.', tools, new AbortController().signal, 10_000);
    assert.equal(first.ok, true, first.error ?? undefined);
    await session.checkpoint({ phase: 'INVESTIGATING', round: 1 });
    await session.close();
    session = await PiOptimizationSession.open(options);
    assert.deepEqual(await session.readCheckpoint(), { phase: 'INVESTIGATING', round: 1 });
    f.responses.push([{ type: 'text', text: 'Repair the boundary handling based on case edge-7.' }]);
    const second = await session.run('Continue from the failed candidate.', tools, new AbortController().signal, 10_000);
    assert.equal(second.no_source_mutation, true);
    assert.ok(f.contexts[1].messages.some(message => message.role === 'toolResult' && message.content.some(item => item.type === 'text' && item.text.includes('edge-7'))));
    assert.ok(f.contexts[1].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Inspect kernel.c')));
    assert.equal((await session.summary()).turns, 2);
    await session.close();
    const events = await readOptimizationSessionEvents(directory, 'durable');
    assert.ok(events.events.some(event => event.kind === 'tool_result' && event.text.includes('edge-7')));
    const next = await readOptimizationSessionEvents(directory, 'durable', events.next_cursor);
    assert.equal(next.events.length, 0);
  } finally {
    await session.close().catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a progress-only response continues through Pi follow-up and an explicit stop preserves its reason', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-pi-finish-'));
  const f = fixture();
  const session = await PiOptimizationSession.open({ directory, id: 'finish', models: f.models, model: f.model, systemPrompt: 'Investigate.' });
  try {
    f.responses.push([{ type: 'text', text: 'I will inspect the current evidence.' }], [{ type: 'toolCall', id: 'finish', name: 'finish_optimization', arguments: { reason: 'The measured evidence does not support another source change.' } }]);
    const result = await session.run('Investigate.', [{ name: 'finish_optimization', label: 'Finish', description: 'Finish with a reason.', parameters: Type.Object({ reason: Type.String() }),
      execute: async () => ({ content: [{ type: 'text', text: 'stopped' }], details: {} }) }], new AbortController().signal, 10_000);
    assert.equal(result.no_source_mutation, true); assert.equal(result.turns, 2);
    assert.match(result.text, /measured evidence/);
    assert.match(JSON.stringify(f.contexts[1].messages.at(-1)), /text-only progress/);
  } finally { await session.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('time-budget exhaustion creates a resumable boundary without claiming an optimization failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-pi-budget-'));
  const f = fixture();
  const session = await PiOptimizationSession.open({ directory, id: 'budget', models: f.models, model: f.model, systemPrompt: 'Investigate.' });
  try {
    const result = await session.run('Investigate.', [], new AbortController().signal, 0);
    assert.equal(result.budget_exhausted, true); assert.equal(result.error, null);
    assert.equal(f.contexts.length, 0, 'an exhausted budget starts no model request');
    await session.checkpoint({ phase: 'AGENT' });
    assert.deepEqual(await session.readCheckpoint(), { phase: 'AGENT' });
  } finally { await session.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a maximum-length user message remains readable in persisted session events', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-pi-message-'));
  const f = fixture();
  const session = await PiOptimizationSession.open({ directory, id: 'message', models: f.models, model: f.model, systemPrompt: 'Investigate.' });
  try {
    const text = 'x'.repeat(16_384 - 'message-end'.length) + 'message-end';
    f.responses.push([{ type: 'toolCall', id: 'submit-long', name: 'submit_candidate', arguments: {} }]);
    await session.run(text, [{ name: 'submit_candidate', label: 'Submit', description: 'Submit', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'submitted' }], details: {}, terminate: true }) }], new AbortController().signal, 10_000);
    const events = await session.events();
    assert.ok(events.events.some(event => event.role === 'user' && event.text === text));
  } finally {
    await session.close();
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('corepilot-pi-message-')) throw new Error('unexpected fixture path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
