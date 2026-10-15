import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { discoverOpenAIModels } from '../src/model/model-discovery.js';
import { verifyToolCalling } from '../src/model/tool-verification.js';

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
        response.write(`data: ${JSON.stringify({ id: 'completion-1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'phyopt_probe', arguments: '{}' } }] }, finish_reason: null }] })}\n\n`);
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
    const openAiReasoningRequest = JSON.parse(requestBodies[1] ?? '{}') as { reasoning_effort?: string; max_completion_tokens?: number };
    assert.equal(openAiReasoningRequest.reasoning_effort, 'high');
    assert.equal(openAiReasoningRequest.max_completion_tokens, 321);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
