import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { WorkspaceToolset } from '../src/agent/workspace-tools.js';
import { runPublicAgentWorkflow } from '../src/workflow/public-agent-workflow.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { hypothesisProposal } from './hypothesis-fixture.js';
import { runCommandArgs } from '../src/cli-interactive/commands.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { runFixtureCli, startWebFixture } from './web-fixture.js';

const scope = { include: ['kernel.c'], exclude: [] };

test('verified public intake and preflight require the same explicit scope, and replay fixes its identity', async () => {
  const f = await startWebFixture();
  try {
    const api = new ApiClient(f.url, { token: f.token });
    const project = f.projects.add({ name: 'Source scope', repository_root: f.repo, config_path: f.configPath });
    const input = { project_id: project.project_id, function_name: 'kernel' };
    await assert.rejects(api.projectAction(project.project_id, 'check', { function_name: 'kernel' }), /允许修改/);
    await assert.rejects(api.submitOptimizationWorkflow(input), /允许修改/);
    assert.equal(f.service.list().length, 0);
    const check = await api.projectAction(project.project_id, 'check', { function_name: 'kernel', candidate_scope: scope }) as { message: string };
    assert.match(check.message, /允许修改：kernel\.c/);
    const first = await api.submitOptimizationWorkflow({ ...input, candidate_scope: scope }, { requestId: 'scope-intake' }) as { workflow_id: string };
    const repeat = await api.submitOptimizationWorkflow({ ...input, candidate_scope: scope }, { requestId: 'scope-intake' }) as { workflow_id: string };
    assert.equal(repeat.workflow_id, first.workflow_id);
    await assert.rejects(api.submitOptimizationWorkflow({ ...input, candidate_scope: { include: ['other.c'], exclude: [] } }, { requestId: 'scope-intake' }), /different optimization inputs/);
    const record = f.service.get(first.workflow_id)!;
    const task = f.store.getOptimizationTask(record.optimization_task_id!)!;
    assert.deepEqual(record.source_scope_authorization?.candidate_scope, scope);
    assert.deepEqual(task.target.scope.candidate_scope, scope);
    const runtime = new OptimizationRuntime(f.store);
    assert.throws(() => runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null,
      proposal: hypothesisProposal('Do not alter the oracle', ['tests/oracle.c']), agentIdentity: {} }), /超出允许修改范围/);
    const tools = new WorkspaceToolset(f.repo, { candidateSourceScope: scope });
    const bad = await tools.execute('create_file', { path: 'tests/oracle.c', content: 'forbidden' }, new AbortController().signal);
    assert.equal(bad.isError, true);
    assert.equal(fs.existsSync(path.join(f.repo, 'tests', 'oracle.c')), false);
    const cliMissing = await runFixtureCli(f.url, f.token, ['check', '--config', f.configPath, '--function', 'kernel']);
    assert.notEqual(cliMissing.code, 0);
    assert.match(cliMissing.stderr, /允许修改/);
    const cliChecked = await runFixtureCli(f.url, f.token, ['check', '--config', f.configPath, '--function', 'kernel', '--allow', 'kernel.c']);
    assert.equal(cliChecked.code, 0, cliChecked.stderr);
    assert.match(cliChecked.stdout, /允许修改：kernel\.c/);
    const projectChecked = await runFixtureCli(f.url, f.token, ['project', 'check', project.project_id, '--allow', 'kernel.c']);
    assert.equal(projectChecked.code, 0, projectChecked.stderr);
    assert.match(projectChecked.stdout, /允许修改：kernel\.c/);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('interactive verified optimization without a branch asks for its authorized file', async () => {
  const f = await startWebFixture(); const cwd = process.cwd();
  let selected = '';
  const context = { hasConfig: () => true, configPath: f.configPath, getApi: async () => new ApiClient(f.url, { token: f.token }),
    setCurrentWorkflow: (id: string) => { selected = id; } } as unknown as WorkbenchContext;
  const questions: string[] = [];
  const io = { print: () => {}, error: () => {}, prompt: async (question: string) => { questions.push(question); return questions.length === 2 ? 'kernel.c' : 'kernel'; },
    select: async <T>() => 'background' as T, confirm: async () => false };
  try {
    process.chdir(f.repo);
    const result = await runCommandArgs(context, '/optimize', [], io);
    assert.equal(result.ok, true, result.message);
    assert.match(questions[1], /允许修改/);
    const record = f.service.get(selected)!;
    assert.equal(record.source_branch, undefined);
    assert.deepEqual(record.source_scope_authorization?.candidate_scope, scope);
    assert.equal(f.modelRequests.inference, 0);
  } finally { process.chdir(cwd); await f.close(); }
});

test('an out-of-scope accumulated edit stops a verified workflow before any Agent or experiment', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f);
    fs.writeFileSync(path.join(seeded.workspace.editing, 'outside.c'), 'do not freeze\n');
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath,
      repository_root: f.repo, candidate_scope: scope });
    let calls = 0;
    const result = await runPublicAgentWorkflow({ preflight, repository: f.repo, worktreeRoot: path.join(f.root, 'unused'), runId: 'scope-guard',
      resumeFrom: { ...seeded.saved, evaluationFeedback: null, pendingDecision: null },
      runAgent: async () => { calls++; throw new Error('Agent must not start'); } });
    assert.equal(result.status, 'FAILED');
    assert.match(result.error!, /超出允许修改范围.*outside\.c/);
    assert.equal(calls, 0);
    assert.equal(f.store.listCandidates(seeded.candidate.task_id).length, 1);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 1);
  } finally { await f.close(); }
});

test('a Package-owned scope cannot be replaced by public input', async () => {
  const f = await startWebFixture();
  try {
    const project = f.projects.add({ name: 'Package scope', repository_root: f.repo, config_path: f.configPath });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id),
      validation: { library_package: { package_id: 'ftblas', package_version: '1.0.0', target_id: 'sgemv-n' }, baseline_artifact: '/fixture/baseline.so' },
      runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4327', token: 'fixture-token' } });
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.projectAction(project.project_id, 'check', { candidate_scope: scope }), /接入包已固定源码修改范围/);
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: project.project_id, candidate_scope: scope }), /接入包已固定源码修改范围/);
    assert.equal(f.service.list().length, 0);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('legacy verified source authorization is appended atomically and does not rewrite old evidence', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, false, true);
    const record = f.service.get(seeded.workflowId)!;
    record.status = 'INTERRUPTED'; record.candidate_evaluation_feedback = null;
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
    const taskBefore = f.store.getOptimizationTask(seeded.candidate.task_id)!;
    const candidateBefore = f.store.getCandidate(seeded.candidate.candidate_id);
    const experimentBefore = f.store.getExperiment(seeded.experiment.experiment_id);
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.resumeOptimizationWorkflow(seeded.workflowId), /未记录源码授权/);
    fs.writeFileSync(path.join(seeded.workspace.editing, 'outside.c'), 'not allowed\n');
    await assert.rejects(api.resumeOptimizationWorkflow(seeded.workflowId, { candidate_scope: scope }), /超出允许修改范围/);
    fs.unlinkSync(path.join(seeded.workspace.editing, 'outside.c'));
    const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('authorization write failed'); };
    try { await assert.rejects(api.resumeOptimizationWorkflow(seeded.workflowId, { candidate_scope: scope }), /authorization write failed/); }
    finally { f.store.saveOptimizationWorkflowJson = save; }
    assert.deepEqual(f.store.getOptimizationTask(seeded.candidate.task_id), taskBefore);
    await api.resumeOptimizationWorkflow(seeded.workflowId, { candidate_scope: scope });
    await f.service.stop();
    const after = f.service.get(seeded.workflowId)!;
    const taskAfter = f.store.getOptimizationTask(seeded.candidate.task_id)!;
    assert.equal(after.source_scope_authorization?.kind, 'CONTINUATION');
    assert.deepEqual(after.source_scope_authorization?.candidate_scope, scope);
    assert.equal(after.execution_contract_digest, record.execution_contract_digest);
    assert.deepEqual(taskAfter.target, taskBefore.target);
    assert.deepEqual(taskAfter.evaluator, taskBefore.evaluator);
    assert.deepEqual(f.store.getCandidate(seeded.candidate.candidate_id), candidateBefore);
    assert.deepEqual(f.store.getExperiment(seeded.experiment.experiment_id), experimentBefore);
  } finally { await f.close(); }
});

test('a legacy unscoped frozen Candidate can still be revalidated without Agent or scope authorization', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, false, true);
    const credentiallessConfig = loadOptimizationConfig(f.configPath).config;
    credentiallessConfig.model.api_key = '${COREPILOT_MISSING_RECOVERY_FIXTURE_KEY}';
    assert.equal(process.env.COREPILOT_MISSING_RECOVERY_FIXTURE_KEY, undefined);
    fs.writeFileSync(f.configPath, JSON.stringify(credentiallessConfig));
    const old = f.store.getExperiment(seeded.experiment.experiment_id);
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    assert.equal(f.service.get(seeded.workflowId)!.status, 'WAITING_APPROVAL');
    assert.equal(f.service.get(seeded.workflowId)!.source_scope_authorization, undefined);
    assert.equal(f.store.listCandidates(seeded.candidate.task_id).length, 1);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 3);
    assert.deepEqual(f.store.getExperiment(seeded.experiment.experiment_id), old);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
