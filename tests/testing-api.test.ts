import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { parseOptimizeCliInput } from '../src/config/optimize-cli-input.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { runCommandArgs } from '../src/cli-interactive/commands.js';
import type { WorkbenchContext } from '../src/cli-interactive/context.js';

test('independent testing assets are available without a source project through HTTP and CLI', async () => {
  const fixture = await startWebFixture();
  try {
    const api = new ApiClient(fixture.url, { token: fixture.token });
    assert.deepEqual(await api.listProjects(), { projects: [] });
    assert.deepEqual(await api.testing.list(), { tasks: [] });
    const unauthenticated = await fetch(fixture.url + '/v1/testing-assets');
    assert.equal(unauthenticated.status, 401);
    const { asset } = await api.testing.createAsset({ name: 'Test library', version: '1' });
    await api.testing.uploadAssetFile(asset.asset_id, 'include/example.h', new TextEncoder().encode('int example(void);\n'));
    await assert.rejects(() => api.testing.uploadAssetFile(asset.asset_id, '../outside.so', new Uint8Array([1])), /path|路径|relative/i);
    assert.equal((await api.testing.listAssets()).assets[0].files.length, 1);
    const cli = await runFixtureCli(fixture.url, fixture.token, ['test', 'assets']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).assets[0].asset_id, asset.asset_id);
    const list = await runFixtureCli(fixture.url, fixture.token, ['test', 'list']);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(JSON.parse(list.stdout), { tasks: [] });
    assert.equal(fixture.modelRequests.inference, 0);
  } finally { await fixture.close(); }
});

test('project submission preserves source-only mode and produces an explicitly unverified patch without tests', async () => {
  const fixture = await startWebFixture({ execute: true });
  try {
    const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
    config.validation = { testpack: '' };
    config.build = { executable: '', args: [], cwd: '.', environment: {}, timeout_ms: 10000 };
    fs.writeFileSync(fixture.configPath, JSON.stringify(config));
    const api = new ApiClient(fixture.url, { token: fixture.token });
    const { project } = await api.addProject({ name: 'Source only', repository_root: fixture.repo, config_path: fixture.configPath });
    const candidate_scope = { include: ['kernel.c'], exclude: [] };
    const preflight = await api.projectAction(project.project_id, 'check', { function_name: 'kernel', verification_mode: 'source_only', source_branch: 'main', candidate_scope }) as { message: string };
    assert.match(preflight.message, /未验证|未测量|不.*测试|source.only/i);
    const submitted = await api.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel', source_branch: 'main', verification_mode: 'source_only', candidate_scope }, { requestId: 'source-only-api' }) as { workflow_id: string };
    const deadline = Date.now() + 25000;
    let workflow = fixture.service.get(submitted.workflow_id)!;
    while (['CREATED', 'GENERATING'].includes(workflow.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      workflow = fixture.service.get(submitted.workflow_id)!;
    }
    assert.equal(workflow.status, 'CANDIDATE_READY', JSON.stringify(workflow.error));
    assert.equal(workflow.verification_mode, 'source_only');
    assert.equal(workflow.experiment_id, undefined);
    const report = await api.getOptimizationReport(workflow.workflow_id);
    assert.ok(report.report.candidates.length);
    assert.match(report.markdown, /未验证|未测量|NOT_EXECUTED|not.*verif/i);
    const patch = await fetch(`${fixture.url}/v1/workflows/${encodeURIComponent(workflow.workflow_id)}/candidates/${encodeURIComponent(workflow.candidate_id!)}/diff`,
      { headers: { authorization: `Bearer ${fixture.token}` } });
    assert.equal(patch.status, 200);
    assert.match((await patch.json() as { diff: string }).diff, /\+.*return 2/);
    assert.equal(fixture.git('show', 'main:kernel.c'), 'int kernel(void) { return 1 + 1; }');
    assert.ok(workflow.optimization_task_id);
    assert.equal(fixture.store.listExperiments(workflow.optimization_task_id).length, 0);
    const repeated = await api.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel', source_branch: 'main', verification_mode: 'source_only', candidate_scope }, { requestId: 'source-only-api' }) as { workflow_id: string };
    assert.equal(repeated.workflow_id, workflow.workflow_id);
    const cli = await runFixtureCli(fixture.url, fixture.token, ['workflow', 'watch', workflow.workflow_id, '--output', path.join(fixture.root, 'export'), '--timeout', '2']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.match(cli.stdout, /CANDIDATE_READY|代码待验证/);
  } finally { await fixture.close(); }
});

test('CLI source-only is explicit and does not silently change old optimization requests', () => {
  const source = parseOptimizeCliInput(['--project', 'project-1', '--function', 'kernel', '--source-only', '--allow', 'kernel.c']);
  assert.equal(source.verificationMode, 'source_only');
  assert.deepEqual(source.candidateScope, { include: ['kernel.c'], exclude: [] });
  assert.equal(source.enablePerformance, false);
  assert.throws(() => parseOptimizeCliInput(['--project', 'project-1', '--source-only', '--file', 'kernel.c']), /--allow/);
  assert.deepEqual(parseOptimizeCliInput(['--project', 'project-1', '--source-only', '--allow', 'src/', '--allow', 'kernel.c', '--exclude', 'src/tests/']).candidateScope,
    { include: ['kernel.c', 'src/'], exclude: ['src/tests/'] });
  assert.equal(parseOptimizeCliInput(['--project', 'project-1']).verificationMode, undefined);
  assert.throws(() => parseOptimizeCliInput(['--project', 'project-1', '--source-only', '--performance']), /不能/);
});

test('CLI and HTTP preflight reject source scopes outside source-only mode', async () => {
  const fixture = await startWebFixture();
  try {
    const project = fixture.projects.add({ name: 'Scope preflight', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
    const url = `${fixture.url}/v1/projects/${encodeURIComponent(project.project_id)}/check`;
    const headers = { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' };
    for (const body of [
      { function_name: 'kernel', candidate_scope: { include: ['kernel.c'], exclude: [] } },
      { function_name: 'kernel', verification_mode: 'verified', candidate_scope: { include: ['kernel.c'], exclude: [] } },
      { function_name: 'kernel', verification_mode: 'verified', candidate_scope: null },
    ]) {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      const error = await response.json() as { error: { code: string; message: string } };
      assert.equal(error.error.code, 'PROJECT_OPERATION_FAILED');
      assert.match(error.error.message, /仅适用于仅源码优化/);
    }
    const source = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ function_name: 'kernel', verification_mode: 'source_only',
      candidate_scope: { include: ['kernel.c'], exclude: ['tests/'] } }) });
    assert.equal(source.status, 200);
    assert.match((await source.json() as { message: string }).message, /允许修改：kernel\.c/);
    const verified = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ function_name: 'kernel', verification_mode: 'verified' }) });
    assert.equal(verified.status, 200, JSON.stringify(await verified.json()));

    for (const flag of ['--allow', '--exclude']) {
      const cli = await runFixtureCli(fixture.url, fixture.token, ['check', '--config', fixture.configPath, '--function', 'kernel', flag, 'kernel.c']);
      assert.equal(cli.code, 1);
      assert.match(cli.stderr, /仅适用于仅源码优化/);
      assert.doesNotMatch(cli.stdout, /检查通过/);
    }
    const cliSource = await runFixtureCli(fixture.url, fixture.token, ['check', '--config', fixture.configPath, '--function', 'kernel',
      '--source-only', '--allow', 'kernel.c', '--exclude', 'tests/']);
    assert.equal(cliSource.code, 0, cliSource.stderr);
    assert.match(cliSource.stdout, /允许修改：kernel\.c/);
    assert.match(cliSource.stdout, /排除：tests\//);
    const help = await runFixtureCli(fixture.url, fixture.token, ['check', '--help']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--allow \/ --exclude 仅用于 --source-only/);
    const projectCli = await runFixtureCli(fixture.url, fixture.token, ['project', 'check', project.project_id, '--allow', 'kernel.c']);
    assert.equal(projectCli.code, 1);
    assert.match(projectCli.stderr, /Unknown option|未知选项/i);
    const noIo = { print: () => {}, error: () => {}, prompt: async () => null, select: async <T>() => null as T | null, confirm: async () => false };
    const interactive = await runCommandArgs({} as WorkbenchContext, '/check', ['--allow', 'kernel.c'], noIo);
    assert.equal(interactive.ok, false);
    assert.match(interactive.message, /不接受参数/);
    assert.equal(fixture.modelRequests.inference, 0);
    assert.equal(fixture.service.list().length, 0);
  } finally { await fixture.close(); }
});

test('HTTP and CLI share an independent file comparison, its persisted identity, results and cancellation', async () => {
  const testing = createTestingFixture();
  const fixture = await startWebFixture({ testingService: testing.service });
  try {
    const api = new ApiClient(fixture.url, { token: fixture.token });
    const candidate = await testing.binary('candidate'), baseline = await testing.binary('baseline');
    const input = { machine_id: testing.machine.identity.machine_id, plan: testingPlanRef, mode: 'both' as const, candidate, baseline };
    const preview = (await api.testing.preview(testingPlanRef)).plan;
    const { task } = await api.testing.start({ ...input, expected_evaluator_digest: preview.evaluator.digest }, 'public-testing-1');
    await waitTestingPreparation(testing.service, task.task_id);
    assert.equal(testing.plans.length, 1);
    assert.equal((await api.testing.start({ ...input, expected_evaluator_digest: preview.evaluator.digest }, 'public-testing-1')).task.task_id, task.task_id);
    await assert.rejects(() => api.testing.start({ ...input, mode: 'performance' }, 'public-testing-1'), /请求标识|条件/);
    const cli = await runFixtureCli(fixture.url, fixture.token, ['test', 'status', task.task_id]);
    assert.equal(cli.code, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).task.task_id, task.task_id);
    assert.equal(JSON.parse(cli.stdout).task.execution.status, 'RUNNING');
    testing.complete(task);
    await api.testing.list();
    const projectedDeadline = Date.now() + 2000;
    while (testing.service.list()[0].execution.status !== 'SUCCEEDED' && Date.now() < projectedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(testing.service.list()[0].execution.status, 'SUCCEEDED', 'opening only the list must refresh Runner progress');
    const details = await api.testing.get(task.task_id);
    assert.equal(details.task.execution.status, 'SUCCEEDED');
    assert.equal(details.summary.correctness.status, 'PASSED');
    assert.equal(details.summary.performance.status, 'IMPROVED');
    assert.equal(details.formal_evidence, false);
    assert.equal(testing.projects.size, 0, 'file comparison must not create a source project');
    const second = (await api.testing.start({ ...input, mode: 'performance' })).task;
    await waitTestingPreparation(testing.service, second.task_id);
    testing.setStatus('RUNNING');
    testing.setMeasurements([]);
    const cancel = await runFixtureCli(fixture.url, fixture.token, ['test', 'cancel', second.task_id]);
    assert.equal(cancel.code, 0, cancel.stderr);
    assert.equal(JSON.parse(cancel.stdout).task.execution.cancel_requested, true);
    assert.equal(JSON.parse(cancel.stdout).task.execution.status, 'RUNNING');
    testing.setStatus('CANCELLED');
    assert.equal((await api.testing.get(second.task_id)).task.execution.status, 'CANCELLED');
    assert.equal(fixture.modelRequests.inference, 0);
  } finally { await fixture.close(); testing.close(); }
});
