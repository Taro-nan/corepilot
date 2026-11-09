import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { TaskHost } from '../src/core/task-host.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { createHttpServer } from '../src/http/server.js';
import { ApiClient } from '../src/client/api-client.js';
import { WorkbenchContext } from '../src/cli-interactive/context.js';
import { runCommand, type CommandIO } from '../src/cli-interactive/commands.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

/** Protocol fixture model + real Git/worktrees/child commands/SQLite/HTTP/reporting.
 * Sample values below are deterministic fixtures, never real hardware speedup claims.
 */
test('guided optimization reaches independent revalidation and automatically exports a report via the existing runtime', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-report-flow-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  function git(...args: string[]): string {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  git('init', '--initial-branch=main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'CorePilot Fixture');
  fs.writeFileSync(path.join(repo, 'kernel.c'), 'int kernel(void) { return 1 + 1; }\n');
  git('add', '.'); git('commit', '-m', 'fixture baseline');
  const originalCommit = git('rev-parse', 'HEAD');
  let turn = 0;
  const model = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const isProbe = body.tools?.some((tool: { function?: { name: string } }) => tool.function?.name === 'corepilot_probe');
      const name = isProbe ? 'corepilot_probe' : ++turn === 1 ? 'record_hypothesis' : turn >= 3 ? 'submit_candidate' : 'replace_text';
      const args = isProbe ? { ready: true } : name === 'record_hypothesis'
        ? { ...hypothesisProposal('Fold constant source expression'), parent_hypothesis_id: null }
        : name === 'submit_candidate' ? { summary: 'Completed the constant-folding Candidate.' } : { path: 'kernel.c', old_text: 'return 1 + 1', new_text: 'return 2' };
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: `fixture-${turn}`, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress === 'object');
  const command = (script: string) => ({ executable: process.execPath, args: ['-e', script], cwd: '.', environment: {}, timeout_ms: 10_000 });
  const correctness = command("const s=require('node:fs').readFileSync('kernel.c','utf8');if(!s.includes('return 2'))process.exit(1);console.log('source correctness fixture PASS')");
  const performance = command('console.log(JSON.stringify([{case_id:"p1", baseline_samples:[10,11,9],candidate_samples:[5,6,4]}]))');
  const testpack = {
    schema_version: 1, testpack_id: 'report-flow', function_name: 'kernel', function_family: 'fixture', operation: 'fold', data_type: 'int32',
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: { command: correctness, cases: [{ case_id: 'c1', parameters: { size: 1 }, threads: 1, critical: true, weight: 1 }], pass_required: 1 },
    performance: { command: performance, cases: [{ case_id: 'p1', parameters: { size: 1 }, threads: 1, critical: true, weight: 1 }],
      sampling: { warmup: 0, samples: 3, interleave_seed: 1, bootstrap_iterations: 100 },
      baselines: { current: { id: 'current', library: 'fixture', version: '1', sha256: '0'.repeat(64), path: '/fixture/current' }, comparison: { id: 'base', library: 'fixture', version: '1', sha256: '1'.repeat(64), path: '/fixture/baseline' } },
      thresholds: { weighted_geomean_min: 1.1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 }, key_cases: ['p1'] },
    revalidation: { formal: { required: true, timeout_ms: 10_000, command: correctness }, independent: { required: true, timeout_ms: 10_000, command: correctness } },
  };
  const testpackPath = path.join(root, 'testpack.json'); fs.writeFileSync(testpackPath, JSON.stringify(testpack));
  const configPath = path.join(repo, 'corepilot.yaml');
  fs.writeFileSync(configPath, JSON.stringify({ model: { endpoint: `http://127.0.0.1:${modelAddress.port}/v1`, model_id: 'fixture-model', api_key: 'fixture-key', timeout_ms: 10_000 },
    target: { ssh_alias: 'fixture', workspace_root: '/tmp/fixture' }, build: command("console.log('build fixture')"),
    validation: { testpack: testpackPath }, output_dir: path.join(root, 'runs') }));
  // Runtime must not require writing to the user's checkout.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'corepilot.yaml\n'); git('add', '.gitignore'); git('commit', '-m', 'ignore private config');
  const baselineCommit = git('rev-parse', 'HEAD');
  const store = new SqliteTaskStore(path.join(root, 'db.sqlite')); const host = new TaskHost(store); await host.start();
  const service = new OptimizationWorkflowService({ store, publicExecution: true, publicMaxRounds: 1, transportFactory: () => ({ transport_type: 'mock', runRemote: () => { throw new Error('local fixture must not SSH'); } }) });
  const server = createHttpServer(host, { host: '127.0.0.1', port: 0, workflowService: service });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const api = new ApiClient(`http://127.0.0.1:${address.port}`);
  const ctx = new WorkbenchContext({ configPath }); ctx.getApi = async () => api;
  const printed: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const io: CommandIO = { signal: controller.signal, print: text => printed.push(text), error: text => printed.push(text), prompt: async (question, options) => question.includes('允许修改') ? 'kernel.c' : options?.initialValue ?? null,
    select: async (_question, choices) => choices[0].value, confirm: async () => false };
  const previousCwd = process.cwd();
  try {
    process.chdir(repo);
    const checked = await runCommand(ctx, '/check --allow kernel.c', io);
    assert.equal(checked.ok, true, checked.message);
    assert.equal(turn, 0, 'check must not call a model or start optimization');
    const outcome = await runCommand(ctx, '/optimize', io);
    assert.equal(outcome.ok, true, JSON.stringify({ message: outcome.message, printed }));
    const id = ctx.currentWorkflowId(); assert.ok(id);
    let w = service.get(id)!;
    for (let i = 0; i < 100 && !w.report_files && !w.report_error; i++) { await delay(20); w = service.get(id)!; }
    assert.equal(w.status, 'WAITING_APPROVAL', JSON.stringify(w));
    assert.equal(w.report_error, null);
    assert.ok(w.report_files);
    const saved = JSON.parse(fs.readFileSync(w.report_files.json, 'utf8'));
    assert.equal(saved.candidates.length, 1);
    assert.equal(saved.experiments.filter((e: { experiment: { type: string } }) => e.experiment.type === 'REVALIDATION').length, 1);
    assert.equal(saved.experiments[0].experiment.evaluation.performance_workloads[0].speedup, 2);
    assert.ok(saved.experiments[0].measurements.some((m: { kind: string }) => m.kind === 'PERFORMANCE_SAMPLE'));
    assert.match(fs.readFileSync(w.report_files.markdown, 'utf8'), /原始样本/);
    assert.match(printed.join('\n'), /已提交优化工作流/);
    assert.equal(git('rev-parse', 'HEAD'), baselineCommit);
    assert.ok(originalCommit !== baselineCommit);
    assert.equal(store.getCandidateApproval(w.candidate_id!), null);
  } finally {
    process.chdir(previousCwd);
    clearTimeout(timer); await service.stop();
    await new Promise<void>(resolve => server.close(() => resolve())); await host.stop();
    await new Promise<void>(resolve => model.close(() => resolve()));
    // Worktrees use the existing runtime's temp root; remove only those belonging to this fixture.
    git('worktree', 'prune');
    const worktrees = git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice(9));
    for (const worktree of worktrees) if (path.resolve(worktree) !== path.resolve(repo)) git('worktree', 'remove', '--force', worktree);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
