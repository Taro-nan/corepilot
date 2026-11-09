import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { discoverOpenAIModels } from '../src/model/model-discovery.js';
import { verifyToolCalling } from '../src/model/tool-verification.js';
import { createPiModels, createPiToolSubmissionStream, COREPILOT_PI_PROVIDER_ID } from '../src/model/pi-provider.js';
import { runPiAgentRuntime } from '../src/agent/pi-agent-runtime.js';
import { Type } from 'typebox';

test('uses the Pi OpenAI-compatible wire protocol with an API key', async () => {
  let authorization: string | null = null;
  const requestBodies: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'wire-model' }] }));
      return;
    }
    if (request.url === '/v1/chat/completions') {
      authorization = request.headers.authorization ?? null;
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        requestBodies.push(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'text/event-stream');
        response.write(`data: ${JSON.stringify({ id: 'completion-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'corepilot_probe', arguments: '{}' } }] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'completion-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    assert.deepEqual(await discoverOpenAIModels(endpoint, 'wire-secret'), [{ id: 'wire-model', label: 'wire-model' }]);
    const keyedResult = await verifyToolCalling({ endpoint, modelId: 'wire-model', apiKey: 'wire-secret', maxOutputTokens: 4096 }, { timeoutMs: 3000 });
    assert.equal(keyedResult.ok, true, keyedResult.error ?? 'keyed wire verification failed');
    assert.equal(authorization, 'Bearer wire-secret');
    const deepseekStyleRequest = JSON.parse(requestBodies[0] ?? '{}') as { max_tokens?: number; max_completion_tokens?: number };
    assert.equal(deepseekStyleRequest.max_tokens, 4096);
    assert.equal(deepseekStyleRequest.max_completion_tokens, undefined);

    const reasoningResult = await verifyToolCalling({ endpoint, modelId: 'wire-model', apiKey: 'wire-secret', reasoningEffort: 'high', maxOutputTokens: 321 }, { timeoutMs: 3000 });
    assert.equal(reasoningResult.ok, true, reasoningResult.error ?? 'reasoning wire verification failed');
    const openAiReasoningRequest = JSON.parse(requestBodies[1] ?? '{}') as { reasoning_effort?: string; max_completion_tokens?: number; messages: Array<{ role: string }> };
    assert.equal(openAiReasoningRequest.reasoning_effort, 'high');
    assert.equal(openAiReasoningRequest.max_completion_tokens, 321);
    assert.equal(openAiReasoningRequest.messages[0].role, 'system', 'custom endpoint reasoning does not grant developer-role support');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('DeepSeek uses Pi native thinking controls and preserves max_tokens for tool-only code submission', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'draft', type: 'function', function: { name: 'submit', arguments: '{"code":"ready"}' } }] }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`, 'data: [DONE]\n\n',
    ].join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  for (const thinking of ['off', 'high'] as const) {
    const models = createPiModels({ endpoint: 'https://api.deepseek.com/v1', modelId: 'test-model', apiKey: 'fixture', maxOutputTokens: 4096,
      ...(thinking === 'high' ? { reasoningEffort: 'high' } : {}) });
    const model = models.getModel(COREPILOT_PI_PROVIDER_ID, 'test-model')!;
    const result = await runPiAgentRuntime('Submit code.', { model, systemPrompt: 'Submit using the tool.', tools: [{ name: 'submit', label: 'submit', description: 'submit',
      parameters: Type.Object({ code: Type.String() }), execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }) }],
      thinkingLevel: thinking, streamFn: createPiToolSubmissionStream(models, fetcher), stopAfterSuccessfulTools: ['submit'], requireSuccessfulStopTool: true });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  assert.equal(requests[0].tool_choice, 'required');
  assert.equal(requests[0].max_tokens, 4096);
  assert.equal(requests[0].max_completion_tokens, undefined);
  assert.deepEqual(requests[1].thinking, { type: 'enabled' });
  assert.notEqual(requests[1].tool_choice, 'required');
  assert.equal(requests[1].reasoning_effort, 'high');
  assert.equal(requests[1].max_tokens, 4096);
});
