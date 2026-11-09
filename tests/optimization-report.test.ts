import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';
import { initialOptimizationWorkflowRecord, SqliteOptimizationWorkflowStore } from '../src/workflow/optimization-workflow.js';
import { buildOptimizationReport, renderOptimizationReport } from '../src/report/optimization-report.js';
import { TaskHost } from '../src/core/task-host.js';
import { createHttpServer } from '../src/http/server.js';
import { ApiClient, ApiClientError } from '../src/client/api-client.js';
import { executeWorkflowCommand } from '../src/client/workflow-commands.js';
import { runCommand } from '../src/cli-interactive/commands.js';
import { WorkbenchContext } from '../src/cli-interactive/context.js';
import { parseWorkbenchInput } from '../src/cli-interactive/command-input.js';
import { parseOptimizeCliInput } from '../src/config/optimize-cli-input.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { checkOptimization } from '../src/workflow/check-optimization.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

function fixture(store: SqliteTaskStore) {
  const runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({ workflowId: 'workflow:report', target: { kind: 'kernel', name: 'example', scope: {} },
    sourceBaseline: { id: 'git:base' }, performanceBaseline: { id: 'binary:base' }, evaluator: { id: 'evaluator:report' }, declaredContext: { cpu_set: '0' } });
  const hypothesis = runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null, proposal: hypothesisProposal(), agentIdentity: { model: 'fixture-model' } });
  store.createCandidate({ schema_version: 1, candidate_id: 'candidate:report', task_id: task.task_id, hypothesis_id: hypothesis.hypothesis_id,
    parent_candidate_id: null, sequence: 1, status: 'FROZEN', source: { repository: '/source', commit: '123', tree: '456', archive_sha256: '789', changed_files: [{ path: 'kernel.c', before_sha256: 'before', after_sha256: 'after' }] },
    hypothesis: hypothesis.description, development_findings: null, agent_identity: { model: 'fixture-model' }, created_at: new Date().toISOString() });
  const e = runtime.startExperiment({ taskId: task.task_id, candidateId: 'candidate:report', type: 'FORMAL_EVALUATION' });
  store.saveExperiment({ ...e, status: 'SUCCEEDED', validity: 'INVALID', failure_category: 'INVALID_EXPERIMENT',
    evaluation: { build: 'PASSED', correctness: 'INCOMPLETE', performance: 'NOT_EXECUTED', correctness_coverage: { planned: 2, executed: 1, passed: 1, failed: 0, complete: false } } });
  store.appendCommandExecution({ schema_version: 1, command_execution_id: 'command:report', experiment_id: e.experiment_id, evaluator: null,
    step: 'CORRECTNESS', sequence: 1, command: 'node', args: ['test.js'], cwd: '/source', start_time: e.created_at, end_time: e.created_at,
    duration_ms: 10, exit_code: 0, stdout: '```\nBearer do-not-export\napi_key=hidden-secret', stderr: 'missing case', timeout_ms: 1000, timed_out: false, cancelled: false });
  store.appendMeasurement({ schema_version: 1, measurement_id: 'measurement:report', experiment_id: e.experiment_id, evaluator: null,
    kind: 'PERFORMANCE_SAMPLE', role: 'BASELINE', subject_id: 'tiny', sample_index: 0, value: 12, unit: 'ns', validity: 'INVALID', domain_payload: {}, recorded_at: e.created_at });
  const w = initialOptimizationWorkflowRecord('workflow:report', { functionName: 'example', entryFile: null, repositoryRoot: '/source', configPath: '/config', enablePerformance: true });
  w.optimization_task_id = task.task_id;
  w.status = 'FAILED';
  w.error = 'incomplete evidence';
  new SqliteOptimizationWorkflowStore(store).save(w);
  return w;
}

test('reports persisted facts after restart, retains invalid zero-exit evidence and redacts diagnostic credentials', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-report-'));
  let store = new SqliteTaskStore(path.join(root, 'db.sqlite')); store.init();
  const w = fixture(store); store.close();
  store = new SqliteTaskStore(path.join(root, 'db.sqlite')); store.init();
  try {
    const report = buildOptimizationReport(w, store);
    const markdown = renderOptimizationReport(report);
    assert.equal(report.experiments[0].experiment.status, 'SUCCEEDED');
    assert.equal(report.experiments[0].experiment.validity, 'INVALID');
    assert.equal(report.experiments[0].experiment.evaluation?.correctness, 'INCOMPLETE');
    assert.equal(report.experiments[0].measurements[0].unit, 'ns');
    assert.equal(report.candidates[0].approval, null);
    assert.match(markdown, /INVALID/); assert.match(markdown, /INCOMPLETE/);
    assert.match(markdown, /missing case/); assert.match(markdown, /before/);
    assert.match(markdown, /无领域批准记录/); assert.match(markdown, /置信区间/);
    assert.doesNotMatch(JSON.stringify(report), /do-not-export|hidden-secret/);
    assert.match(store.listCommandExecutions(report.experiments[0].experiment.experiment_id)[0].stdout, /do-not-export/);
    const old = buildOptimizationReport({ ...w, optimization_task_id: undefined }, store);
    assert.equal(old.task, null); assert.match(renderOptimizationReport(old), /尚无实验记录/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('real HTTP API, CLI and workbench can list workflows and export the same report without approving it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-report-api-'));
  const store = new SqliteTaskStore(path.join(root, 'db.sqlite')); store.init();
  const w = fixture(store);
  const host = new TaskHost(store);
  await host.start();
  const service = new OptimizationWorkflowService({ store, transportFactory: () => { throw new Error('reporting must not execute'); } });
  const server = createHttpServer(host, { host: '127.0.0.1', port: 0, workflowService: service });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  const api = new ApiClient(url);
  try {
    assert.equal((await api.listOptimizationWorkflows()).workflows[0].workflow_id, w.workflow_id);
    await assert.rejects(api.getOptimizationReport('absent'), (error: unknown) => error instanceof ApiClientError && error.status === 404);
    assert.equal((await fetch(`${url}/v1/workflows?limit=1000`)).status, 400);
    const output = path.join(root, 'CLI 报告');
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/entry.ts', 'workflow', 'report', w.workflow_id, '--output', output, '--json'], {
      cwd: process.cwd(), windowsHide: true, env: { ...process.env, COREPILOT_SERVER_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(exit, 0, stderr);
    assert.equal(JSON.parse(stdout).report.workflow.workflow_id, w.workflow_id);
    const exported = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    assert.equal(exported.experiments[0].experiment.validity, 'INVALID');
    const ctx = new WorkbenchContext({ configPath: path.join(root, 'corepilot.yaml') });
    ctx.getApi = async () => api;
    const workbenchOutput = path.join(root, 'TUI 报告');
    const result = await runCommand(ctx, `/workflow report ${w.workflow_id} --output "${workbenchOutput.replace(/\\/g, '/')}"`, {
      print: () => {}, error: () => {}, prompt: async () => null, select: async () => null, confirm: async () => false,
    });
    // Reporting should work even if the original configuration file was removed.
    assert.equal(result.ok, true, result.message);
    assert.equal(JSON.parse(fs.readFileSync(path.join(workbenchOutput, 'report.json'), 'utf8')).workflow.status, 'FAILED');
    assert.equal(service.get(w.workflow_id)?.status, 'FAILED');
    assert.equal(store.getCandidateApproval('candidate:report'), null);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); await host.stop(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch stops at waiting approval, exports facts, and observation cancellation never cancels the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-report-watch-'));
  const store = new SqliteTaskStore(path.join(root, 'db.sqlite')); store.init();
  const w = fixture(store);
  const response = { report: buildOptimizationReport(w, store), markdown: 'fixture' };
  let polls = 0; let cancelled = false;
  const api = {
    getOptimizationWorkflow: async () => ({ workflow: { ...w, status: ++polls === 1 ? 'GENERATING' : 'WAITING_APPROVAL' } }),
    getOptimizationReport: async () => response,
    cancelOptimizationWorkflow: async () => { cancelled = true; },
  } as unknown as ApiClient;
  try {
    const result = await executeWorkflowCommand(api, ['watch', w.workflow_id, '--interval', '0.1', '--output', path.join(root, 'report')]);
    assert.equal(result.ok, true); assert.equal(polls, 2); assert.equal(cancelled, false);
    assert.ok(fs.existsSync(path.join(root, 'report', 'report.md')));
    const controller = new AbortController(); controller.abort();
    await executeWorkflowCommand(api, ['watch', w.workflow_id], { signal: controller.signal });
    assert.equal(cancelled, false); assert.equal(polls, 2);
    await assert.rejects(executeWorkflowCommand(api, ['watch', w.workflow_id, '--interval', 'NaN']));
    await assert.rejects(executeWorkflowCommand(api, ['cancel', w.workflow_id, '--output', root]));
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('workbench quoting and optimize watch options preserve paths and explicit performance choices', () => {
  assert.deepEqual(parseWorkbenchInput('/workflow report w --output "D:\\Reports\\我的 报告"'), ['/workflow', 'report', 'w', '--output', 'D:\\Reports\\我的 报告']);
  assert.throws(() => parseWorkbenchInput('/workflow report "oops'));
  const input = parseOptimizeCliInput(['--config', 'corepilot.yaml', '--function', 'test', '--performance', '--watch', '--output', './my report']);
  assert.equal(input.watch, true); assert.equal(input.enablePerformance, true);
  assert.equal(input.reportOutput, path.resolve('my report'));
  assert.throws(() => parseOptimizeCliInput(['--config', 'x', '--function', 'x', '--output', 'x']));
});

test('validation wizard saves Package-owned config without conflicting legacy fields and cancellation preserves it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-validation-wizard-'));
  const configPath = path.join(root, 'corepilot.yaml');
  const baseline = path.join(root, 'baseline.so'); fs.writeFileSync(baseline, 'not-the-frozen-binary');
  fs.writeFileSync(configPath, JSON.stringify({ model: { endpoint: 'https://example.invalid/v1', model_id: 'test', api_key: 'fixture-key', timeout_ms: 1000 },
    target: { ssh_alias: 'fixture', workspace_root: '/tmp/fixture' },
    build: { executable: 'unused', args: [] }, validation: { testpack: 'missing-placeholder.yaml' }, output_dir: '.corepilot/runs' }));
  const ctx = new WorkbenchContext({ configPath });
  const io = {
    print: () => {}, error: () => {}, confirm: async () => false,
    select: async (question: string, choices: Array<{ value: unknown }>) => question === '选择验证来源' ? 'package'
      : question.startsWith('选择 Package') ? choices.find(c => (c.value as { package_id?: string }).package_id === 'ippi-ft')!.value : choices[0].value,
    prompt: async (question: string) => question.startsWith('冻结 baseline') ? baseline
      : question.startsWith('Runner HTTP') ? 'http://127.0.0.1:4327' : 'REPORT_FIXTURE_RUNNER_TOKEN',
  } as import('../src/cli-interactive/commands.js').CommandIO;
  try {
    const outcome = await runCommand(ctx, '/validation', io);
    assert.equal(outcome.ok, true, outcome.message);
    const written = fs.readFileSync(configPath, 'utf8');
    assert.doesNotMatch(written, /^build:|^\s+testpack:/m);
    const parsed = loadOptimizationConfig(configPath);
    assert.equal(parsed.config.validation.library_package?.package_id, 'ippi-ft');
    assert.equal(parsed.config.runner?.mode, 'rpc');
    if (parsed.config.runner?.mode === 'rpc') assert.equal(parsed.config.runner.token, '${REPORT_FIXTURE_RUNNER_TOKEN}');
    const cancelled = await runCommand(ctx, '/validation', { ...io, select: async () => null });
    assert.equal(cancelled.ok, true); assert.equal(fs.readFileSync(configPath, 'utf8'), written);
    // Resolve a test token without making any network calls: the incorrect
    // binary must be rejected before Runner health is requested.
    process.env.REPORT_FIXTURE_RUNNER_TOKEN = 'fixture-token';
    await assert.rejects(checkOptimization(configPath), /baseline 文件 SHA-256/);
  } finally { delete process.env.REPORT_FIXTURE_RUNNER_TOKEN; fs.rmSync(root, { recursive: true, force: true }); }
});
