import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../../../src/client/api-client.js';
import { startWebFixture } from '../../../tests/web-fixture.js';

test('bundled extension commands use the real API and keep credentials scoped to the server', async () => {
  const f = await startWebFixture({ execute: true });
  const config = { serverUrl: f.url }, secrets = new Map<string, string>(), state = new Map<string, unknown>();
  const commands = new Map<string, (...args: any[]) => Promise<unknown>>();
  const messages: string[] = [], opened: Array<{ language: string; content: string }> = [], external: string[] = [], saved: Uint8Array[] = [];
  let provider: { getChildren(): Promise<any[]> } | undefined;
  const disposable = () => ({ dispose() {} });
  class EventEmitter { event() { return disposable(); } fire() {} dispose() {} }
  class TreeItem { description?: string; tooltip?: string; command?: unknown; contextValue?: string; constructor(readonly label: string) {} }
  const vscode = {
    EventEmitter, TreeItem, TreeItemCollapsibleState: { None: 0 }, ConfigurationTarget: { Global: 1 },
    Uri: { parse: (value: string) => value },
    workspace: {
      getConfiguration: () => ({ get: () => config.serverUrl, update: async (_: string, value: string) => { config.serverUrl = value; } }),
      onDidChangeConfiguration: () => disposable(),
      openTextDocument: async (value: { language: string; content: string }) => value,
      fs: { writeFile: async (_: unknown, data: Uint8Array) => { saved.push(data); } },
    },
    window: {
      registerTreeDataProvider: (_: string, value: typeof provider) => { provider = value; return disposable(); },
      showInputBox: async () => f.token,
      showQuickPick: async (values: unknown[]) => values[0],
      showTextDocument: async (value: { language: string; content: string }) => { opened.push(value); },
      showSaveDialog: async () => 'memory:report.md',
      showInformationMessage: async (message: string) => { messages.push(message); },
      showWarningMessage: async (message: string) => { messages.push(message); return '发送取消请求'; },
      showErrorMessage: async (message: string) => { messages.push(message); },
    },
    commands: {
      registerCommand: (name: string, handler: (...args: any[]) => Promise<unknown>) => { commands.set(name, handler); return disposable(); },
      executeCommand: async (name: string, ...args: unknown[]) => commands.get(name)?.(...args),
    },
    env: { openExternal: async (uri: string) => { external.push(uri); return true; } },
  };
  const subscriptions: Array<{ dispose(): void }> = [];
  const context = { subscriptions,
    secrets: { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); } },
    workspaceState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } } };
  let secondServer: http.Server | undefined;
  try {
    const project = f.projects.add({ name: '扩展集成项目', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const vsix = path.resolve('extensions/vscode/corepilot-agent-vscode-0.4.0.vsix');
    const readMember = (name: string) => execFileSync('python', ['-c',
      'import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))', vsix, name], { encoding: 'utf8', windowsHide: true });
    const manifest = JSON.parse(readMember('extension/package.json'));
    assert.equal(manifest.contributes.commands.find((item: { command: string }) => item.command === 'corepilot.connect').title, '连接 CorePilot 服务');
    assert.equal(manifest.contributes.views.corepilot[0].name, '优化任务');
    assert.ok(manifest.contributes.commands.every((item: { title: string }) => /[\u4e00-\u9fff]/u.test(item.title) && !/\?{2}/.test(item.title)));
    const require = createRequire(import.meta.url), mod = { exports: {} as { activate(context: unknown): void } };
    new Function('require', 'module', 'exports', readMember('extension/dist/extension.js'))((name: string) => name === 'vscode' ? vscode : require(name), mod, mod.exports);
    mod.exports.activate(context);
    assert.ok(provider);
    assert.match((await provider.getChildren())[0].label, /选择 CorePilot 项目|需要连接令牌/);
    await commands.get('corepilot.setToken')!();
    assert.equal([...secrets.values()][0], f.token);
    await commands.get('corepilot.selectProject')!();
    assert.equal([...state.values()][0], project.project_id);
    assert.ok(!JSON.stringify([...state]).includes(f.token));
    assert.ok(!JSON.stringify(config).includes(f.token));

    const api = new ApiClient(f.url, { token: f.token });
    const input = { project_id: project.project_id, function_name: 'kernel', entry_file: 'kernel.c', source_branch: 'main',
      verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] }, enable_performance: false };
    const submitted = await api.submitOptimizationWorkflow(input, { requestId: 'ide-ui-fixture' }) as { workflow_id: string };
    let workflow = f.service.get(submitted.workflow_id)!;
    for (let i = 0; i < 500 && workflow.status !== 'CANDIDATE_READY'; i++) {
      if (workflow.status === 'FAILED') assert.fail(workflow.error ?? 'fixture workflow failed');
      await delay(20); workflow = f.service.get(submitted.workflow_id)!;
    }
    assert.equal(workflow.status, 'CANDIDATE_READY');
    const rows = await provider.getChildren();
    const row = rows.find(item => item.workflow?.workflow_id === submitted.workflow_id); assert.ok(row);
    assert.ok(rows.some(item => item.label.includes('可能包含其他项目')));
    assert.ok(row.tooltip.includes('\n') && !row.tooltip.includes('\\n'));
    const historical = new row.constructor({ ...row.workflow, status: 'DELIVERABLE', delivery: undefined }, f.url, '配置路径相同');
    assert.match(historical.description, /交付状态见报告/);
    assert.doesNotMatch(historical.description, /已交付/);
    await commands.get('corepilot.showTaskDetails')!(row);
    await commands.get('corepilot.openReport')!(row);
    await commands.get('corepilot.showCandidateDiff')!(row);
    await commands.get('corepilot.exportTask')!(row);
    assert.match(opened[0].content, /未执行构建、正确性或性能测试/);
    assert.ok(opened[0].content.includes('\n') && !opened[0].content.includes('\\n'));
    assert.match(opened[1].content, /NOT_EXECUTED \/ NOT_EXECUTED \/ NOT_EXECUTED/);
    assert.equal(opened[2].language, 'diff'); assert.match(opened[2].content, /\+int kernel/);
    assert.match(Buffer.from(saved[0]).toString(), /CorePilot/);
    await commands.get('corepilot.optimize')!();
    assert.equal(new URL(external[0]).hash, '#/tasks'); assert.ok(!external[0].includes(f.token));
    assert.ok(messages.some(message => message.includes('编辑器选区不会自动')));

    const realCancel = f.service.cancel.bind(f.service);
    f.service.cancel = id => { assert.equal(id, submitted.workflow_id); return { ok: true, status: 'CANCEL_REQUESTED', message: 'fixture' }; };
    try { await commands.get('corepilot.cancelTask')!(row); } finally { f.service.cancel = realCancel; }
    assert.ok(messages.some(message => message.includes('等待后台确认停止')));

    let receivedToken: string | undefined;
    secondServer = http.createServer((req, res) => {
      receivedToken = req.headers.authorization; res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/health') res.end(JSON.stringify({ service: 'corepilot', api_version: 1, status: 'ok', runner: 'workflow', capabilities: ['projects', 'workflows'] }));
      else { res.writeHead(401); res.end('{"error":{"code":"UNAUTHORIZED"}}'); }
    });
    await new Promise<void>(resolve => secondServer!.listen(0, '127.0.0.1', resolve));
    const address = secondServer.address(); assert.ok(address && typeof address === 'object');
    config.serverUrl = `http://127.0.0.1:${address.port}`;
    assert.match((await provider.getChildren())[0].label, /选择 CorePilot 项目/);
    await commands.get('corepilot.selectProject')!();
    assert.equal(receivedToken, undefined, 'a token saved for another server is not forwarded');
    await commands.get('corepilot.cancelTask')!(row);
    assert.ok(messages.some(message => message.includes('服务地址已改变')));
    config.serverUrl = 'http://127.0.0.1:1';
    assert.match((await provider.getChildren())[0].label, /连接失败/);
    assert.ok(!JSON.stringify(messages).includes(f.token));
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    if (secondServer) { secondServer.closeAllConnections(); await new Promise<void>(resolve => secondServer!.close(() => resolve())); }
    await f.close();
  }
});
