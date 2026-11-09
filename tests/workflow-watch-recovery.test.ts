import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { executeWorkflowCommand } from '../src/client/workflow-commands.js';

async function fixture(failures: number, forbidden = false) {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (forbidden) { response.writeHead(403, { 'content-type': 'application/json' }); response.end('{"error":{"code":"FORBIDDEN","message":"fixture denied"}}'); return; }
    if (requests.length <= failures) { request.socket.destroy(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ workflow: { workflow_id: 'workflow:observe', function_name: 'kernel', status: 'GENERATING', progress: { phase: 'AGENT' } }, execution_attached: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { api: new ApiClient(`http://127.0.0.1:${address.port}`), requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('watch reconnects only to the original task after a transient read failure', async () => {
  const f = await fixture(1), controller = new AbortController(), messages: string[] = [];
  try {
    const outcome = await executeWorkflowCommand(f.api, ['watch', 'workflow:observe', '--interval', '0.1'], {
      signal: controller.signal, print: text => { messages.push(text); if (text.includes('状态：GENERATING')) controller.abort(); },
    });
    assert.equal(outcome.ok, true);
    assert.match(outcome.message, /停止观察/);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(row => row === 'GET /v1/workflows/workflow%3Aobserve'));
    assert.ok(messages.some(text => text.includes('连接暂时中断')));
    assert.ok(messages.some(text => text.includes('连接已恢复')));
  } finally { await f.close(); }
});

test('watch reports an unresolved connection after bounded retries and does not retry authorization errors', async () => {
  const down = await fixture(10);
  try {
    const result = await executeWorkflowCommand(down.api, ['watch', 'workflow:observe', '--interval', '0.1']);
    assert.equal(result.ok, false);
    assert.match(result.message, /无法连接.*原任务/);
    assert.equal(down.requests.length, 3);
    assert.ok(down.requests.every(row => row.startsWith('GET ')));
  } finally { await down.close(); }
  const denied = await fixture(0, true);
  try {
    await assert.rejects(executeWorkflowCommand(denied.api, ['watch', 'workflow:observe', '--interval', '0.1']), /fixture denied/);
    assert.equal(denied.requests.length, 1);
  } finally { await denied.close(); }
});

test('watch can retry the report read without creating another task or changing its terminal state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-watch-recovery-'));
  const requests: string[] = [];
  let reportReads = 0;
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url?.endsWith('/report')) {
      if (++reportReads === 1) { request.socket.destroy(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ report: { fixture: true }, markdown: '# fixture report\n' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ workflow: { workflow_id: 'workflow:observe', function_name: 'kernel', status: 'WAITING_APPROVAL', progress: { phase: 'WAITING_APPROVAL' } }, execution_attached: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const messages: string[] = [];
    const result = await executeWorkflowCommand(new ApiClient(`http://127.0.0.1:${address.port}`),
      ['watch', 'workflow:observe', '--interval', '0.1', '--output', root], { print: text => messages.push(text) });
    assert.equal(result.ok, true);
    assert.equal(reportReads, 2);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(row => row.startsWith('GET ')));
    assert.match(result.message, /等待人工审阅/);
    assert.equal(fs.readFileSync(path.join(root, 'report.md'), 'utf8'), '# fixture report\n');
    assert.ok(messages.some(text => text.includes('连接暂时中断')));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('corepilot-watch-recovery-')) throw new Error('unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
