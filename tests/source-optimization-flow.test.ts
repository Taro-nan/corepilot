import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parsePublicWorkflowRequest } from '../src/contracts/public-workflow.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { checkOptimization } from '../src/workflow/check-optimization.js';
import { loadSourceOptimizationPreflight, sourceOptimizationContractDigest } from '../src/workflow/source-optimization.js';
import { WorkspaceToolset } from '../src/agent/workspace-tools.js';
import { hypothesisProposal } from './hypothesis-fixture.js';
import { parseSourceScope } from '../src/contracts/source-scope.js';
import { executeWorkflowCommand } from '../src/client/workflow-commands.js';
import { runCommandArgs } from '../src/cli-interactive/commands.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';
import { sourceOptimizationFixture } from './source-optimization-fixture.js';

test('source-only Agent receives a submission error for an isolated build artifact and produces no Candidate', async () => {
  const f = await sourceOptimizationFixture({ onlyArtifact: true });
  try {
    const id = await f.start();
    const record = await f.wait('NO_CANDIDATE');
    assert.equal(record.workflow_id, id);
    assert.equal(f.store.getOptimizationTask(record.optimization_task_id!)?.status, 'COMPLETED');
    assert.equal(record.candidate_id ?? null, null);
    assert.equal(f.store.listCandidates(record.optimization_task_id!).length, 0);
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 0);
    const events = await f.api.getOptimizationSessionEvents(id, 0, 200);
    assert.ok(events.events.some(event => event.kind === 'tool_result' && event.tool_name === 'submit_candidate'
      && event.is_error && /build artifacts are not Candidate source/i.test(event.text)));
  } finally { await f.close(); }
});
import type { ExecutionMachineRecord } from '../src/contracts/execution-machine.js';
import { OptimizationWorkflowService } from '../src/workflow/optimization-workflow-service.js';

test('source-only public workflow freezes a patch with no testpack, build, Runner or experiment', async () => {
  const f = await sourceOptimizationFixture();
  try {
    const id = await f.start();
    const record = await f.wait('CANDIDATE_READY');
    assert.equal(record.verification_mode, 'source_only'); assert.equal(record.enable_performance, false);
    assert.equal(record.error, null); assert.ok(record.candidate_id); assert.ok(record.agent_session);
    const report = await f.api.getOptimizationReport(id);
    assert.equal(report.report.task!.evaluator, null); assert.equal(report.report.task!.performance_baseline, null);
    assert.equal(report.report.task!.status, 'CANDIDATE_READY'); assert.equal(report.report.experiments.length, 0);
    assert.equal(report.report.candidates.length, 1); assert.equal(report.report.candidates[0].candidate.status, 'FROZEN');
    assert.equal(report.report.summary!.state, 'CANDIDATE_READY'); assert.equal(report.report.summary!.next_step.kind, 'TEST');
    assert.equal(report.report.summary!.verification.ready, false);
    assert.match(report.markdown, /NOT_EXECUTED \/ NOT_EXECUTED \/ NOT_EXECUTED/);
    assert.match(f.git('diff', record.baseline_commit!, record.candidate_commit!, '--', 'kernel.c'), /\+int kernel\(void\) \{ return 2; \}/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline); assert.match(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8'), /1 \+ 1/);
    const names = f.contexts[0].tools.map((tool: any) => tool.function.name);
    for (const name of ['run_build', 'run_correctness', 'run_performance', 'run_dev_benchmark', 'profile_perf_stat', 'inspect_machine']) assert.ok(!names.includes(name), name);
    assert.throws(() => f.service.approvals.prepare(id), /不处于等待人工审阅/);
    assert.equal((await f.service.approvePublic(id, { commitMessage: 'fixture must not deliver' })).ok, false);
    const runtime = new OptimizationRuntime(f.store);
    assert.throws(() => runtime.startExperiment({ taskId: record.optimization_task_id!, candidateId: record.candidate_id!, type: 'FORMAL_EVALUATION' }), /未绑定测试方案/);
    assert.throws(() => runtime.inspectCandidateApproval({ taskId: record.optimization_task_id!, candidateId: record.candidate_id!,
      firstFormalExperimentId: 'absent', revalidationExperimentId: 'absent', evaluatorRoot: f.root }), /未验证的源码候选不能批准/);
    assert.throws(() => f.service.retryValidationPublic(id), /独立测试任务/);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
    const checked = await checkOptimization(f.configPath, 'kernel', { verificationMode: 'source_only', repositoryRoot: f.repo, sourceBranch: 'main', candidateScope: { include: ['kernel.c'], exclude: [] } });
    assert.match(checked.message, /源码优化输入检查通过/);
    const savedConfig = JSON.parse(fs.readFileSync(f.configPath, 'utf8')); delete savedConfig.runner;
    fs.writeFileSync(f.configPath, JSON.stringify(savedConfig));
    assert.throws(() => f.service.submitPublic({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath, repository_root: f.repo }), /测试方案文件不存在/);
  } finally { await f.close(); }
});

test('selected source target uses cached hardware and its configuration without contacting the machine', async () => {
  const f = await sourceOptimizationFixture();
  const observedAt = '2026-01-01T00:00:00.000Z';
  const selected: ExecutionMachineRecord = {
    machine_id: 'source-target', name: 'Chosen offline AArch64', revision: 1, enabled: true,
    created_at: observedAt, updated_at: observedAt, last_check: { status: 'OFFLINE', checked_at: observedAt, error: 'Fixture intentionally offline' },
    target: { ssh_alias: 'chosen-source-target', workspace_root: '/chosen/source-target' },
    runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: 'registry-source-private-token', request_timeout_ms: 1000, poll_interval_ms: 100 },
    last_success: { checked_at: observedAt, health: { runner_id: 'offline-fixture', version: 'fixture', protocol_version: 1, status: 'READY', resource_enforcement: 'DISABLED' }, machine: {
      hostname: 'chosen-fixture', architecture: 'fixture-aarch64', platform: 'linux', os: 'fixture-linux', kernel: 'fixture', cpu_count: 32,
      cpu_model: 'Fixture CPU', machine_identity_sha256: 'a'.repeat(64), node_runtime: 'fixture',
      cpu_identity: { product_model: 'Fixture CPU', hardware: null, implementer: null, architecture: null, variant: null, part: null, revision: null, midr_el1: null },
      cpu_topology: { online_cpus: '0-31', possible_cpus: '0-31', sockets: 1, cores: 32, threads_per_core: 1, node_cpu_lists: {} },
      numa_summary: null, resource_capabilities: { taskset: false, numactl: false, proc_status: false },
    } },
  };
  try {
    assert.equal(f.store.saveExecutionMachine(selected), true);
    const id = await f.start(undefined, selected.machine_id); const record = await f.wait('CANDIDATE_READY');
    assert.deepEqual(record.execution_machine, { machine_id: selected.machine_id, name: selected.name, revision: selected.revision });
    const context = JSON.stringify(f.contexts[0]);
    assert.match(context, /chosen-source-target/); assert.match(context, /fixture-aarch64/); assert.match(context, /REGISTRY_CACHE/); assert.match(context, /2026-01-01/);
    assert.doesNotMatch(context, /unused-source-target|registry-source-private-token/);
    const checked = await checkOptimization(f.configPath, 'kernel', { verificationMode: 'source_only', candidateScope: { include: ['kernel.c'], exclude: [] }, machineId: selected.machine_id,
      readMachine: machineId => f.store.getExecutionMachine(machineId) });
    assert.match(checked.message, /Chosen offline AArch64/); assert.match(checked.message, /本次未探测/);
    assert.equal(f.store.listExperiments(record.optimization_task_id!).length, 0);
    assert.equal(f.service.get(id)!.status, 'CANDIDATE_READY');
  } finally { await f.close(); }
});

test('continuing a ready source candidate records a child proposal and new frozen source without changing the original', async () => {
  const f = await sourceOptimizationFixture();
  try {
    const id = await f.start(); const first = await f.wait('CANDIDATE_READY');
    await f.api.resumeOptimizationWorkflow(id, { message: 'Investigate the next source-only proposal.' });
    const second = await f.wait('CANDIDATE_READY');
    const candidates = f.store.listCandidates(second.optimization_task_id!);
    assert.equal(candidates.length, 2); assert.equal(candidates[1].parent_candidate_id, first.candidate_id);
    assert.notEqual(second.candidate_commit, first.candidate_commit);
    assert.match(f.git('show', `${second.candidate_commit}:kernel.c`), /return \(2\)/);
    assert.match(f.git('show', `${first.candidate_commit}:kernel.c`), /return 2/);
    assert.equal(f.store.listExperiments(second.optimization_task_id!).length, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  } finally { await f.close(); }
});

test('time-budget exhaustion and process restart preserve one source session and reject context drift', async () => {
  const f = await sourceOptimizationFixture({ delayFirstMs: 1500 });
  try {
    const id = await f.start({ time_limit_ms: 1000, max_candidates: 1 });
    const first = await f.wait('BUDGET_EXHAUSTED');
    assert.equal(f.store.getOptimizationTask(first.optimization_task_id!)!.status, 'BUDGET_EXHAUSTED');
    assert.equal(first.error, null); await f.restart();
    const original = fs.readFileSync(f.configPath, 'utf8');
    const changed = JSON.parse(original); changed.build.args = ['changed-context'];
    fs.writeFileSync(f.configPath, JSON.stringify(changed));
    await assert.rejects(f.api.resumeOptimizationWorkflow(id), /已改变/);
    fs.writeFileSync(f.configPath, original);
    await f.api.resumeOptimizationWorkflow(id, { budget: { time_limit_ms: 30_000 } });
    const final = await f.wait('CANDIDATE_READY');
    assert.equal(final.workflow_id, id); assert.equal(final.agent_session!.id, first.agent_session!.id);
    assert.equal(final.workspace_editing, first.workspace_editing);
    assert.equal(f.store.listExperiments(final.optimization_task_id!).length, 0);
    assert.equal(f.store.listCandidates(final.optimization_task_id!).length, 1);
  } finally { await f.close(); }
});

test('cancelling source optimization confirms stopped state without remote work or invented validation', async () => {
  const f = await sourceOptimizationFixture({ holdFirst: true });
  try {
    const id = await f.start();
    for (let attempt = 0; attempt < 200 && !f.held; attempt++) await delay(20);
    assert.ok(f.held);
    assert.equal(f.service.cancel(id).status, 'CANCEL_REQUESTED');
    const cancelled = await f.wait('CANCELLED');
    assert.equal(f.store.getOptimizationTask(cancelled.optimization_task_id!)!.status, 'CANCELLED');
    assert.equal(f.store.listExperiments(cancelled.optimization_task_id!).length, 0);
    assert.equal(f.store.listCandidates(cancelled.optimization_task_id!).length, 0);
    assert.equal(f.git('rev-parse', 'HEAD'), f.baseline);
  } finally { await f.close(); }
});

test('source-only mode is explicit and rejects contradictory performance requests', () => {
  const request = { function_name: 'kernel', entry_file: null, config_path: 'corepilot.yaml' };
  assert.equal(parsePublicWorkflowRequest(request).verification_mode, undefined);
  assert.throws(() => parsePublicWorkflowRequest({ ...request, verification_mode: 'source_only' }), /允许修改/);
  assert.equal(parsePublicWorkflowRequest({ ...request, verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] } }).verification_mode, 'source_only');
  assert.throws(() => parsePublicWorkflowRequest({ ...request, verification_mode: 'unknown' }), /verification_mode/);
  assert.throws(() => parsePublicWorkflowRequest({ ...request, verification_mode: 'source_only', enable_performance: true }), /仅优化源码/);
});

test('source-only request identity normalizes disabled performance and cannot be reused for verified mode', async () => {
  const f = await sourceOptimizationFixture();
  const service = new OptimizationWorkflowService({ store: f.store, publicExecution: false, publicEnablePerformance: true,
    transportFactory: () => { throw new Error('An intake cannot construct a transport'); } });
  try {
    const request = { verification_mode: 'source_only' as const, config_path: f.configPath, function_name: 'kernel', entry_file: 'kernel.c', repository_root: f.repo, candidate_scope: { include: ['kernel.c'], exclude: [] } };
    const first = service.submitPublic(request, { requestId: 'source-request' });
    assert.deepEqual(service.submitPublic({ ...request, enable_performance: false }, { requestId: 'source-request' }), first);
    assert.throws(() => service.submitPublic({ ...request, verification_mode: 'verified' }, { requestId: 'source-request' }), /修改范围仅适用/);
    assert.throws(() => service.submitPublic({ ...request, candidate_scope: { include: ['other.c'], exclude: [] } }, { requestId: 'source-request' }), /different optimization inputs/);
    assert.equal(service.list().length, 1); assert.equal(f.contexts.length, 0);
  } finally { await service.stop(); await f.close(); }
});

test('interactive optimize passes source-only mode and explicit scope to the shared API', async () => {
  const f = await sourceOptimizationFixture(); const original = process.cwd(); let selected = '';
  const context = { hasConfig: () => true, configPath: f.configPath, getApi: async () => f.api,
    setCurrentWorkflow: (id: string) => { selected = id; } } as unknown as WorkbenchContext;
  const io = { print: () => {}, error: () => {}, prompt: async () => null,
    select: async <T>() => null as T | null, confirm: async () => false };
  try {
    process.chdir(f.repo);
    const result = await runCommandArgs(context, '/optimize', ['--function', 'kernel', '--source-only', '--allow', 'kernel.c'], io);
    assert.equal(result.ok, true, result.message);
    const record = f.service.get(selected)!;
    assert.equal(record.verification_mode, 'source_only');
    assert.deepEqual(record.source_scope_authorization?.candidate_scope, { include: ['kernel.c'], exclude: [] });
    assert.equal(record.enable_performance, false);
  } finally { process.chdir(original); await f.close(); }
});

test('explicit source scope is normalized and rejects traversal and protected roots', () => {
  assert.deepEqual(parseSourceScope({ include: ['src\\kernel.c', 'src\\kernel.c', 'impl/'], exclude: ['impl/tests/'] }),
    { include: ['impl/', 'src/kernel.c'], exclude: ['impl/tests/'] });
  for (const path of ['../secret.c', '/etc/passwd', 'C:/foo', '.git/config', 'src/.GIT/config', 'src/node_modules/', 'src/../test.c', 'src/*']) {
    assert.throws(() => parseSourceScope({ include: [path], exclude: [] }), /相对|无效/);
  }
});

test('the source task constrains hypotheses, write tools and accumulated changes after resumption', async () => {
  const f = await sourceOptimizationFixture();
  try {
    const id = await f.start();
    const first = await f.wait('CANDIDATE_READY');
    const runtime = new OptimizationRuntime(f.store);
    assert.deepEqual(runtime.getTask(first.optimization_task_id!).target.scope.candidate_scope, { include: ['kernel.c'], exclude: [] });
    assert.throws(() => runtime.proposeHypothesis({ taskId: first.optimization_task_id!, parentHypothesisId: first.hypothesis_id!,
      proposal: hypothesisProposal('Try an oracle', ['tests/oracle.c']), agentIdentity: {} }), /超出允许修改范围/);
    const tools = new WorkspaceToolset(first.workspace_editing!, { candidateSourceScope: { include: ['kernel.c'], exclude: [] } });
    for (const [name, args] of [
      ['replace_text', { path: 'tests/oracle.c', old_text: 'return 2', new_text: 'return 1' }],
      ['move_file', { from: 'kernel.c', to: 'tests/new.c' }],
    ] as const) assert.equal((await tools.execute(name, args, new AbortController().signal)).isError, true);
    const workspaceOracle = path.join(first.workspace_editing!, 'tests', 'oracle.c');
    fs.writeFileSync(workspaceOracle, 'int reference(void) { return 999; }\n');
    await f.api.resumeOptimizationWorkflow(id);
    const failed = await f.wait('FAILED');
    assert.match(failed.error!, /超出允许修改范围/);
    assert.equal(f.store.listCandidates(first.optimization_task_id!).length, 1);
    assert.match(fs.readFileSync(workspaceOracle, 'utf8'), /999/);
    assert.match(fs.readFileSync(path.join(f.repo, 'tests', 'oracle.c'), 'utf8'), /return 2/);
  } finally { await f.close(); }
});

test('legacy source session gains a continuation-only scope without changing historical candidates or digest', async () => {
  const f = await sourceOptimizationFixture();
  try {
    const id = await f.start(); const first = await f.wait('CANDIDATE_READY');
    const task = f.store.getOptimizationTask(first.optimization_task_id!)!;
    delete task.target.scope.candidate_scope;
    delete first.source_scope_authorization;
    const oldPreflight = loadSourceOptimizationPreflight({ verification_mode: 'source_only', function_name: first.function_name,
      entry_file: first.entry_file, config_path: first.config_path, repository_root: first.repository_root }, { historicalScope: true });
    first.execution_contract_digest = sourceOptimizationContractDigest(oldPreflight);
    f.store.saveOptimizationTask(task); f.store.saveOptimizationWorkflowJson(id, JSON.stringify(first));
    const oldCandidate = JSON.stringify(f.store.getCandidate(first.candidate_id!)!);
    await assert.rejects(f.api.resumeOptimizationWorkflow(id), /历史任务未记录源码授权范围/);
    await assert.rejects(f.api.resumeOptimizationWorkflow(id, { candidate_scope: { include: ['tests/'], exclude: [] } }), /超出允许修改范围/);
    assert.equal(f.service.get(id)!.source_scope_authorization, undefined);
    const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('injected authorization write failure'); };
    await assert.rejects(f.api.resumeOptimizationWorkflow(id, { candidate_scope: { include: ['kernel.c'], exclude: [] } }), /injected authorization write failure/);
    f.store.saveOptimizationWorkflowJson = save;
    assert.equal(f.store.getOptimizationTask(first.optimization_task_id!)!.declared_context.source_scope_authorization, undefined);
    assert.equal(f.service.get(id)!.source_scope_authorization, undefined);
    await f.restart();
    const cliResume = await executeWorkflowCommand(f.api, ['resume', id, '--allow', 'kernel.c']);
    assert.equal(cliResume.ok, true);
    const second = await f.wait('CANDIDATE_READY');
    assert.equal(second.source_scope_authorization?.kind, 'CONTINUATION');
    assert.equal(second.source_scope_authorization?.previous_candidate_id, first.candidate_id);
    assert.equal(second.execution_contract_digest, first.execution_contract_digest);
    assert.equal(JSON.stringify(f.store.getCandidate(first.candidate_id!)!), oldCandidate);
    const restored = f.store.getOptimizationTask(first.optimization_task_id!)!;
    assert.equal(restored.target.scope.candidate_scope, undefined);
    assert.deepEqual(restored.declared_context.source_scope_authorization, second.source_scope_authorization);
    await assert.rejects(f.api.resumeOptimizationWorkflow(id, { candidate_scope: { include: ['tests/'], exclude: [] } }), /修改范围已固定/);
    await f.restart();
    await f.api.resumeOptimizationWorkflow(id);
    const last = await f.wait('NO_CANDIDATE');
    assert.deepEqual(last.source_scope_authorization, second.source_scope_authorization);
  } finally { await f.close(); }
});
