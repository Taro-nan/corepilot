import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { TaskHost } from '../src/core/task-host.js';
import { createHttpServer } from '../src/http/server.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { removeCandidateWorkspace } from '../src/workspace/candidate-workspace.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

/** Local protocol fixture; no paid model, Runner connection or performance sample. */
export async function sourceOptimizationFixture(options: { delayFirstMs?: number; holdFirst?: boolean; onlyArtifact?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-source-only-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Source fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int kernel(void) { return 1 + 1; }\n');
  fs.mkdirSync(path.join(repo, 'tests')); fs.writeFileSync(path.join(repo, 'tests', 'oracle.c'), 'int reference(void) { return 2; }\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'corepilot.json\n');
  git('add', '.'); git('commit', '-m', 'source baseline');
  const baseline = git('rev-parse', 'HEAD');
  const contexts: Array<Record<string, any>> = [];
  let workflowId = ''; let calls = 0; let held = false; let hold = options.holdFirst ?? false;
  let service: OptimizationWorkflowService;
  const model = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const probe = body.tools?.some((tool: any) => tool.function?.name === 'corepilot_probe');
      if (!probe) contexts.push(body);
      if (!probe && hold) { held = true; response.setHeader('content-type', 'text/event-stream'); response.write(': waiting\n\n'); return; }
      const step = probe ? -1 : calls++;
      if (!probe && step === 0 && options.delayFirstMs) await delay(options.delayFirstMs);
      const parent = step >= 4 ? service.get(workflowId)?.hypothesis_id ?? null : null;
      const actions: Array<[string, Record<string, unknown>]> = options.onlyArtifact ? [
        ['record_hypothesis', { ...hypothesisProposal('Inspect an artifact without changing source'), parent_hypothesis_id: null }],
        ['create_file', { path: 'temporary.o', content: 'not source' }],
        ['submit_candidate', { summary: 'No source was changed.' }],
        ['finish_optimization', { reason: 'No source change remains.' }],
      ] : [
        ['read_file', { path: 'kernel.c' }],
        ['record_hypothesis', { ...hypothesisProposal('Fold identical integer constant expression'), parent_hypothesis_id: null }],
        ['replace_text', { path: 'kernel.c', old_text: 'return 1 + 1', new_text: 'return 2' }],
        ['submit_candidate', { summary: 'Constant expression proposal; no test result claimed.' }],
        ['record_hypothesis', { ...hypothesisProposal('Second unverified source proposal'), parent_hypothesis_id: parent }],
        ['replace_text', { path: 'kernel.c', old_text: 'return 2', new_text: 'return (2)' }],
        ['submit_candidate', { summary: 'Second complete unverified proposal.' }],
      ];
      const [name, args] = probe ? ['corepilot_probe', { ready: true }] as const : actions[step] ?? ['finish_optimization', { reason: 'No further source change justified.' }];
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: `source-${step}`, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `source-call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress === 'object');
  const configPath = path.join(repo, 'corepilot.json');
  fs.writeFileSync(configPath, JSON.stringify({
    model: { model_id: 'fixture', endpoint: `http://127.0.0.1:${modelAddress.port}/v1`, api_key: 'source-fixture-secret', timeout_ms: 30_000 },
    target: { ssh_alias: 'unused-source-target', workspace_root: '/unused-source-target' },
    build: { executable: '', args: [] }, validation: { testpack: 'missing-testpack.yaml' },
    runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: '${SOURCE_FIXTURE_MISSING_RUNNER_TOKEN}' }, output_dir: path.join(root, 'runs'),
  }));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite'));
  const host = new TaskHost(store); await host.start();
  const makeService = () => new OptimizationWorkflowService({ store, publicExecution: true, publicEnablePerformance: true, worktreeRoot: path.join(root, 'worktrees'),
    transportFactory: () => { throw new Error('Source optimization must not construct a remote transport'); } });
  service = makeService();
  let server: http.Server; let api: ApiClient;
  async function listen() {
    server = createHttpServer(host, { host: '127.0.0.1', port: 0, workflowService: service });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object'); api = new ApiClient(`http://127.0.0.1:${address.port}`);
  }
  await listen();
  return { root, repo, configPath, baseline, git, contexts, store,
    get api() { return api; }, get service() { return service; }, get held() { return held; },
    async start(budget?: { time_limit_ms: number; max_candidates: number }, machineId?: string) {
      const response = await api.submitOptimizationWorkflow({ verification_mode: 'source_only', config_path: configPath,
        function_name: 'kernel', entry_file: 'kernel.c', repository_root: repo, source_branch: 'main',
        candidate_scope: { include: options.onlyArtifact ? ['kernel.c', 'temporary.o'] : ['kernel.c'], exclude: [] },
        ...(machineId ? { machine_id: machineId } : {}), ...(budget ? { budget } : {}) }) as { workflow_id: string };
      workflowId = response.workflow_id; return workflowId;
    },
    async wait(status: string) {
      for (let attempt = 0; attempt < 500; attempt++) {
        const record = service.get(workflowId)!;
        if (record.status === status && !service.activeWorkflowIds().length) return record;
        if (record.status === 'FAILED' && status !== 'FAILED') assert.fail(record.error ?? 'source workflow failed');
        await delay(20);
      }
      assert.fail(JSON.stringify(service.get(workflowId)));
    },
    async restart() {
      await service.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
      hold = false; service = makeService(); await listen();
    },
    async close() {
      await service.stop();
      const record = workflowId ? service.get(workflowId) : null;
      await new Promise<void>(resolve => server.close(() => resolve())); await host.stop();
      model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
      if (record?.workspace_editing && record.workspace_validation) removeCandidateWorkspace({ repository: repo, editing: record.workspace_editing, validation: record.workspace_validation });
      assert.ok(root.startsWith(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
