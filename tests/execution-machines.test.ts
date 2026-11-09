import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { ExecutionMachineService } from '../src/application/execution-machine-service.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { ExecutionMachineDetails, ExecutionMachineSummary } from '../src/contracts/execution-machine.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { WorkbenchContext } from '../src/cli-interactive/context.js';
import { runCommand, type CommandIO } from '../src/cli-interactive/commands.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

test('task preflight probes the selected machine override without saving it, calling a model or creating experiments', async () => {
  const f = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'preflight-fixture-token', dbPath: path.join(f.root, 'preflight-runner.sqlite'), workspaceRoot: path.join(f.root, 'preflight-runner'), resourceEnforcement: 'REQUIRED' });
  try {
    const project = f.projects.add({ name: 'Selected machine check', repository_root: f.repo, config_path: f.configPath });
    const evaluator = createFormalEvaluatorFixture(path.join(f.root, 'preflight-evaluator'));
    const testpackPath = loadOptimizationConfig(project.config_path).config.validation.testpack;
    const pack = JSON.parse(fs.readFileSync(testpackPath, 'utf8'));
    pack.function_name = evaluator.manifest.domain.api;
    pack.evaluator = { id: evaluator.manifest.evaluator_id, version: evaluator.manifest.version, owner: evaluator.manifest.owner, root: evaluator.root, sha256: evaluator.digest };
    for (const command of [pack.correctness.command, pack.performance.command, pack.revalidation.formal.command, pack.revalidation.independent.command]) command.cwd = evaluator.root;
    fs.writeFileSync(testpackPath, JSON.stringify(pack));
    const defaultMachine = f.projects.machines.save({ name: 'Default offline fixture', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: 'unused-default-token', request_timeout_ms: 1000 }, target: { ssh_alias: 'fixture-default', workspace_root: '/fixture/default' } });
    const selected = f.projects.machines.save({ name: 'Selected preflight fixture', runner: { mode: 'rpc', endpoint: runner.url, token: 'preflight-fixture-token' }, target: { ssh_alias: 'fixture-selected', workspace_root: '/fixture/selected' } });
    f.projects.bindMachine(project.project_id, defaultMachine.machine_id);
    const original = fs.readFileSync(project.config_path, 'utf8');
    const api = new ApiClient(f.url, { token: f.token });
    const checked = await api.projectAction(project.project_id, 'check', { function_name: pack.function_name, machine_id: selected.machine_id }) as { message: string };
    assert.match(checked.message, /Selected preflight fixture/);
    assert.doesNotMatch(checked.message, /Default offline fixture|preflight-fixture-token/);
    assert.equal(fs.readFileSync(project.config_path, 'utf8'), original);
    await assert.rejects(api.projectAction(project.project_id, 'check', { function_name: 'kernel', machine_id: 'missing-machine' }));
    await assert.rejects(api.projectAction(project.project_id, 'check', { machine_id: 123 }), /请选择有效的执行机器/);
    const runnerClient = new RunnerClient({ baseUrl: runner.url, token: 'preflight-fixture-token' });
    assert.equal((await api.listOptimizationWorkflows()).workflows.length, 0);
    assert.equal(f.modelRequests.inference, 0);
    assert.ok((await runnerClient.probe()).health);
  } finally { await runner.close(); await f.close(); }
});

test('registered machines are shared by projects and CLI, persist across connections, mask credentials and report real online/offline facts', async () => {
  const f = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'registry-private-key', dbPath: path.join(f.root, 'runner.sqlite'), workspaceRoot: path.join(f.root, 'runner') });
  const api = new ApiClient(f.url, { token: f.token });
  try {
    const definition = { name: 'Shared CPU', runner: { mode: 'rpc', endpoint: runner.url, token: 'registry-private-key' }, target: { ssh_alias: 'maintainer-target', workspace_root: path.join(f.root, 'runner') } };
    const { machine } = await api.machineAction('', '', { machine: definition }, 'POST') as { machine: ExecutionMachineDetails };
    assert.equal(machine.status, 'ONLINE'); assert.ok(machine.hardware?.cpu_count); assert.equal(machine.runner.token, '[redacted]');
    const inventory = await api.listExecutionMachines();
    assert.equal(inventory.machines.length, 1); assert.doesNotMatch(JSON.stringify(inventory), /registry-private-key|maintainer-target|"token"/);
    const secondRepo = path.join(f.root, 'second'); fs.mkdirSync(secondRepo);
    const first = f.projects.add({ name: 'First', repository_root: f.repo, config_path: f.configPath });
    const second = f.projects.add({ name: 'Second', repository_root: secondRepo });
    const bound = await runFixtureCli(f.url, f.token, ['project', 'machine', first.project_id, machine.machine_id]);
    assert.equal(bound.code, 0, bound.stderr); assert.doesNotMatch(bound.stdout, /registry-private-key/);
    await api.projectAction(second.project_id, 'machine', { machine_id: machine.machine_id }, 'PUT');
    for (const project of [first, second]) {
      assert.deepEqual(loadOptimizationConfig(project.config_path).config.runner, { mode: 'rpc', machine_id: machine.machine_id });
      assert.doesNotMatch(fs.readFileSync(project.config_path, 'utf8'), /registry-private-key/);
    }
    const listed = await runFixtureCli(f.url, f.token, ['machine', 'list']); assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).machines[0].machine_id, machine.machine_id);
    const ctx = new WorkbenchContext({ configPath: first.config_path, targetChecker: () => { throw new Error('registered selection must not request SSH credentials'); } });
    ctx.getApi = async () => api;
    const io: CommandIO = { print() {}, error() {}, async prompt() { throw new Error('registered selection must not prompt for connection details'); }, async confirm() { return true; }, async select(_question, choices) { return choices[0]?.value ?? null; } };
    assert.equal((await runCommand(ctx, '/target', io)).ok, true);
    assert.deepEqual(loadOptimizationConfig(first.config_path).config.runner, { mode: 'rpc', machine_id: machine.machine_id });
    const reopened = new SqliteTaskStore(path.join(f.root, 'db.sqlite')); reopened.init();
    try { assert.equal(reopened.getExecutionMachine(machine.machine_id)?.runner.token, 'registry-private-key'); } finally { reopened.close(); }
    const edited = await api.machineAction(machine.machine_id, '', { machine: { ...definition, name: 'Renamed CPU', runner: machine.runner, expected_revision: machine.revision } }, 'PUT') as { machine: ExecutionMachineDetails };
    assert.equal(edited.machine.revision, 2); assert.equal(f.store.getExecutionMachine(machine.machine_id)?.runner.token, 'registry-private-key');
    await assert.rejects(api.machineAction(machine.machine_id, '', { machine: { ...definition, runner: { ...machine.runner, endpoint: `${runner.url}/other` } } }, 'PUT'), /修改地址后需提供对应凭据/);
    await runner.close();
    const offline = await api.machineAction(machine.machine_id, 'check', {}) as { machine: ExecutionMachineSummary };
    assert.equal(offline.machine.status, 'OFFLINE'); assert.ok(offline.machine.hardware); assert.ok(offline.machine.last_online_at);
    const disabled = f.projects.machines.save({ ...definition, name: 'Disabled', enabled: false }, machine.machine_id);
    assert.equal(disabled.status, 'DISABLED');
    assert.throws(() => f.projects.machines.resolve(machine.machine_id), /已停用/);
    assert.equal(f.modelRequests.inference, 0); assert.equal(f.service.list().length, 0);
  } finally { await runner.close(); await f.close(); }
});

test('public submissions freeze the registered RPC connection and deployment identity, preserve replay and never copy credentials to reports', async () => {
  const f = await startWebFixture();
  try {
    const registry = f.projects.machines;
    const machine = registry.save({ name: 'Execution A', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4327', token: 'snapshot-token-a' }, target: { ssh_alias: 'selected-target-a', workspace_root: '/runner/a' } });
    const project = f.projects.add({ name: 'Registered optimization', repository_root: f.repo, config_path: f.configPath });
    const existing = f.projects.config(project.project_id);
    f.projects.saveConfig(project.project_id, { ...existing, validation: { library_package: { package_id: 'ftblas', package_version: '1.0.0', target_id: 'sgemv-n' }, baseline_artifact: path.join(f.root, 'baseline.so') }, runner: { mode: 'rpc', machine_id: machine.machine_id } });
    const request = f.projects.request(project.project_id, {});
    const preflight = loadPublicOptimizationPreflight(request, { resolveMachine: id => registry.resolve(id) });
    assert.equal(preflight.runner.mode === 'rpc' && preflight.runner.endpoint, 'http://127.0.0.1:4327');
    assert.equal('ssh_alias' in preflight.config.config.target && preflight.config.config.target.ssh_alias, 'selected-target-a');
    const api = new ApiClient(f.url, { token: f.token });
    const first = await api.submitOptimizationWorkflow({ project_id: project.project_id }, { requestId: 'machine-snapshot' }) as { workflow_id: string };
    assert.deepEqual(f.service.get(first.workflow_id)?.execution_machine, { machine_id: machine.machine_id, name: 'Execution A', revision: 1 });
    assert.deepEqual(f.store.getOptimizationTaskByWorkflowId(first.workflow_id)?.declared_context.target, preflight.config.config.target);
    registry.save({ name: 'Execution A updated', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4328', token: 'snapshot-token-b' }, target: { ssh_alias: 'selected-target-b', workspace_root: '/runner/b' } }, machine.machine_id);
    assert.equal(preflight.runner.mode === 'rpc' && preflight.runner.token, 'snapshot-token-a', 'an already planned workflow keeps its in-memory connection');
    const replay = await api.submitOptimizationWorkflow({ project_id: project.project_id }, { requestId: 'machine-snapshot' }) as { workflow_id: string };
    assert.equal(replay.workflow_id, first.workflow_id); assert.equal(f.service.get(first.workflow_id)?.execution_machine?.revision, 1);
    const second = await api.submitOptimizationWorkflow({ project_id: project.project_id }) as { workflow_id: string };
    assert.equal(f.service.get(second.workflow_id)?.execution_machine?.revision, 2);
    const report = await api.getOptimizationReport(first.workflow_id);
    assert.match(report.markdown, /Execution A/); assert.doesNotMatch(JSON.stringify(report), /snapshot-token-a|snapshot-token-b/);
    const other = registry.save({ name: 'Execution B', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4329', token: 'other-secret' } });
    f.projects.bindMachine(project.project_id, other.machine_id);
    const afterDefaultChange = await api.submitOptimizationWorkflow({ project_id: project.project_id }, { requestId: 'machine-snapshot' }) as { workflow_id: string };
    assert.equal(afterDefaultChange.workflow_id, first.workflow_id);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, machine_id: other.machine_id }, { requestId: 'machine-snapshot' }), /different optimization inputs/);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id }), /尚未完成部署环境/);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('a late health response cannot overwrite edited credentials or hardware, and concurrent probes are coalesced', async () => {
  const f = await startWebFixture();
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'probe-secret', dbPath: path.join(f.root, 'runner.sqlite'), workspaceRoot: path.join(f.root, 'runner') });
  const facts = await new RunnerClient({ baseUrl: runner.url, token: 'probe-secret' }).probe();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let healthCalls = 0;
  const slow = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') { healthCalls++; res.end(JSON.stringify(facts.health)); }
    else { entered(); void gate.then(() => res.end(JSON.stringify(facts.machine))); }
  });
  await new Promise<void>(resolve => slow.listen(0, '127.0.0.1', resolve));
  const address = slow.address(); assert.ok(address && typeof address === 'object');
  try {
    const service = new ExecutionMachineService(f.store);
    const original = { name: 'Slow original', runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'probe-secret' } };
    const record = service.save(original);
    const first = service.check(record.machine_id); const same = service.check(record.machine_id);
    await started;
    service.save({ ...original, name: 'Edited machine', runner: { mode: 'rpc', endpoint: runner.url, token: 'probe-secret' } }, record.machine_id);
    release(); await Promise.all([first, same]);
    assert.equal(healthCalls, 1); assert.equal(service.get(record.machine_id).status, 'UNKNOWN');
    assert.equal(service.get(record.machine_id).hardware, null); assert.equal(service.details(record.machine_id).runner.endpoint, runner.url);
    assert.equal((await service.check(record.machine_id)).status, 'ONLINE'); assert.equal(service.get(record.machine_id).name, 'Edited machine');
  } finally { release(); await new Promise<void>(resolve => slow.close(() => resolve())); await runner.close(); await f.close(); }
});

test('a public optimization contacts the selected RPC machine before invoking a model and redacts its credential on failure', async () => {
  const f = await startWebFixture({ execute: true });
  let contacted = 0;
  const broken = http.createServer((_req, res) => {
    contacted++; res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'offline execution-private-token' } }));
  });
  await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve));
  const address = broken.address(); assert.ok(address && typeof address === 'object');
  try {
    const machine = f.projects.machines.save({ name: 'Failing execution node', runner: { mode: 'rpc', endpoint: `http://127.0.0.1:${address.port}`, token: 'execution-private-token' }, target: { ssh_alias: 'must-not-SSH', workspace_root: '/runner/registered' } });
    const project = f.projects.add({ name: 'Execution routing', repository_root: f.repo, config_path: f.configPath });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { library_package: { package_id: 'ftblas', package_version: '1.0.0', target_id: 'sgemv-n' }, baseline_artifact: path.join(f.root, 'baseline.so') }, runner: { mode: 'rpc', machine_id: machine.machine_id } });
    const api = new ApiClient(f.url, { token: f.token });
    const result = await api.submitOptimizationWorkflow({ project_id: project.project_id }) as { workflow_id: string };
    const deadline = Date.now() + 5000;
    while (f.service.activeWorkflowIds().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(f.service.get(result.workflow_id)?.status, 'FAILED'); assert.equal(contacted, 1);
    assert.equal(f.modelRequests.inference, 0);
    const report = await api.getOptimizationReport(result.workflow_id);
    assert.doesNotMatch(JSON.stringify(report), /execution-private-token/);
    assert.match(report.report.workflow.error ?? '', /offline.*redacted/);
    assert.equal(report.report.workflow.execution_machine?.machine_id, machine.machine_id);
  } finally { await new Promise<void>(resolve => broken.close(() => resolve())); await f.close(); }
});
