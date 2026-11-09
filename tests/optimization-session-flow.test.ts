import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { TaskHost } from '../src/core/task-host.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { createHttpServer } from '../src/http/server.js';
import { ApiClient } from '../src/client/api-client.js';
import { executeWorkflowCommand } from '../src/client/workflow-commands.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

/** Protocol model fixture; real Git, child commands, SQLite and public HTTP paths.
 * No fixture sample is a hardware performance claim. */
async function fixture(readTurns: number, maxCandidates?: number, holdFirst = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-session-flow-'));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'kernel.c'), '// durable-source-marker\nint kernel(void) { return 1 + 1; }\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'corepilot.json\n'); git('add', '.'); git('commit', '-m', 'baseline');
  const original = git('rev-parse', 'HEAD');
  let modelTurn = 0; let workflowId = ''; let held = false; let hold = holdFirst;
  const contexts: Record<string, any>[] = [];
  let service: OptimizationWorkflowService;
  const model = http.createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const probe = body.tools?.some((tool: any) => tool.function?.name === 'corepilot_probe');
      if (!probe) contexts.push(body);
      if (!probe && hold) { held = true; response.setHeader('content-type', 'text/event-stream'); response.write(': waiting\n\n'); return; }
      const step = probe ? -1 : modelTurn++;
      let name: string; let args: Record<string, unknown>;
      if (probe) { name = 'corepilot_probe'; args = { ready: true }; }
      else if (step < readTurns) { name = 'read_file'; args = { path: 'kernel.c', start_line: 1, line_count: 2 }; }
      else {
        const action = step - readTurns;
        if (action === 0) { name = 'record_hypothesis'; args = { ...hypothesisProposal('Fold the constant expression'), parent_hypothesis_id: null }; }
        else if (action === 1) { name = 'replace_text'; args = { path: 'kernel.c', old_text: 'return 1 + 1', new_text: 'return 3' }; }
        else if (action === 2 || action === 5) { name = 'submit_candidate'; args = { summary: 'Complete source change for system validation.' }; }
        else if (action === 3) { name = 'record_candidate_decision'; const record = service.get(workflowId)!; args = { candidate_id: record.candidate_id, experiment_id: record.experiment_id, action: 'REPAIR', reason: 'The actual correctness command rejected return 3.' }; }
        else if (action === 4) { name = 'replace_text'; args = { path: 'kernel.c', old_text: 'return 3', new_text: 'return 2' }; }
        else throw new Error(`Unexpected fixture turn ${step}`);
      }
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ id: `fixture-${step}`, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress === 'object');
  const command = (script: string) => ({ executable: process.execPath, args: ['-e', script], cwd: '.', environment: {}, timeout_ms: 10_000 });
  const correctness = command("if(!require('node:fs').readFileSync('kernel.c','utf8').includes('return 2')){console.error('edge-7: expected 2');process.exit(1)}");
  const testpack = { schema_version: 1, testpack_id: 'session-fixture', function_name: 'kernel', function_family: 'fixture', operation: 'fold', data_type: 'int32',
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: { command: correctness, cases: [{ case_id: 'edge-7', m: 1, n: 1, threads: 1, seed: 7, critical: true, weight: 1 }], pass_required: 1 },
    performance: { command: command('process.exit(0)'), cases: [{ case_id: 'p1', m: 1, n: 1, threads: 1, seed: 1, critical: true, weight: 1 }],
      sampling: { warmup: 0, samples: 1, interleave_seed: 1, bootstrap_iterations: 1 },
      baselines: { current: { id: 'current', library: 'fixture', version: '1', sha256: '0'.repeat(64), path: '/fixture/current' }, comparison: { id: 'base', library: 'fixture', version: '1', sha256: '1'.repeat(64), path: '/fixture/base' } },
      thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 }, key_cases: ['p1'] },
    revalidation: { formal: { required: true, timeout_ms: 10_000, command: correctness }, independent: { required: true, timeout_ms: 10_000, command: correctness } } };
  const testpackPath = path.join(root, 'testpack.json'); fs.writeFileSync(testpackPath, JSON.stringify(testpack));
  const configPath = path.join(repo, 'corepilot.json');
  fs.writeFileSync(configPath, JSON.stringify({ model: { model_id: 'fixture', endpoint: `http://127.0.0.1:${modelAddress.port}/v1`, api_key: 'fixture-session-private-key', timeout_ms: 30_000 },
    target: { ssh_alias: 'fixture', workspace_root: '/tmp/fixture' }, build: command('process.exit(0)'), validation: { testpack: testpackPath }, output_dir: path.join(root, 'runs') }));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite')); const host = new TaskHost(store); await host.start();
  const makeService = () => new OptimizationWorkflowService({ store, publicExecution: true, worktreeRoot: path.join(root, 'worktrees'), ...(maxCandidates ? { publicMaxRounds: maxCandidates } : {}),
    transportFactory: () => ({ transport_type: 'mock', runRemote: () => { throw new Error('No SSH in local integration fixture'); } }) });
  service = makeService();
  let server: http.Server; let api: ApiClient; let url: string;
  async function listen() {
    server = createHttpServer(host, { host: '127.0.0.1', port: 0, workflowService: service });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object'); url = `http://127.0.0.1:${address.port}`; api = new ApiClient(url);
  }
  await listen();
  return { root, configPath, contexts, git, original, store, get api() { return api; }, get url() { return url; }, get service() { return service; },
    get held() { return held; }, release() { hold = false; },
    async start() { const result = await api.submitOptimizationWorkflow({ config_path: configPath, function_name: 'kernel', entry_file: 'kernel.c', repository_root: repo, candidate_scope: { include: ['kernel.c'], exclude: [] } }) as { workflow_id: string }; workflowId = result.workflow_id; return workflowId; },
    async wait(status: string) {
      for (let count = 0; count < 800; count++) { const record = service.get(workflowId)!; if (record.status === status && !service.activeWorkflowIds().length) return record; if (record.status === 'FAILED') assert.fail(record.error ?? 'workflow failed'); await delay(25); }
      assert.fail(JSON.stringify(service.get(workflowId)));
    },
    async restart() { await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); service = makeService(); await listen(); },
    async close() {
      await service.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await host.stop();
      model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
      const workspaceRoot = path.join(root, 'worktrees');
      if (fs.existsSync(workspaceRoot)) for (const run of fs.readdirSync(workspaceRoot)) for (const tree of ['validation', 'editing']) {
        const target = path.join(workspaceRoot, run, tree); if (fs.existsSync(target)) git('worktree', 'remove', '--force', target);
      }
      fs.rmSync(root, { recursive: true, force: true });
    } };
}

test('public optimization exceeds 32 model turns and repairs a failed candidate in the same native session', async () => {
  const f = await fixture(33);
  try {
    const id = await f.start(); const record = await f.wait('WAITING_APPROVAL');
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'WAITING_APPROVAL');
    assert.ok(record.agent_session!.turns > 32);
    const finalContext = JSON.stringify(f.contexts.at(-1));
    assert.match(finalContext, /durable-source-marker/);
    assert.match(finalContext, /edge-7/);
    const report = await f.api.getOptimizationReport(id);
    assert.equal(report.report.candidates.length, 2);
    assert.equal(report.report.experiments.length, 3);
    assert.equal(report.report.experiments[0].experiment.evaluation!.correctness, 'FAILED');
    assert.equal(f.git('rev-parse', 'HEAD'), f.original);
    const events = await f.api.getOptimizationSessionEvents(id, 0, 200);
    assert.ok(events.events.some(event => event.kind === 'tool_call' && event.tool_name === 'record_candidate_decision'));
    const cli = await executeWorkflowCommand(f.api, ['events', id, '--json', '--limit', '200']);
    assert.equal(cli.ok, true); assert.match(cli.message, /edge-7/);
    for (const filename of fs.readdirSync(record.agent_session!.directory)) {
      assert.equal(fs.readFileSync(path.join(record.agent_session!.directory, filename)).includes(Buffer.from('fixture-session-private-key')), false);
    }
  } finally { await f.close(); }
});

test('candidate-budget exhaustion resumes the same workflow after service restart and rejects changed evaluation contracts', async () => {
  const f = await fixture(1, 1);
  try {
    const id = await f.start(); const first = await f.wait('BUDGET_EXHAUSTED');
    assert.equal(f.store.getOptimizationTask(first.optimization_task_id!)?.status, 'BUDGET_EXHAUSTED');
    assert.equal(first.error, null);
    const sourceBefore = fs.readFileSync(path.join(first.workspace_editing!, 'kernel.c'), 'utf8'); assert.match(sourceBefore, /return 3/);
    await f.restart();
    const originalConfig = fs.readFileSync(f.configPath, 'utf8');
    const changed = JSON.parse(originalConfig); changed.build.args = ['-e', 'process.exit(9)']; fs.writeFileSync(f.configPath, JSON.stringify(changed));
    await assert.rejects(f.api.resumeOptimizationWorkflow(id), /已改变/);
    fs.writeFileSync(f.configPath, originalConfig);
    await Promise.all([f.api.resumeOptimizationWorkflow(id, { message: 'Repair the actual correctness failure.', budget: { max_candidates: 1 } }), f.api.resumeOptimizationWorkflow(id)]);
    const record = await f.wait('WAITING_APPROVAL');
    assert.equal(record.workflow_id, id); assert.equal(record.continuation_count, 1);
    assert.equal(record.workspace_editing, first.workspace_editing);
    assert.ok(record.agent_session!.turns > first.agent_session!.turns);
    assert.equal((await f.api.getOptimizationReport(id)).report.candidates.length, 2);
    assert.match(JSON.stringify(f.contexts.at(-1)), /durable-source-marker/);
  } finally { await f.close(); }
});

test('verified checkpoint recovery reuses the persisted Candidate after the session write is interrupted', async () => {
  const f = await fixture(0);
  const attach = f.store.attachOptimizationCandidate.bind(f.store);
  let interrupted = false;
  try {
    f.store.attachOptimizationCandidate = (_workflowId, candidate) => {
      // Reproduce the pre-transaction crash window left by older versions.
      f.store.createCandidate(candidate);
      interrupted = true;
      throw new Error('injected interruption after Candidate insert');
    };
    const id = await f.start();
    let interruptedRecord = f.service.get(id)!;
    for (let i = 0; i < 800; i++) {
      interruptedRecord = f.service.get(id)!;
      if (interruptedRecord.status === 'FAILED' && !f.service.activeWorkflowIds().length) break;
      await delay(25);
    }
    assert.equal(interrupted, true);
    assert.equal(interruptedRecord.status, 'FAILED');
    const before = f.store.listCandidates(interruptedRecord.optimization_task_id!);
    assert.equal(before.length, 1);
    assert.equal(f.store.listExperiments(interruptedRecord.optimization_task_id!).length, 0);
    f.store.attachOptimizationCandidate = attach;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const finished = await f.wait('WAITING_APPROVAL');
    const after = f.store.listCandidates(finished.optimization_task_id!);
    assert.equal(after.length, 2, 'the interrupted first checkpoint must not create a duplicate Candidate');
    assert.deepEqual(after[0], before[0]);
    assert.equal(after[1].parent_candidate_id, before[0].candidate_id);
    assert.equal(f.store.listExperiments(finished.optimization_task_id!).length, 3);
  } finally { f.store.attachOptimizationCandidate = attach; await f.close(); }
});

test('a lost acknowledgement after Candidate and Workflow commit resumes the same identity', async () => {
  const f = await fixture(0);
  const attach = f.store.attachOptimizationCandidate.bind(f.store);
  let interrupted = false;
  try {
    f.store.attachOptimizationCandidate = (workflowId, candidate) => {
      const saved = attach(workflowId, candidate);
      if (!interrupted) { interrupted = true; throw new Error('injected lost checkpoint acknowledgement'); }
      return saved;
    };
    const id = await f.start();
    let before = f.service.get(id)!;
    for (let i = 0; i < 800; i++) {
      before = f.service.get(id)!;
      if (before.status === 'FAILED' && !f.service.activeWorkflowIds().length) break;
      await delay(25);
    }
    assert.equal(interrupted, true);
    assert.equal(before.status, 'FAILED');
    const candidates = f.store.listCandidates(before.optimization_task_id!);
    assert.equal(candidates.length, 1);
    assert.equal(before.candidate_id, candidates[0].candidate_id);
    assert.equal(f.store.listExperiments(before.optimization_task_id!).length, 0);
    f.store.attachOptimizationCandidate = attach;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const finished = await f.wait('WAITING_APPROVAL');
    const after = f.store.listCandidates(finished.optimization_task_id!);
    assert.equal(after.length, 2);
    assert.deepEqual(after[0], candidates[0]);
    assert.equal(after[1].parent_candidate_id, candidates[0].candidate_id);
    assert.equal(f.store.listExperiments(finished.optimization_task_id!).length, 3);
  } finally { f.store.attachOptimizationCandidate = attach; await f.close(); }
});

test('a legacy unlinked active formal experiment blocks recovery without creating another', async () => {
  const f = await fixture(0);
  const attach = f.store.attachOptimizationExperiment.bind(f.store);
  let interrupted = false;
  try {
    f.store.attachOptimizationExperiment = (_workflowId, experiment) => {
      const { workflow_experiment_intent: _intent, ...declared_context } = experiment.declared_context;
      f.store.createExperiment({ ...experiment, declared_context });
      interrupted = true;
      throw new Error('injected interruption after legacy experiment insert');
    };
    const id = await f.start();
    let first = f.service.get(id)!;
    for (let i = 0; i < 800; i++) {
      first = f.service.get(id)!;
      if (first.status === 'FAILED' && !f.service.activeWorkflowIds().length) break;
      await delay(25);
    }
    assert.equal(interrupted, true);
    assert.equal(first.status, 'FAILED');
    const before = f.store.listExperiments(first.optimization_task_id!);
    assert.equal(before.length, 1);
    assert.equal(before[0].status, 'RUNNING');
    f.store.attachOptimizationExperiment = attach;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    let after = f.service.get(id)!;
    for (let i = 0; i < 800; i++) {
      after = f.service.get(id)!;
      if (!f.service.activeWorkflowIds().length) break;
      await delay(25);
    }
    assert.equal(after.status, 'FAILED', 'an unlinked active experiment must block automatic creation');
    assert.match(after.error ?? '', /原实验|未关联|核对/);
    assert.deepEqual(f.store.listExperiments(first.optimization_task_id!), before);
  } finally { f.store.attachOptimizationExperiment = attach; await f.close(); }
});

for (const type of ['FORMAL_EVALUATION', 'REVALIDATION'] as const) {
  test(`lost ${type} creation acknowledgement restores the same experiment intent through HTTP`, async () => {
    const f = await fixture(0);
    const attach = f.store.attachOptimizationExperiment.bind(f.store);
    let interrupted = false;
    try {
      f.store.attachOptimizationExperiment = (workflowId, experiment, intent) => {
        const saved = attach(workflowId, experiment, intent);
        if (!interrupted && experiment.type === type) {
          interrupted = true;
          throw new Error('injected lost experiment creation acknowledgement');
        }
        return saved;
      };
      const id = await f.start();
      let first = f.service.get(id)!;
      for (let i = 0; i < 800; i++) {
        first = f.service.get(id)!;
        if (first.status === 'FAILED' && !f.service.activeWorkflowIds().length) break;
        await delay(25);
      }
      assert.equal(interrupted, true);
      assert.equal(first.status, 'FAILED');
      const before = f.store.listExperiments(first.optimization_task_id!);
      const original = before.at(-1)!;
      assert.equal(original.type, type);
      assert.equal(original.status, 'RUNNING');
      assert.equal(first.experiment_creation_intent?.experiment_id, original.experiment_id);
      assert.equal(type === 'FORMAL_EVALUATION' ? first.experiment_id : first.revalidation_experiment_id, original.experiment_id);
      assert.equal(f.store.listCommandExecutions(original.experiment_id).length, 0);
      f.store.attachOptimizationExperiment = attach;
      await f.restart();
      await f.api.resumeOptimizationWorkflow(id);
      const finished = await f.wait('WAITING_APPROVAL');
      const after = f.store.listExperiments(finished.optimization_task_id!);
      assert.equal(after.length, 3, 'each actual formal or revalidation run is represented once');
      assert.equal(after.filter(item => item.experiment_id === original.experiment_id).length, 1);
      assert.equal(after.find(item => item.experiment_id === original.experiment_id)?.status, 'SUCCEEDED');
      assert.equal(finished.revalidation_experiment_id, after.at(-1)!.experiment_id);
      assert.notEqual(after[1].experiment_id, after[2].experiment_id);
    } finally { f.store.attachOptimizationExperiment = attach; await f.close(); }
  });
}

test('a saved active local experiment is reported interrupted rather than executed again', async () => {
  const f = await fixture(0);
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  let interrupted = false;
  try {
    f.store.saveOptimizationWorkflowJson = (id, json) => {
      if (!interrupted && JSON.parse(json).progress?.phase === 'CHECKPOINT_READY') {
        interrupted = true;
        throw new Error('injected failure before local validation execution');
      }
      save(id, json);
    };
    const id = await f.start();
    let first = f.service.get(id)!;
    for (let i = 0; i < 800; i++) {
      first = f.service.get(id)!;
      if (first.status === 'FAILED' && !f.service.activeWorkflowIds().length) break;
      await delay(25);
    }
    assert.equal(interrupted, true);
    const before = f.store.listExperiments(first.optimization_task_id!);
    assert.equal(before.length, 1);
    assert.equal(before[0].status, 'RUNNING');
    f.store.saveOptimizationWorkflowJson = save;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const after = await f.wait('INTERRUPTED');
    assert.match(after.error ?? '', /本地进程状态未确认/);
    assert.deepEqual(f.store.listExperiments(first.optimization_task_id!), before);
    assert.equal(after.experiment_id, before[0].experiment_id);
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});

test('public recovery preserves a committed local result when its acknowledgement is lost', async () => {
  const f = await fixture(0);
  const commit = f.store.commitExperimentResult.bind(f.store);
  let interrupted = false;
  try {
    f.store.commitExperimentResult = (expected, next, outcome, localFacts) => {
      const saved = commit(expected, next, outcome, localFacts);
      if (!interrupted && next.type === 'FORMAL_EVALUATION' && outcome) {
        interrupted = true;
        throw new Error('injected lost result acknowledgement');
      }
      return saved;
    };
    const id = await f.start();
    const first = await f.wait('INTERRUPTED');
    assert.match(first.error ?? '', /实验结果处理或保存失败/);
    assert.equal(interrupted, true);
    const experiments = f.store.listExperiments(first.optimization_task_id!);
    const outcomes = f.store.listHypothesisOutcomes(first.optimization_task_id!);
    assert.equal(experiments.length, 1);
    assert.equal(experiments[0].status, 'SUCCEEDED');
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].experiment_id, experiments[0].experiment_id);
    const commands = f.store.listCommandExecutions(experiments[0].experiment_id);
    f.store.commitExperimentResult = commit;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const recovered = await f.wait('INTERRUPTED');
    assert.match(recovered.error ?? '', /本地进程状态未确认/);
    assert.deepEqual(f.store.listExperiments(first.optimization_task_id!), experiments);
    assert.deepEqual(f.store.listHypothesisOutcomes(first.optimization_task_id!), outcomes);
    assert.deepEqual(f.store.listCommandExecutions(experiments[0].experiment_id), commands);
  } finally { f.store.commitExperimentResult = commit; await f.close(); }
});

test('public local result storage failure preserves the original experiment without fabricating failure or rerunning', async () => {
  const f = await fixture(0);
  const append = f.store.appendCommandExecution.bind(f.store);
  let interrupted = false;
  try {
    f.store.appendCommandExecution = command => {
      append(command);
      if (!interrupted) { interrupted = true; throw new Error('injected result storage failure'); }
    };
    const id = await f.start();
    const first = await f.wait('INTERRUPTED');
    assert.equal(interrupted, true);
    assert.match(first.error ?? '', /实验结果处理或保存失败/);
    const experiments = f.store.listExperiments(first.optimization_task_id!);
    assert.equal(experiments.length, 1);
    assert.equal(experiments[0].status, 'RUNNING');
    assert.equal(experiments[0].failure_category, null);
    assert.deepEqual(f.store.listCommandExecutions(experiments[0].experiment_id), []);
    assert.deepEqual(f.store.listMeasurements(experiments[0].experiment_id), []);
    assert.deepEqual(f.store.listHypothesisOutcomes(first.optimization_task_id!), []);
    f.store.appendCommandExecution = append;
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const recovered = await f.wait('INTERRUPTED');
    assert.match(recovered.error ?? '', /本地进程状态未确认/);
    assert.deepEqual(f.store.listExperiments(first.optimization_task_id!), experiments);
    assert.deepEqual(f.store.listCommandExecutions(experiments[0].experiment_id), []);
    assert.deepEqual(f.store.listHypothesisOutcomes(first.optimization_task_id!), []);
  } finally { f.store.appendCommandExecution = append; await f.close(); }
});

test('stopping Control preserves an in-progress Agent session and allows continuation after restart', async () => {
  const f = await fixture(0, undefined, true);
  try {
    const id = await f.start();
    for (let i = 0; i < 200 && !f.held; i++) await delay(20);
    assert.equal(f.held, true);
    await f.restart();
    assert.equal(f.service.get(id)!.status, 'INTERRUPTED');
    assert.equal(f.store.getOptimizationTask(f.service.get(id)!.optimization_task_id!)?.status, 'INTERRUPTED');
    f.release(); await f.api.resumeOptimizationWorkflow(id);
    const record = await f.wait('WAITING_APPROVAL');
    assert.equal(record.continuation_count, 1);
  } finally { await f.close(); }
});

test('cancelling a verified task confirms the same terminal state in the workflow and Task', async () => {
  const f = await fixture(0, undefined, true);
  try {
    const id = await f.start();
    for (let i = 0; i < 200 && !f.held; i++) await delay(20);
    assert.equal(f.held, true);
    const response = await fetch(`${f.url}/v1/workflows/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { status: string }).status, 'CANCEL_REQUESTED');
    const record = await f.wait('CANCELLED');
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'CANCELLED');
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 0);
  } finally { await f.close(); }
});
