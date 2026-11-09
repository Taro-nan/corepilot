import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { loadOptimizationConfig } from '../../src/config/optimization-config.js';
import { startWebFixture, runFixtureCli, repositoryRoot } from '../../tests/web-fixture.js';
import { startRunnerHttpServer } from '../../src/runner/http-server.js';
import { BaselineBundleService } from '../../src/application/baseline-bundle-service.js';
import { prepareReviewFixture } from '../../tests/validation-review-fixture.js';
import { ApiClient } from '../../src/client/api-client.js';
import { seedBlockedValidation } from '../../tests/validation-recovery-fixture.js';
import { seedApprovalFacts } from '../../tests/workflow-approval-fixture.js';
import { initialOptimizationWorkflowRecord } from '../../src/workflow/optimization-workflow.js';
import { prepareReproductionFixture } from '../../tests/reproduction-fixture.js';
import { DEFAULT_STATISTICS } from '../../src/contracts/performance-statistics.js';
import type { OptimizationWorkflowRecord } from '../../src/contracts/workflow.js';

let fixture: Awaited<ReturnType<typeof startWebFixture>>;
test.beforeEach(async () => { fixture = await startWebFixture({ execute: true }); });
test.afterEach(async () => { await fixture.close(); });

async function login(page: Page) {
  await page.goto(fixture.url);
  await page.getByLabel('管理员访问凭据').fill(fixture.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.locator('.sidebar')).toBeVisible();
}

/** Exercise legacy configuration capabilities through the retained deep link. */
async function openLegacyValidation(page: Page) {
  await page.evaluate(() => { location.hash = '#/validation'; });
  await expect(page.getByRole('heading', { name: '构建与验证', exact: true })).toBeVisible();
}

async function openTaskPreparation(page: Page) {
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const task = page.getByRole('dialog', { name: '创建优化任务' });
  await task.getByRole('radio', { name: /优化并自动验证/ }).check();
  await task.getByRole('button', { name: /准备构建与验证|查看或调整测试方案/ }).click();
  await expect(page.getByRole('region', { name: '当前任务准备上下文' })).toBeVisible();
}

/** Add explicit simulated verification facts; legacy mock execution has no Runner resource observations. */
async function addVerifiedFixtureExperiments(f: typeof fixture, workflowId: string) {
  await expect.poll(() => f.service.get(workflowId)?.status, { timeout: 45_000 }).toBe('WAITING_APPROVAL');
  await expect.poll(() => f.service.activeWorkflowIds().includes(workflowId), { timeout: 45_000 }).toBe(false);
  const workflow = f.service.get(workflowId)!;
  const original = f.store.listExperiments(workflow.optimization_task_id!).find(item => item.type === 'FORMAL_EVALUATION');
  expect(original?.evaluation?.correctness).toBe('PASSED');
  const timestamp = new Date().toISOString();
  const context = { machine: { machine_identity_sha256: 'a'.repeat(64), fixture: true }, resource_policy: { validity: 'VALID', fixture: true } };
  for (const type of ['FORMAL_EVALUATION', 'REVALIDATION'] as const) {
    f.store.createExperiment({ ...original!, experiment_id: `experiment:browser-fixture-${type}-${workflowId}`, type,
      status: 'SUCCEEDED', validity: 'VALID', failure_category: null, observed_context: context,
      created_at: timestamp, updated_at: timestamp, ended_at: timestamp });
  }
  workflow.updated_at = new Date(Date.now() + 1000).toISOString();
  f.store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  expect(f.service.report(workflowId)?.report.summary?.verification).toMatchObject({ ready: true, issues: [] });
  seedApprovalFacts(f, workflowId);
}

async function approveCurrentFixture(page: Page) {
  await page.getByRole('button', { name: '审阅与批准', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '人工审阅与源码交付' });
  await dialog.getByRole('button', { name: '准备审阅证据', exact: true }).click();
  await expect(dialog).toContainText('证据已冻结');
  const checkbox = await dialog.getByRole('checkbox', { name: /我已审阅源码/ }).boundingBox();
  expect(checkbox?.width).toBeLessThanOrEqual(20);
  expect(checkbox?.height).toBeLessThanOrEqual(20);
  fs.mkdirSync(path.join(repositoryRoot, 'build', 'frontend-audit'), { recursive: true });
  await page.screenshot({ path: path.join(repositoryRoot, 'build', 'frontend-audit', 'human-approval-fixture.png'), fullPage: true });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载冻结证据', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('corepilot-evidence.json.gz');
  await dialog.getByLabel('批准人').fill('Fixture Reviewer');
  await dialog.getByLabel('授权说明').fill('Fixture owner reviewed and explicitly authorized this candidate');
  await dialog.getByRole('checkbox', { name: /我已审阅源码/ }).check();
  await dialog.getByRole('button', { name: '记录人工批准', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '交付已批准候选', exact: true })).toBeVisible();
}

async function jumpToFolder(page: Page, directory: string) {
  const picker = page.getByRole('dialog', { name: '选择源码文件夹' });
  if (!await picker.getByLabel('文件夹路径', { exact: true }).isVisible()) await picker.getByRole('button', { name: '输入文件夹路径', exact: true }).click();
  await picker.getByLabel('文件夹路径', { exact: true }).fill(directory);
  await picker.getByLabel('文件夹路径', { exact: true }).press('Enter');
  await expect(picker.locator('.picker-selection strong')).toHaveText(directory);
}

test('customer report starts a clean Runner reproduction, persists results and downloads the identity manifest', async ({ page }) => {
  const f = fixture;
  const r = await prepareReproductionFixture(f);
  try {
    f.projects.add({ name: 'Reproducible delivery', repository_root: f.repo, config_path: f.configPath });
    await login(page);
    await page.getByRole('navigation').getByRole('button', { name: '优化报告', exact: true }).click();
    await page.locator('.workflow-list tbody tr').filter({ hasText: r.record.workflow_id }).getByRole('button', { name: '查看报告' }).click();
    const panel = page.locator('.customer-report-summary');
    await expect(panel).toContainText('尚无满足完整验证条件');
    await panel.locator('summary').filter({ hasText: '重建复现与身份清单' }).click();
    await panel.getByRole('button', { name: '在 Runner 重建复现', exact: true }).click();
    await expect.poll(() => f.service.get(r.record.workflow_id)?.reproduction?.status, { timeout: 25000 }).toBe('SUCCEEDED');
    await expect(panel).toContainText('重建复现：执行完成', { timeout: 15000 });
    await expect(panel).toContainText('执行目录');
    const downloaded = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载复现说明与身份清单' }).click();
    const file = await downloaded;
    const manifest = JSON.parse(fs.readFileSync((await file.path())!, 'utf8'));
    expect(manifest.source.commit).toBe(r.checkpoint.commit);
    expect(manifest.reproduction.experiment_id).toBe(f.service.get(r.record.workflow_id)?.reproduction?.experiment_id);
    expect(f.modelRequests.inference).toBe(0);
    await page.screenshot({ path: path.join(repositoryRoot, 'build/frontend-audit/customer-report-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(repositoryRoot, 'build/frontend-audit/customer-report-mobile.png'), fullPage: true });
  } finally { await f.service.reproductions.stop(); await r.runner.close(); }
});

test('overview cards, task filters, analysis and reports open the shared workflow data', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Task navigation', repository_root: f.repo, config_path: f.configPath });
  for (const item of [
    { id: 'review', functionName: 'kernel_review', branch: 'feature/review', status: 'WAITING_APPROVAL' },
    { id: 'delivered', functionName: 'kernel_delivered', branch: 'release', status: 'DELIVERABLE' },
    { id: 'failed', functionName: 'kernel_failed', branch: 'release', status: 'FAILED' },
  ] as const) {
    const record = initialOptimizationWorkflowRecord(`workflow:fixture-${item.id}`, { functionName: item.functionName, entryFile: null, configPath: f.configPath, repositoryRoot: f.repo, enablePerformance: true });
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify({ ...record, source_branch: item.branch, status: item.status, error: item.status === 'FAILED' ? 'fixture build failed' : null }));
  }
  await login(page);
  await page.getByRole('button', { name: '查看正在运行：0' }).click();
  await expect(page.getByLabel('筛选状态')).toHaveValue('running');
  await expect(page.getByText('没有匹配的任务，请调整筛选条件。')).toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: '查看已交付：1' }).click();
  await expect(page.getByLabel('筛选状态')).toHaveValue('delivered');
  await expect(page.locator('.workflow-list tbody')).toContainText('kernel_delivered');
  await page.getByRole('navigation').getByRole('button', { name: '项目概览', exact: true }).click();
  await expect(page.getByRole('button', { name: '查看待人工审阅：1' })).toBeVisible();
  await page.getByRole('button', { name: '查看待人工审阅：1' }).click();
  await expect(page.getByLabel('筛选状态')).toHaveValue('review');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(1);
  await expect(page.locator('.workflow-list tbody')).toContainText('kernel_review');
  await page.getByLabel('筛选状态').selectOption('success');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(2);
  await page.getByLabel('筛选分支').selectOption('feature/review');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(1);
  await page.getByLabel('搜索任务').fill('kernel_delivered');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(0);
  await page.getByLabel('筛选分支').selectOption('');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(1);
  await page.getByLabel('筛选状态').selectOption('failed');
  await page.getByLabel('搜索任务').fill('kernel_failed');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(1);

  await page.getByRole('navigation').getByRole('button', { name: '实验分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '可分析任务' })).toBeVisible();
  await expect(page.locator('.section-metrics')).toContainText('已有首轮实验');
  await page.getByRole('navigation').getByRole('button', { name: '优化报告', exact: true }).click();
  await expect(page.locator('.section-metrics')).toContainText('可查看任务报告');
  await page.locator('.workflow-list tbody tr').filter({ hasText: 'kernel_failed' }).getByRole('button', { name: '查看报告' }).click();
  await page.locator('summary').filter({ hasText: '完整文字报告' }).click();
  await expect(page.locator('.report-preview')).toContainText('kernel_failed');
  await page.locator('.detail-view-links').getByRole('button', { name: '任务详情' }).click();
  await expect(page.getByRole('heading', { name: '执行进度' })).toBeVisible();
  await expect(page.locator('.timeline-item')).toHaveCount(6);
  await page.locator('.timeline-item').nth(2).getByText('查看阶段证据').click();
  await expect(page.locator('.timeline-item').nth(2)).toContainText('正式实验开始后');

  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.locator('.section-nav').getByRole('button', { name: '构建与验证', exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation').getByRole('button', { name: '构建与验证', exact: true })).toHaveCount(0);
  await openLegacyValidation(page);
  await expect(page.getByRole('heading', { name: '构建与验证', exact: true })).toBeVisible();
  await expect(page.locator('.validation-layout')).toBeVisible();
  await expect(page.locator('.section-nav')).toHaveCount(0);
  await page.evaluate(() => { location.hash = '#/settings/validation'; });
  await expect(page.getByRole('heading', { name: '构建与验证', exact: true })).toBeVisible();
  await expect(page.locator('.validation-layout')).toBeVisible();
});

test('system validation failure offers frozen candidate retry without another model call', async ({ page }) => {
  await fixture.close(); fixture = await startWebFixture();
  const seeded = await seedBlockedValidation(fixture);
  await login(page);
  await page.getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('row').filter({ hasText: seeded.workflowId }).click();
  const panel = page.locator('.agent-session');
  await expect(panel.getByText('验证环境异常，候选已保留', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '继续优化', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '重新验证当前候选', exact: true }).click();
  await expect.poll(() => fixture.service.get(seeded.workflowId)?.status).toBe('WAITING_APPROVAL');
  await expect(page.locator('.page-heading .badge')).toHaveText('待人工审阅');
  expect(fixture.service.get(seeded.workflowId)?.candidate_id).toBe(seeded.candidate.candidate_id);
  expect(fixture.store.listExperiments(seeded.candidate.task_id)).toHaveLength(3);
  expect(fixture.modelRequests.inference).toBe(0);
});

test('inconclusive measurement is explained separately from an environment failure and preserves the same candidate', async ({ page }) => {
  await fixture.close(); fixture = await startWebFixture();
  const f = fixture;
  const packPath = loadOptimizationConfig(f.configPath).config.validation.testpack;
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  pack.performance.statistics = DEFAULT_STATISTICS;
  fs.writeFileSync(packPath, JSON.stringify(pack));
  const seeded = await seedBlockedValidation(f, true);
  await new ApiClient(f.url, { token: f.token }).retryOptimizationValidation(seeded.workflowId);
  await expect.poll(() => f.service.get(seeded.workflowId)?.status).toBe('VALIDATION_BLOCKED');
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('row').filter({ hasText: seeded.workflowId }).click();
  const panel = page.locator('.agent-session');
  await expect(panel.getByText('测量证据不足，候选已保留', { exact: true })).toBeVisible();
  await expect(panel).toContainText('不要重复试到通过');
  await expect(panel.getByRole('button', { name: '继续优化', exact: true })).toHaveCount(0);
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.get(seeded.workflowId)?.candidate_id).toBe(seeded.candidate.candidate_id);
});

test('latest valid evaluations replace the current warning while historical failures remain inspectable', async ({ page }) => {
  await fixture.close(); fixture = await startWebFixture();
  const seeded = await seedBlockedValidation(fixture);
  const original = fixture.store.getExperiment(seeded.experiment.experiment_id)!;
  const originalJson = JSON.stringify(original);
  const epoch = Date.now();
  // Explicit offline report fixtures; these are not hardware qualification results.
  for (const [index, type] of ['FORMAL_EVALUATION', 'REVALIDATION'].entries()) {
    const timestamp = new Date(epoch + index * 1000).toISOString();
    const experimentId = `experiment:fixture-passed-${index}`;
    fixture.store.createExperiment({ ...original, experiment_id: experimentId, type: type as 'FORMAL_EVALUATION' | 'REVALIDATION',
      status: 'SUCCEEDED', validity: 'VALID', failure_category: null, created_at: timestamp, updated_at: timestamp, ended_at: timestamp,
      evaluation: { build: 'PASSED', correctness: 'PASSED', performance: 'NOT_EXECUTED',
        correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true } } });
    fixture.store.appendMeasurement({ schema_version: 1, measurement_id: `measurement:fixture-passed-${index}`, experiment_id: experimentId,
      evaluator: original.evaluator, kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'c1', sample_index: null,
      value: 'PASS', unit: null, validity: 'VALID', domain_payload: { parameters: { size: 1, threads: 1 }, fixture: true }, recorded_at: timestamp });
  }
  const workflow = fixture.service.get(seeded.workflowId)!;
  workflow.status = 'WAITING_APPROVAL'; workflow.candidate_evaluation_feedback = null; workflow.candidate_evaluation_decision = null;
  delete workflow.stop_reason;
  fixture.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify(workflow));
  await login(page);
  await page.getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('row').filter({ hasText: seeded.workflowId }).click();
  await expect(page.getByText('最近一次验证尚未形成完整有效的结论', { exact: true })).toHaveCount(0);
  const experimentSummary = page.locator('summary').filter({ has: page.getByText('实验记录', { exact: true }) });
  await expect(experimentSummary).toContainText('含 1 次历史失败');
  await experimentSummary.click();
  await expect(page.getByText('当前候选存在无效或不完整的实验', { exact: true })).toHaveCount(0);
  const records = experimentSummary.locator('..');
  await expect(records).toContainText('历史实验记录已保留');
  await expect(records.getByRole('row')).toHaveCount(4);
  expect(JSON.stringify(fixture.store.getExperiment(seeded.experiment.experiment_id))).toBe(originalJson);

  // A later failed evaluation must not be hidden by a previously passed run.
  const later = new Date(epoch + 3000).toISOString();
  fixture.store.createExperiment({ ...original, experiment_id: 'experiment:fixture-latest-failure', created_at: later, updated_at: later, ended_at: later });
  await page.reload();
  await expect(page.getByText('最近一次验证尚未形成完整有效的结论', { exact: true })).toBeVisible();
  await expect(page.getByText('历史实验记录已保留', { exact: true })).toHaveCount(0);
});

test('Agent process records and continuation reuse the same workflow and evaluation contract', async ({ page }) => {
  await fixture.close();
  fixture = await startWebFixture({ execute: true, candidateRepair: true });
  const f = fixture;
  const project = f.projects.add({ name: 'Agent session fixture', repository_root: f.repo, config_path: f.configPath });
  const config = loadOptimizationConfig(f.configPath);
  const testpack = JSON.parse(fs.readFileSync(config.config.validation.testpack, 'utf8'));
  const release = path.join(f.root, 'allow-correctness');
  testpack.correctness.command.args = ['-e', `if(!require('fs').existsSync(${JSON.stringify(release)})){console.error('fixture case waits for release');process.exit(1)}console.log('fixture PASS')`];
  fs.writeFileSync(config.config.validation.testpack, JSON.stringify(testpack));
  const api = new ApiClient(f.url, { token: f.token });
  const submitted = await api.submitOptimizationWorkflow({ project_id: project.project_id, enable_performance: false, candidate_scope: { include: ['kernel.c'], exclude: [] }, budget: { max_candidates: 1, time_limit_ms: 60_000 } }) as { workflow_id: string };
  await expect.poll(() => f.service.get(submitted.workflow_id)?.status).toBe('BUDGET_EXHAUSTED');
  await login(page);
  await page.getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('row').filter({ hasText: submitted.workflow_id }).click();
  const panel = page.locator('.agent-session');
  await expect(panel.getByRole('heading', { name: 'Agent 工作过程' })).toBeVisible();
  await expect(panel.getByText('本次探索预算已用完', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('Agent 过程记录')).toContainText('提交候选验证');
  await panel.locator('summary').filter({ hasText: '过程记录' }).click();
  await panel.getByRole('button', { name: /修改源码/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('return 2');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  fs.writeFileSync(release, 'ready');
  const instruction = '保留已完成的调查，继续验证。' + '补'.repeat(10_000) + '要求结束标记';
  await panel.getByLabel('继续时的补充要求（可选）').fill(instruction);
  await panel.getByRole('button', { name: '继续优化', exact: true }).click();
  await expect.poll(() => f.service.get(submitted.workflow_id)?.status).toBe('WAITING_APPROVAL');
  expect(f.service.get(submitted.workflow_id)?.continuation_count).toBe(1);
  await expect(page.locator('.page-heading .badge')).toHaveText('待人工审阅');
  let cursor = 0, instructionRecorded = false;
  for (let page = 0; page < 20; page++) {
    const batch = await api.getOptimizationSessionEvents(submitted.workflow_id, cursor, 200);
    instructionRecorded ||= batch.events.some(event => event.role === 'user' && event.text.includes('保留已完成的调查') && event.text.includes('要求结束标记'));
    if (instructionRecorded || batch.next_cursor === cursor) break;
    cursor = batch.next_cursor;
  }
  expect(instructionRecorded).toBe(true);
  const instructionEvent = panel.getByRole('button', { name: /保留已完成的调查/ });
  await expect(instructionEvent).toBeVisible({ timeout: 15_000 });
  await instructionEvent.click();
  await expect(page.getByRole('dialog')).toContainText('要求结束标记');
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('agent-session.png'), fullPage: true });
});

test('branch baseline builds through Runner RPC, shows server directories and logs, and reuses its recorded settings', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true }); });
  const f = fixture;
  const workspace = path.join(f.root, 'runner-workspace'); fs.mkdirSync(workspace);
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'branch-browser-fixture',
    dbPath: path.join(f.root, 'branch-runner.sqlite'), workspaceRoot: workspace,
    toolchainProbe: async () => ({ runner_id: 'branch-fixture', checked_at: new Date().toISOString(), architecture: process.arch,
      platform: process.platform, available_parallelism: 2, cpu_count: 2, memory_total_bytes: 1024 ** 3, tools: {} }) });
  try {
    f.git('branch', 'fix/another-branch');
    const project = f.projects.add({ name: 'Branch build', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const machine = f.projects.machines.save({ name: 'Branch fixture CPU', runner: { mode: 'rpc', endpoint: runner.url, token: 'branch-browser-fixture' },
      target: { ssh_alias: 'fixture', workspace_root: workspace } });
    f.projects.bindMachine(project.project_id, machine.machine_id);
    const rawCmake = 'cmake -S . -B build -DCMAKE_CXX_FLAGS=-O2\ncmake --build build --target fixture -j2';
    const isolatedCmake = 'cmake -S "$COREPILOT_SOURCE_ROOT" -B "$COREPILOT_BUILD_ROOT" -DCMAKE_CXX_FLAGS=-O2\ncmake --build "$COREPILOT_BUILD_ROOT" --target fixture -j2';
    const discovered = await f.projects.discover(project.project_id, 'kernel', { command: rawCmake, cwd: '.' });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
      library_package: { package_id: discovered.evidence.generated.package_id, package_version: discovered.evidence.generated.version,
        target_id: discovered.targets[0].target_id }, baseline_artifact: '' } });
    await login(page);
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await openLegacyValidation(page);
    await page.getByText('本次基线构建设置', { exact: true }).click();
    const editor = page.getByLabel('基线构建命令', { exact: true });
    await expect(editor).toHaveValue(isolatedCmake);
    const release = path.join(f.root, 'release-browser-build');
    const script = `const fs=require("fs"),path=require("path");console.log("compile-start");const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);fs.writeFileSync(path.join(process.env.COREPILOT_BUILD_ROOT,"libfixture.so"),"browser-build-bytes");console.log("compile-done");},50)`;
    const command = `"${process.execPath.replaceAll('\\', '/')}" -e '${script}'`;
    await editor.fill(command);
    const createUrl = `**/v1/projects/${project.project_id}/validation-trials`;
    let postCount = 0;
    await page.route(createUrl, async route => {
      if (route.request().method() !== 'POST') { await route.fallback(); return; }
      postCount++;
      const response = await route.fetch(); expect(response.status()).toBe(202);
      await route.abort('failed');
    });
    await page.getByRole('button', { name: '在执行机器上构建这个分支', exact: true }).click();
    await expect(page.getByText('上次分支构建请求尚未确认', { exact: true })).toBeVisible();
    const savedRequests = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('corepilot-trial-request-v1')));
    expect(savedRequests).toHaveLength(1); expect(savedRequests[0][1]).toMatch(/^[a-f0-9-]{36}$/i);
    expect(JSON.stringify(savedRequests)).not.toContain(command);
    await page.reload();
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await openLegacyValidation(page);
    await expect(page.getByText('上次分支构建请求尚未确认', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '核对上次请求', exact: true }).click();
    expect(postCount).toBe(1);
    await page.unroute(createUrl);
    const trial = page.locator('.baseline-picker .validation-trial');
    await expect(trial).toContainText('正在构建');
    await expect(trial).toContainText('compile-start');
    await expect(trial.locator('.build-location')).toContainText('Branch fixture CPU');
    await expect(trial.locator('.build-location')).toContainText('/branches/main-');
    const record = f.projects.validationTrials.list(project)[0];
    expect(record.source_commit).toBe(f.git('rev-parse', 'HEAD'));
    expect(fs.existsSync(record.remote_workspace!.source_root)).toBe(true);
    let lookupUnknown = true;
    const trialUrl = `**/v1/projects/${project.project_id}/validation-trials/*`;
    await page.route(trialUrl, async route => {
      if (!lookupUnknown) { await route.fallback(); return; }
      await route.fulfill({ json: { trial: record, status: { status: 'UNKNOWN', failure: { message: '请核对原构建' } }, commands: [], output: null } });
    });
    await expect(trial).toContainText('状态待核对');
    lookupUnknown = false;
    await trial.getByRole('button', { name: '核对原构建状态' }).click();
    await expect(trial).toContainText('正在构建');
    expect(f.projects.validationTrials.list(project)).toHaveLength(1);
    await page.unroute(trialUrl);
    fs.writeFileSync(release, 'finish');
    await expect(trial).toContainText('构建完成');
    await expect(page.getByLabel('本次构建产物', { exact: true })).toHaveValue('build/libfixture.so');
    await expect(page.getByRole('button', { name: '固定这次构建为比较基线', exact: true })).toBeEnabled();
    expect(fs.readFileSync(path.join(record.remote_workspace!.artifacts_root, 'build', 'libfixture.so'), 'utf8')).toBe('browser-build-bytes');
    expect(JSON.parse(fs.readFileSync(record.remote_workspace!.metadata_path, 'utf8')).experiment.status).toBe('SUCCEEDED');
    expect(f.projects.config(project.project_id).validation.baseline_artifact).toBeFalsy();
    const cli = await runFixtureCli(f.url, f.token, ['project', 'trial-status', project.project_id, record.trial_id]);
    expect(cli.code, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout).trial.remote_workspace).toEqual(record.remote_workspace);
    await page.getByLabel('用作基线的本地 Git 分支', { exact: true }).selectOption('fix/another-branch');
    await expect(editor).toHaveValue(isolatedCmake, { timeout: 5000 });
    await expect(trial).toHaveCount(0);
    await page.getByLabel('用作基线的本地 Git 分支', { exact: true }).selectOption('main');
    await expect(editor).toHaveValue(command);
    await expect(trial).toContainText('构建完成');
    await page.reload();
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await openLegacyValidation(page);
    await page.getByText('本次基线构建设置', { exact: true }).click();
    await expect(page.getByLabel('基线构建命令', { exact: true })).toHaveValue(command);
    await expect(page.getByLabel('查看构建记录', { exact: true })).toHaveValue(record.trial_id);
    expect(f.git('status', '--porcelain')).toBe('');
  } finally { await runner.close(); }
});

test('external baseline import explains one source, resumes failed checks and replaces only after explicit binding', async ({ page }) => {
  const f = fixture;
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'import-browser-fixture',
    dbPath: path.join(f.root, 'import-runner.sqlite'), workspaceRoot: f.root,
    toolchainProbe: async () => ({ runner_id: 'fixture', checked_at: new Date().toISOString(), architecture: process.arch,
      platform: process.platform, available_parallelism: 2, cpu_count: 2, memory_total_bytes: 1024 ** 3, tools: {} }) });
  try {
    const project = f.projects.add({ name: 'External import', repository_root: f.repo, config_path: f.configPath });
    const machine = f.projects.machines.save({ name: 'Import fixture CPU', runner: { mode: 'rpc', endpoint: runner.url, token: 'import-browser-fixture' },
      target: { ssh_alias: 'fixture', workspace_root: '/fixture' } });
    f.projects.bindMachine(project.project_id, machine.machine_id);
    await f.projects.machines.check(machine.machine_id);
    const hardware = f.projects.machines.get(machine.machine_id).hardware!;
    const discovery = await f.projects.discover(project.project_id, 'kernel');
    const packageId = discovery.evidence.generated.package_id, version = discovery.evidence.generated.version, targetId = discovery.targets[0].target_id;
    const previousFile = path.join(f.root, 'previous.so'); fs.writeFileSync(previousFile, 'previous baseline');
    const { createHash } = await import('node:crypto');
    const previousHash = createHash('sha256').update('previous baseline').digest('hex');
    await f.projects.validationAssets.bindSingleBaseline(project, packageId, version, targetId, { artifactPath: previousFile, sha256: previousHash,
      library: 'Own library', versionLabel: 'git:previous', source: { kind: 'branch', detail: 'main', sourceCommit: f.git('rev-parse', 'HEAD') } });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
      library_package: { package_id: packageId, package_version: version, target_id: targetId }, baseline_artifact: previousFile } });
    (f.projects as unknown as { baselineBundles: BaselineBundleService }).baselineBundles = new BaselineBundleService(f.dataDir, f.projects.machines, f.projects.validationAssets, async input => {
      const ok = input.files.some(file => file.path === 'librequired.so');
      const libraries = input.files.filter(file => /\.so$/.test(file.path));
      return { ok, machine_identity_sha256: hardware.machine_identity_sha256, checked_at: new Date().toISOString(),
        entry_sha256: input.files.find(file => file.path === input.entryPath)!.sha256,
        libraries: libraries.map(file => ({ path: file.path, soname: path.basename(file.path), sha256: file.sha256,
          elf: { class: 'ELF64', endian: 'little', machine: 'AArch64', build_id: 'fixture' }, needed: [] })),
        resolved_libraries: libraries.map(file => ({ soname: path.basename(file.path), path: path.join(input.localRoot, file.path), sha256: file.sha256 })),
        issues: ok ? [] : ['lib/libexternal.so: 缺少依赖 librequired.so'] };
    });
    const folder = path.join(f.root, 'external'); fs.mkdirSync(path.join(folder, 'lib'), { recursive: true }); fs.mkdirSync(path.join(folder, 'include'));
    fs.writeFileSync(path.join(folder, 'lib/libexternal.so'), 'main external library'); fs.writeFileSync(path.join(folder, 'lib/libunused.so'), 'additional library');
    fs.writeFileSync(path.join(folder, 'include/external.h'), 'void external(void);'); fs.writeFileSync(path.join(folder, 'README.txt'), 'documentation');
    const supplement = path.join(f.root, 'librequired.so'); fs.writeFileSync(supplement, 'required dependency');
    await login(page);
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await openLegacyValidation(page);
    await expect(page.locator('.current-baseline')).toContainText('Own library');
    await expect(page.getByLabel('比较库名称', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '更换比较基线', exact: true }).click();
    await page.getByRole('radio', { name: /导入外部库/ }).check();
    await expect(page.getByRole('button', { name: '在执行机器上构建这个分支', exact: true })).toBeHidden();
    await page.getByLabel('比较库名称', { exact: true }).fill('External fixture');
    await page.getByLabel('比较库版本', { exact: true }).fill('3.0');
    await page.getByLabel('选择已解包的库文件夹').setInputFiles(folder);
    await expect(page.locator('.baseline-file-summary')).toContainText('2 个动态库 · 1 个头文件');
    await page.getByRole('button', { name: '上传所选文件', exact: true }).click();
    await expect(page.getByLabel('用于对比的入口库', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: '替换当前比较基线', exact: true })).toBeDisabled();
    await page.getByLabel('用于对比的入口库', { exact: true }).selectOption('lib/libexternal.so');
    await page.getByRole('button', { name: '在执行机器上检查兼容性', exact: true }).click();
    await expect(page.locator('.baseline-bundle-issues')).toContainText('缺少依赖 librequired.so');
    expect(f.projects.config(project.project_id).validation.baseline_artifact).toBe(previousFile);
    await page.reload();
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await page.getByRole('button', { name: '手动输入模型 ID', exact: true }).click();
    await page.getByLabel('模型 ID').fill('unsaved-model-draft');
    await openLegacyValidation(page);
    await page.getByRole('button', { name: '更换比较基线', exact: true }).click();
    await page.getByRole('radio', { name: /导入外部库/ }).check();
    await expect(page.locator('.baseline-bundle-issues')).toContainText('缺少依赖 librequired.so');
    await expect(page.getByLabel('用于对比的入口库', { exact: true })).toHaveValue('lib/libexternal.so');
    await page.getByLabel('选择外部库文件').setInputFiles(supplement);
    await page.getByRole('button', { name: '上传补充文件', exact: true }).click();
    await page.getByRole('button', { name: '在执行机器上检查兼容性', exact: true }).click();
    await expect(page.locator('.baseline-inspection')).toContainText('目标机检查通过，等待固定');
    expect(f.projects.config(project.project_id).validation.baseline_artifact).toBe(previousFile);
    await page.locator('.baseline-picker').screenshot({ path: path.join(repositoryRoot, 'build/external-baseline-flow-20261027.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '替换当前比较基线', exact: true }).click();
    await expect(page.locator('.current-baseline')).toContainText('External fixture');
    await expect(page.locator('.current-baseline')).toContainText('3 个库 · 1 个头文件');
    await expect(page.getByLabel('比较库名称', { exact: true })).toHaveCount(0);
    expect(f.projects.config(project.project_id).validation.baseline_artifact).not.toBe(previousFile);
    expect(f.projects.config(project.project_id).model.model_id).toBe('fixture-model');
    await expect(page.locator('.config-state').first()).toContainText('有未保存的更改');
    await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
    await expect(page.getByLabel('模型 ID')).toHaveValue('unsaved-model-draft');
    expect(f.projects.packageLoader.resolveSelection({ package_id: packageId, package_version: version, target_id: targetId }).bundle.qualification.status).toBe('DRAFT');
    expect(f.modelRequests.inference).toBe(0);
  } finally { await runner.close(); }
});

test('browser configures, optimizes, reports and delivers through the same CLI backend', async ({ page }) => {
  const f = fixture;
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(f.url);
  await page.getByLabel('管理员访问凭据').fill(f.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('heading', { name: '从一个项目开始' })).toBeVisible();
  await page.getByRole('button', { name: '添加第一个项目' }).click();
  await page.getByLabel('项目名称').fill('CorePilot Integration');
  await page.getByLabel('服务器上的源码目录').fill(f.repo);
  await page.getByText('导入已有 CorePilot 配置（可选）', { exact: true }).click();
  await page.getByLabel('CorePilot 配置文件路径').fill(f.configPath);
  await page.getByRole('dialog').getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CorePilot Integration' })).toBeVisible();
  const list = await runFixtureCli(f.url, f.token, ['project', 'list']);
  expect(list.code, list.stderr).toBe(0);
  const projectId = JSON.parse(list.stdout).projects[0].project_id;
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByLabel(/^API Key/)).toHaveValue('[redacted]');
  await expect(page.locator('.model-discovery')).toContainText('已加载 1 个模型');
  await expect(page.getByLabel('模型 ID').getByRole('option', { name: 'fixture-model', exact: true })).toHaveCount(1);
  await page.locator('.model-advanced > summary').click();
  await page.getByRole('button', { name: '验证工具调用' }).click();
  await expect(page.getByRole('status')).toContainText('模型工具调用验证通过');
  await page.getByRole('button', { name: '高级配置', exact: true }).click();
  const editor = page.getByLabel('高级配置 JSON');
  const oldConfig = await editor.inputValue();
  await editor.fill('{invalid');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('JSON');
  await editor.fill(oldConfig);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  await page.getByRole('dialog', { name: '创建优化任务' }).getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await page.getByRole('dialog', { name: '创建优化任务' }).getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(page.locator('dialog .check-output')).toContainText('输入检查通过');
  const baseline = f.git('rev-parse', 'HEAD');
  await page.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'kernel', exact: true })).toBeVisible();
  const workflowId = f.service.list()[0].workflow_id;
  await addVerifiedFixtureExperiments(f, workflowId);
  await page.reload();
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toBeVisible();
  expect(f.service.get(workflowId)?.status).toBe('WAITING_APPROVAL');
  expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
  await expect(page.locator('.performance-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.customer-report-summary .result-facts')).toContainText('2.000×');
  await page.getByRole('button', { name: '查看源码差异', exact: true }).click();
  await expect(page.locator('dialog')).toContainText('+int kernel(void) { return 2; }');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '实验分析', exact: true }).click();
  await expect(page.locator('summary').filter({ hasText: '逐用例与原始数据' })).toBeVisible();
  await page.getByRole('button', { name: '优化报告', exact: true }).click();
  await page.locator('summary').filter({ hasText: '完整文字报告' }).click();
  await expect(page.locator('.report-preview')).toContainText('原始样本');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载 JSON 报告', exact: true }).click();
  const download = await downloadPromise;
  const downloaded = JSON.parse(fs.readFileSync((await download.path())!, 'utf8'));
  const cliReport = await runFixtureCli(f.url, f.token, ['workflow', 'report', workflowId, '--json']);
  expect(cliReport.code, cliReport.stderr).toBe(0);
  expect(JSON.parse(cliReport.stdout).experiments).toEqual(downloaded.experiments);
  expect(downloaded.candidates[0].approval).toBeNull();
  await page.getByRole('button', { name: '优化任务', exact: true }).click();
  const second = await runFixtureCli(f.url, f.token, ['optimize', '--project', projectId, '--performance', '--allow', 'kernel.c']);
  expect(second.code, second.stderr).toBe(0);
  const secondId = second.stdout.match(/workflow:[\w-]+/)![0];
  await addVerifiedFixtureExperiments(f, secondId);
  await expect(page.locator('.workflow-list tbody tr').filter({ hasText: secondId })).toBeVisible();
  await page.locator('.workflow-list tbody tr').filter({ hasText: secondId }).getByRole('button', { name: '查看任务' }).click();
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toBeVisible({ timeout: 45_000 });
  await page.getByRole('button', { name: '优化任务', exact: true }).click();
  await page.locator('.workflow-list tbody tr').filter({ hasText: workflowId }).getByRole('button', { name: '查看任务' }).click();
  await page.screenshot({ path: path.join(repositoryRoot, 'build', 'web-workbench-fixture.png'), fullPage: true });
  await approveCurrentFixture(page);
  expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
  expect(f.store.getCandidateApproval(f.service.get(workflowId)!.candidate_id!)?.reviewer).toBe('Fixture Reviewer');
  await page.getByRole('button', { name: '交付已批准候选', exact: true }).click();
  await page.getByLabel('合并提交说明').fill('Approve fixture optimization after review');
  let staleApproval = true;
  await page.route('**/v1/workflows/*/approve', async route => {
    if (staleApproval) await route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), expected_baseline_commit: '0'.repeat(40) }) });
    else {
      // Commit on the real fixture backend, then lose the successful response.
      const delivered = await route.fetch(); expect(delivered.status()).toBe(200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'RESPONSE_LOST', message: 'fixture: response lost after delivery' } }) });
    }
  });
  const rejected = page.waitForResponse(r => r.url().endsWith('/approve') && r.status() === 409);
  await page.getByRole('button', { name: '确认交付并合并', exact: true }).click();
  await rejected;
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  expect(f.git('rev-parse', 'HEAD')).toBe(baseline);
  staleApproval = false;
  fs.writeFileSync(path.join(f.repo, 'private-staged.c'), '// unrelated staged work\n');
  f.git('add', 'private-staged.c');
  const stagedBeforeDelivery = f.git('diff', '--cached', '--binary');
  fs.writeFileSync(path.join(f.repo, 'include', 'kernel.h'), 'int kernel(void);\n// unrelated local header edit\n');
  fs.mkdirSync(path.join(f.repo, 'analysis')); fs.writeFileSync(path.join(f.repo, 'analysis', 'notes.txt'), 'keep private notes');
  await expect(page.getByRole('dialog')).toContainText('交付提交只包含已验证的候选');
  await page.getByRole('button', { name: '确认交付并合并', exact: true }).click();
  await expect(page.locator('.title-row .badge')).toContainText('已交付');
  const status = await runFixtureCli(f.url, f.token, ['workflow', 'status', workflowId, '--json']);
  expect(JSON.parse(status.stdout).workflow.status).toBe('DELIVERABLE');
  expect(fs.readFileSync(path.join(f.repo, 'kernel.c'), 'utf8')).toContain('return 2');
  expect(f.git('rev-parse', 'HEAD^{tree}')).toBe(f.service.get(workflowId)!.candidate_tree);
  expect(f.git('diff', '--cached', '--binary')).toBe(stagedBeforeDelivery);
  expect(f.git('ls-tree', '--name-only', 'HEAD', 'private-staged.c')).toBe('');
  expect(fs.readFileSync(path.join(f.repo, 'include', 'kernel.h'), 'utf8')).toContain('unrelated local header edit');
  expect(fs.readFileSync(path.join(f.repo, 'analysis', 'notes.txt'), 'utf8')).toBe('keep private notes');
  expect(errors).toEqual([]);
});

test('fresh project setup and responsive layouts have usable controls and no page overflow', async ({ page }) => {
  const f = fixture;
  await page.goto(f.url);
  await page.getByLabel('管理员访问凭据').fill(f.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByRole('button', { name: '添加第一个项目' }).click();
  await page.getByLabel('项目名称').fill('Fresh project');
  await page.getByLabel('服务器上的源码目录').fill(f.repo);
  await page.getByRole('dialog').getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByLabel('模型 ID')).toHaveValue('configure-model');
  for (const width of [1920, 1440, 1366, 900, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel('模型 ID')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await openLegacyValidation(page);
    await expect(page.getByLabel('构建命令', { exact: true })).toHaveCount(0);
    await expect(page.locator('.setup-current-build')).toContainText('尚未选择构建命令');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '进入工作台' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('管理员访问凭据')).toHaveValue('');
});

test('new project preflight explains missing validation and keeps incomplete setup saveable', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Incomplete setup', repository_root: f.repo, source_branch: 'main' });
  await login(page);
  await page.locator('summary').filter({ hasText: '项目详情与诊断' }).click();
  await page.getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('尚未配置测试方案');
  await expect(page.getByRole('alert')).not.toContainText('ENOENT');
  await page.getByRole('button', { name: '检查构建与验证', exact: true }).click();
  await expect(page.getByRole('heading', { name: '构建与验证', exact: true })).toBeVisible();
  await expect(page.getByLabel('验证模式', { exact: true })).toHaveValue('new');
  await expect(page.getByLabel('构建命令', { exact: true })).toHaveCount(0);
  let formalChecks = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/check')) formalChecks++; });
  await page.getByRole('button', { name: '保存并运行前检查', exact: true }).click();
  await expect(page.locator('.setup-check-pending')).toContainText('尚未建立本次优化的验证方案');
  await expect(page.locator('.setup-check-pending')).toContainText('无需手写 testpack 文件');
  await expect(page.getByRole('button', { name: '开始识别本库源码', exact: true })).toBeVisible();
  expect(formalChecks).toBe(0);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  const missing = path.join(f.repo, 'testpacks', 'domain.yaml');
  await page.getByLabel('验证模式', { exact: true }).selectOption('testpack');
  const testpack = page.getByLabel('测试方案文件（testpack）');
  await expect(testpack).toHaveValue('');
  await testpack.fill(missing);
  await page.getByRole('button', { name: '保存并运行前检查', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('测试方案文件不存在');
  await expect(page.getByRole('alert')).toContainText('构建与验证');
  await expect(page.getByRole('alert')).not.toContainText('ENOENT');
  await testpack.fill('');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  expect(f.projects.config(f.projects.list()[0].project_id).validation.testpack).toBe('');
  expect(f.service.list()).toHaveLength(0);
  expect(fs.existsSync(missing)).toBe(false);
});

test('preflight lets a project resume its own draft and explains remaining work without a missing-testpack loop', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Resume draft', repository_root: f.repo });
  const discovery = await f.projects.discover(project.project_id, 'kernel');
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await page.getByRole('button', { name: '项目信息', exact: true }).click();
  await page.getByRole('button', { name: '前往构建与验证', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本项目已有接入草稿', exact: true })).toBeVisible();
  expect(f.projects.config(project.project_id).validation.library_package).toBeUndefined();
  await page.getByRole('button', { name: '保存并运行前检查', exact: true }).click();
  await expect(page.getByRole('button', { name: '继续本项目已有草稿', exact: true })).toBeVisible();
  const key = `${discovery.evidence.generated.package_id}@${discovery.evidence.generated.version}:${discovery.targets[0].target_id}`;
  const choices = page.getByLabel('继续哪个函数的接入草稿', { exact: true });
  await expect(choices.locator('option')).toHaveCount(2);
  await choices.selectOption(key);
  await page.getByRole('button', { name: '继续完善所选草稿', exact: true }).click();
  await expect(page.getByLabel('优化目标', { exact: true })).toHaveValue(discovery.targets[0].target_id);
  await expect(page.getByRole('tab', { name: '1 测试条件' })).toBeVisible();
  let formalChecks = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/check')) formalChecks++; });
  await page.getByRole('button', { name: '保存并运行前检查', exact: true }).click();
  await expect(page.locator('.setup-check-pending')).toContainText('验证草稿还需完善');
  await expect(page.locator('.setup-check-pending')).toContainText('上传或编辑正确性与性能脚本');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const saved = f.projects.config(project.project_id);
  expect(saved.validation.library_package?.target_id).toBe(discovery.targets[0].target_id);
  expect(f.projects.packageLoader.resolveSelection(saved.validation.library_package!).bundle.qualification.status).toBe('DRAFT');
  expect(formalChecks).toBe(0);
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
});

test('first-use settings explain project setup and invalid paths stay visible inside the dialog', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '添加项目后即可配置模型与机器' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '优化任务', exact: true })).toHaveCount(0);
  await page.getByRole('main').getByRole('button', { name: '添加项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加源码项目' });
  await dialog.getByLabel('项目名称').fill('Path error');
  await dialog.getByLabel('服务器上的源码目录').fill(path.join(fixture.root, 'does-not-exist'));
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('找不到源码目录');
  await dialog.getByLabel('服务器上的源码目录').fill(fixture.repo);
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Path error' })).toBeVisible();
});

test('a new library discovers its own assets and confirms commands and targets without selecting an unrelated package', async ({ page }) => {
  const f = fixture;
  const root = path.join(f.root, 'signal-library');
  for (const directory of ['include', 'src', 'tests', 'benchmarks']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'CMakeLists.txt'), 'project(signal LANGUAGES C)\n');
  fs.writeFileSync(path.join(root, 'include/signal.h'), 'int helper_status(void);\nint windowed_sum(void);\nint windowed_max(void);\n');
  fs.writeFileSync(path.join(root, 'src/windowed_signal.c'), 'int helper_status(void) { return 0; }\nint windowed_sum(void) { return 1; }\nint windowed_max(void) { return 2; }\n');
  fs.writeFileSync(path.join(root, 'tests/signal.c'), 'int main(void) { return 0; }\n');
  fs.writeFileSync(path.join(root, 'benchmarks/signal.c'), 'int main(void) { return 0; }\n');
  const project = f.projects.add({ name: 'Signal processing', repository_root: root });
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'build-browser-secret', dbPath: path.join(f.root, 'build-runner.sqlite'), workspaceRoot: path.join(f.root, 'build-runner'),
    toolchainProbe: async () => ({ runner_id: runner.runnerId, checked_at: new Date().toISOString(), architecture: process.arch, platform: 'linux', available_parallelism: 4, cpu_count: 8, memory_total_bytes: 16 * 1024 ** 3,
      tools: Object.fromEntries(['cmake', 'gcc', 'g++', 'clang', 'clang++', 'make', 'ninja', 'meson', 'cargo', 'rustc', 'go', 'python3', 'bash'].map(name => [name, { status: ['cmake', 'gcc', 'g++', 'make', 'ninja', 'bash'].includes(name) ? 'AVAILABLE' : 'MISSING', version: name === 'cmake' ? 'cmake version 3.19.2' : null }])) }) });
  const machine = f.projects.machines.save({ name: 'Build fixture CPU', runner: { mode: 'rpc', endpoint: runner.url, token: 'build-browser-secret' }, target: { ssh_alias: 'fixture', workspace_root: '/tmp/build' } });
  f.projects.bindMachine(project.project_id, machine.machine_id);
  try {
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await page.getByRole('button', { name: '项目信息', exact: true }).click();
  await page.getByRole('button', { name: '前往构建与验证', exact: true }).click();
  await expect(page.getByLabel('验证模式', { exact: true })).toHaveValue('new');
  await expect(page.locator('.setup-explanation')).toContainText('使用独立参考检查计算结果');
  await expect(page.getByLabel('测试方案文件（testpack）')).toHaveCount(0);
  await page.getByRole('button', { name: '识别源码与测试资产', exact: true }).click();
  await expect(page.locator('.setup-build').first()).toContainText('还没有实际构建执行记录');
  await expect(page.locator('.setup-build').last()).toContainText('cmake -S . -B .corepilot-build');
  await expect(page.locator('.setup-build').last()).toContainText('Build fixture CPU');
  await expect(page.locator('.setup-asset-grid')).toContainText('正确性测试线索 · 1');
  await expect(page.locator('.setup-asset-grid')).toContainText('性能测试线索 · 1');
  await page.getByRole('button', { name: '使用推荐命令', exact: true }).click();
  await expect(page.locator('.setup-current-build')).toContainText('cmake -S . -B .corepilot-build');
  await expect(page.getByLabel('构建命令', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '自定义构建', exact: true }).click();
  const command = 'cmake -S . -B build -DCMAKE_BUILD_TYPE=Release\ncmake --build build --parallel 2';
  await page.getByLabel('构建命令', { exact: true }).fill(command);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  const build = loadOptimizationConfig(project.config_path).config.build;
  expect(build.executable).toBe('bash');
  expect(build.args).toEqual(['-e', '-o', 'pipefail', '-c', command]);
  const functionSearch = page.getByLabel('搜索函数、头文件或实现文件');
  await functionSearch.fill('windowed_');
  await expect(page.getByLabel('选择函数 windowed_sum')).toBeVisible();
  await expect(page.getByLabel('选择函数 windowed_max')).toBeVisible();
  await expect(page.locator('.setup-function-info strong')).toHaveText(['windowed_sum', 'windowed_max', 'helper_status']);
  await page.getByRole('button', { name: '选中显示的 3 项' }).click();
  await expect(page.getByText('已选 3 / 50')).toBeVisible();
  await page.getByRole('button', { name: '清空已选' }).click();
  await page.getByRole('button', { name: '选中筛选结果' }).click();
  await page.getByLabel('选择函数 helper_status').uncheck();
  await expect(page.getByText('已选 2 / 50')).toBeVisible();
  await page.getByRole('button', { name: '已选函数 · 2' }).click();
  await functionSearch.fill('sum');
  await expect(page.getByLabel('选择函数 windowed_max')).toHaveCount(0);
  await functionSearch.fill('');
  await expect(page.getByLabel('选择函数 windowed_max')).toBeChecked();
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await openLegacyValidation(page);
  await expect(page.getByLabel('选择函数 windowed_sum')).toBeChecked();
  await expect(page.getByLabel('选择函数 windowed_max')).toBeChecked();
  await page.getByRole('button', { name: '生成本库接入草稿', exact: true }).click();
  await expect(page.locator('.setup-draft')).toContainText('2 个目标待审阅');
  const generated = f.projects.catalog().find(item => item.package_id === `project-${project.project_id.slice(0, 8)}`)!;
  expect(generated.qualification).toMatchObject({ state: 'DRAFT' });
  expect(generated.functions.map(item => item.api).sort()).toEqual(['windowed_max', 'windowed_sum']);
  expect(generated.targets).toHaveLength(2);
  await expect(page.getByLabel('验证模式', { exact: true })).toHaveValue('package');
  await expect(page.getByLabel('库接入方案', { exact: true })).toHaveValue(`${generated.package_id}@${generated.version}`);
  await expect(page.getByLabel('优化目标', { exact: true })).toHaveValue(generated.targets[0].target_id);
  await page.getByLabel('优化目标', { exact: true }).selectOption(generated.targets[1].target_id);
  await expect(page.getByText('准备当前函数的测试方案', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  await page.getByRole('button', { name: '查看测试代码', exact: true }).click();
  await page.getByLabel('正确性测试脚本', { exact: true }).fill('#!/bin/sh\necho "review required" >&2\nexit 1\n');
  await page.getByRole('button', { name: '保存测试方案草稿', exact: true }).click();
  await expect(page.getByText('测试方案草稿已保存', { exact: false })).toBeVisible();
  await expect(page.getByLabel('比较基线文件', { exact: true })).toHaveValue('');
  // Browser folder selection uploads actual bytes through the same API as CLI; a failed closure must stay visible.
  (f.projects as unknown as { baselineBundles: BaselineBundleService }).baselineBundles =
    new BaselineBundleService(f.dataDir, f.projects.machines, f.projects.validationAssets, async input => ({
      ok: false, machine_identity_sha256: 'a'.repeat(64), checked_at: new Date().toISOString(),
      entry_sha256: input.files.find(file => file.path === input.entryPath)!.sha256,
      libraries: [], resolved_libraries: [], issues: ['libfixture.so: 缺少依赖 librequired.so'],
    }));
  const bundleFolder = path.join(f.root, 'external-binary');
  fs.mkdirSync(path.join(bundleFolder, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(bundleFolder, 'lib', 'libfixture.so'), 'fixture ELF bytes');
  await page.getByRole('radio', { name: /导入外部库/ }).check();
  await page.getByLabel('比较库名称', { exact: true }).fill('External fixture');
  await page.getByLabel('比较库版本', { exact: true }).fill('1.0');
  await page.getByLabel('选择已解包的库文件夹').setInputFiles(bundleFolder);
  await page.getByRole('button', { name: '上传所选文件', exact: true }).click();
  await expect(page.getByLabel('用于对比的入口库', { exact: true })).toHaveValue('lib/libfixture.so');
  await page.getByRole('button', { name: '在执行机器上检查兼容性', exact: true }).click();
  await expect(page.locator('.baseline-bundle-issues')).toContainText('缺少依赖 librequired.so');
  await expect(page.getByLabel('比较基线文件', { exact: true })).toHaveValue('');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fs.readFileSync(path.join(root, 'src/windowed_signal.c'), 'utf8')).toContain('return 1');
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
  } finally { await runner.close(); }
});

test('test preparation preserves user conditions through AI generation and provides actual script/package downloads', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Testing plan', repository_root: f.repo, config_path: f.configPath });
  const discovery = await f.projects.discover(project.project_id, 'kernel');
  const packageId = discovery.evidence.generated.package_id, version = discovery.evidence.generated.version, targetId = discovery.targets[0].target_id;
  f.readyValidation(project, packageId, version, targetId);
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: packageId, package_version: version, target_id: targetId }, baseline_artifact: '' } });
  await login(page);
  await openTaskPreparation(page);
  await expect(page.getByRole('tab', { name: '1 测试条件' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('固定随机种子', { exact: true })).not.toBeVisible();
  await page.getByText('高级：原有单一资源配置', { exact: true }).click();
  await page.getByLabel('CPU 集合', { exact: true }).fill('0');
  await page.locator('.sampling-advanced > summary').click();
  await page.getByLabel('固定随机种子', { exact: true }).fill('42');
  await page.getByLabel('每端采样次数', { exact: true }).fill('5');
  await page.locator('.test-inventory').filter({ has: page.locator('strong', { hasText: '性能负载' }) }).locator('summary').filter({ hasText: '添加输入参数' }).click();
  await page.getByLabel('性能负载新增参数名').fill('length');
  await page.locator('.test-inventory').filter({ has: page.locator('strong', { hasText: '性能负载' }) }).getByRole('button', { name: '添加输入参数', exact: true }).click();
  await page.getByLabel('性能负载 1 length', { exact: true }).fill('64');
  await page.getByRole('button', { name: '保存条件并准备测试代码', exact: true }).click();
  await page.getByRole('button', { name: '用 AI 生成正确性代码', exact: true }).click();
  await expect(page.getByText('AI 测试代码已生成', { exact: false })).toBeVisible();
  const program = page.getByLabel('support/test-correctness.py', { exact: true });
  await expect(program).toBeVisible();
  await expect(program).toContainText('ctx.load_library()');
  await page.getByText('查看本次生成的代码草稿', { exact: true }).click();
  await expect(page.locator('.generated-code-preview')).toContainText('ctx.emit_correctness');
  const scriptDownload = page.waitForEvent('download');
  await page.locator('.test-code-card').first().getByRole('button', { name: '下载正确性代码', exact: true }).click();
  const downloadedProgram = await scriptDownload;
  expect(downloadedProgram.suggestedFilename()).toBe('test-correctness.py');
  expect(fs.readFileSync((await downloadedProgram.path())!, 'utf8')).toContain('ctx.emit_correctness');
  const reviewedProgram = (await program.inputValue()) + '\n# Reviewed in the primary test-code editor\n';
  await program.fill(reviewedProgram);
  await page.getByRole('button', { name: '放大查看正确性代码', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '正确性测试代码' })).toContainText('# Reviewed in the primary test-code editor');
  await page.getByRole('dialog', { name: '正确性测试代码' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('高级：正确性启动入口', { exact: true }).click();
  await expect(page.getByLabel('正确性启动入口', { exact: true })).toContainText('exec python3');
  const entryDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载正确性启动入口', exact: true }).click();
  expect((await entryDownload).suggestedFilename()).toBe('run-correctness.sh');
  await page.getByRole('button', { name: '保存测试方案草稿', exact: true }).click();
  await expect(page.getByText('测试方案草稿已保存', { exact: false })).toBeVisible();
  const packageDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载完整测试包', exact: true }).click();
  const downloaded = await packageDownload;
  expect(downloaded.suggestedFilename()).toBe('corepilot-test-package.tar.gz');
  expect(fs.statSync((await downloaded.path())!).size).toBeGreaterThan(500);
  await page.getByRole('tab', { name: '1 测试条件' }).click();
  await page.locator('.sampling-advanced > summary').click();
  await expect(page.getByLabel('固定随机种子', { exact: true })).toHaveValue('42');
  await expect(page.getByLabel('每端采样次数', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('性能负载 1 length', { exact: true })).toHaveValue('64');
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  await page.getByRole('button', { name: '用 AI 生成两库性能代码', exact: true }).click();
  await expect(page.getByText('请先准备并保存比较基线', { exact: false })).toBeVisible();
  const saved = f.projects.validationAssets.get(project, packageId, version, targetId);
  expect(saved.test_plan.seed).toBe(42);
  expect(saved.workloads[0].parameters.length).toBe(64);
  expect(saved.qualification).toBe('DRAFT');
  expect(saved.supporting_files.find(file => file.path === 'support/test-correctness.py')?.content).toBe(reviewedProgram);
  expect(saved.correctness_script).toContain('exec python3');
  expect(f.modelRequests.validationBodies).toHaveLength(1);
  const standalone = '#!/bin/sh\nprintf "custom standalone validation\\n"\n';
  await page.getByLabel('上传正确性测试脚本', { exact: true }).setInputFiles({ name: 'standalone.sh', mimeType: 'text/plain', buffer: Buffer.from(standalone) });
  await expect(page.getByLabel('正确性测试脚本', { exact: true })).toHaveValue(standalone);
  await expect(page.locator('.test-code-card').first().locator('.test-code-file')).toContainText('scripts/run-correctness.sh');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '1 测试条件' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('comparison trial responds immediately, shows live stages and counts, and restores the active run after reload', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true }); });
  const f = fixture;
  const project = f.projects.add({ name: 'Trial progress', repository_root: f.repo, config_path: f.configPath });
  const d = await f.projects.discover(project.project_id, 'kernel');
  const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
  const draft = f.readyValidation(project, pkg, version, target);
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
  const trialId = 'validation:browser-progress';
  const record = { trial_id: trialId, package_id: pkg, package_version: version, target_id: target,
    purpose: 'VALIDATION_DRAFT', evaluator_digest: draft.evaluator_digest, mode: 'comparison', created_at: new Date().toISOString() };
  let phase = 'preparing', requests = 0, posted = false, firstKey = '';
  let release!: () => void;
  const submitting = new Promise<void>(resolve => { release = resolve; });
  const base = `**/v1/projects/${project.project_id}/validation-trials`;
  await page.route(base, async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { trials: posted ? [record] : [] } }); return; }
    requests++;
    if (requests === 1) firstKey = route.request().headers()['idempotency-key'];
    expect(route.request().postDataJSON().mode).toBe('comparison');
    if (requests > 1) { await route.fulfill({ status: 400, json: { error: { message: 'Fixture submission rejected' } } }); return; }
    await submitting; posted = true;
    await route.abort('failed');
  });
  await page.route(`**/v1/projects/${project.project_id}/validation-trial-request*`, async route => {
    const key = route.request().headers()['idempotency-key'];
    if (key === firstKey) await route.fulfill({ json: { state: 'CREATED', trial_id: trialId } });
    else await route.fulfill({ json: { state: route.request().method() === 'POST' ? 'CLOSED' : 'NOT_FOUND' } });
  });
  await page.route(`${base}/*`, async route => {
    const done = phase === 'succeeded';
    await route.fulfill({ json: { trial: { ...record, preparation: { state: phase === 'preparing' ? 'PREPARING' : 'READY',
      phase: phase === 'preparing' ? 'STAGING_BASELINE' : 'SUBMITTED', message: '正在上传并核验已固定的比较基线' } },
      status: { status: phase === 'preparing' ? 'PREPARING' : phase === 'unknown' ? 'UNKNOWN' : done ? 'SUCCEEDED' : 'RUNNING',
        current_step: phase === 'correctness' ? 'CORRECTNESS' : phase === 'performance' ? 'PERFORMANCE' : null,
        ended_at: done ? new Date().toISOString() : null, failure: phase === 'unknown' ? { message: '请核对原试跑' } : null }, commands: [],
      summary: { correctness: { planned: 2, passed: phase === 'preparing' ? 0 : phase === 'correctness' ? 1 : 2, failed: 0, missing: [] },
        performance: { planned: 4, measured: done ? 4 : phase === 'performance' ? 1 : 0, missing: [] }, comparisons: [] },
      output: { stdout: 'Runner build completed\n', stderr: '', truncated: false }, passed: done } });
  });
  try {
    await login(page); await openTaskPreparation(page);
    await page.getByRole('tab', { name: '3 试运行与对比' }).click();
    const comparison = page.getByRole('button', { name: '在 Runner 上试运行两库对比', exact: true });
    await comparison.click();
    await expect(page.locator('.validation-trial')).toContainText('正在提交试运行');
    await expect(page.getByRole('button', { name: '正在提交两库对比…', exact: true })).toBeDisabled();
    await expect.poll(() => requests).toBe(1);
    release();
    await expect(page.getByText('上次试跑请求尚未确认', { exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('tab', { name: '3 试运行与对比' }).click();
    await expect(page.getByText('上次试跑请求尚未确认', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '核对上次请求', exact: true }).click();
    const panel = page.locator('.validation-trial');
    await expect(panel).toContainText('正在上传并核验已固定的比较基线');
    await expect(panel).toContainText('已用时');
    await expect(comparison).toBeDisabled();
    phase = 'unknown';
    await expect(panel).toContainText('执行状态待核对');
    phase = 'correctness';
    await panel.getByRole('button', { name: '核对原试跑状态' }).click();
    await expect(panel).toContainText('正在执行正确性测试');
    await expect(panel).toContainText('正确性：1/2 通过');
    await expect(panel).not.toContainText('试运行通过');
    await panel.getByText('查看 Runner 最新输出', { exact: true }).click();
    await expect(panel.locator('.trial-live-output pre')).toContainText('Runner build completed');
    await page.reload();
    await page.getByRole('tab', { name: '3 试运行与对比' }).click();
    await expect(panel).toContainText(trialId);
    await expect(panel).toContainText('正确性：1/2 通过');
    await expect(comparison).toBeDisabled();
    phase = 'performance';
    await expect(panel).toContainText('正在预热并采集性能样本');
    await expect(panel).toContainText('性能：1/4 个有效样本');
    expect(requests).toBe(1);
    phase = 'succeeded';
    await expect(panel).toContainText('开发试运行 · 执行完成');
    await expect(panel).toContainText('性能：4/4 个有效样本');
    await expect(comparison).toBeEnabled();
    await comparison.click();
    await expect(page.getByText('Fixture submission rejected', { exact: true })).toBeVisible();
    await expect(panel).toContainText(trialId);
    await expect(comparison).toBeDisabled();
    await page.getByRole('button', { name: '关闭未创建的请求', exact: true }).click();
    await expect(comparison).toBeEnabled();
  } finally { release(); }
});

test('duplicate trial samples remain visible and block evaluation review', async ({ page }) => {
  const f = fixture, r = await prepareReviewFixture(f);
  try {
    const duplicate = structuredClone(r.state.measurements[1]);
    if (typeof duplicate.value !== 'number') throw new Error('fixture sample is not numeric');
    duplicate.value = 99;
    r.state.measurements.push(duplicate);
    await login(page); await openTaskPreparation(page);
    await page.getByRole('tab', { name: '3 试运行与对比' }).click();
    const panel = page.locator('.validation-trial');
    await expect(panel).toContainText('试运行测量不能用于审阅');
    await expect(panel).toContainText('性能样本无效、重复或实验身份不匹配');
    await expect(panel).not.toContainText('试运行通过。请在下方审阅');
    await panel.getByText('查看原始性能样本', { exact: true }).click();
    await expect(panel.locator('details pre').filter({ hasText: '99' })).toBeVisible();
    expect(f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target).qualification).toBe('DRAFT');
  } finally { await r.close(); }
});

test('a passed comparison leads to explicit human adoption and a working preflight without regenerating or rerunning tests', async ({ page }) => {
  const f = fixture, r = await prepareReviewFixture(f);
  try {
    await login(page); await openTaskPreparation(page);
    await page.getByRole('button', { name: '保存并运行前检查', exact: true }).click();
    await expect(page.locator('.setup-check-pending')).toContainText('试跑已通过，请确认测试方案用于正式优化');
    await expect(page.locator('.setup-check-pending')).toContainText('无需重新生成脚本');
    expect(f.projects.validationAssets.get(r.project, r.pkg, r.version, r.target).qualification).toBe('DRAFT');
    await page.getByRole('button', { name: '查看试跑并确认测试方案', exact: true }).click();
    await expect(page.getByRole('tab', { name: '3 试运行与对比' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '审阅并启用测试方案', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '确认这版测试方案用于正式优化' });
    await expect(modal).toContainText('Reference fixture');
    await expect(modal.getByRole('button', { name: '确认启用并运行前检查', exact: true })).toBeDisabled();
    await modal.getByLabel('测试方案审阅人', { exact: true }).fill('Browser maintainer');
    await modal.getByRole('button', { name: '确认启用并运行前检查', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator('.validation-review')).toContainText('测试方案已确认，可用于正式优化');
    await expect(page.locator('.setup-check-output')).toContainText('输入检查通过');
    await expect(page.locator('.setup-check-pending')).toHaveCount(0);
    const qualified = f.projects.packageLoader.resolveSelection({ package_id: r.pkg, package_version: r.version, target_id: r.target }, { requireQualified: true });
    expect(qualified.bundle.qualification.reviewer).toBe('Browser maintainer');
    expect(f.projects.validationTrials.list(r.project)).toHaveLength(1);
    expect(f.modelRequests.validationBodies).toHaveLength(0);
    await page.getByRole('button', { name: '项目概览', exact: true }).click();
    await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(f.service.list()).toHaveLength(0);
  } finally { await r.close(); }
});

test('configuration keeps advanced edits and unsaved credentials in memory across tabs and navigation', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Drafts', repository_root: f.repo, config_path: f.configPath });
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await page.getByRole('button', { name: '高级配置', exact: true }).click();
  const editor = page.getByLabel('高级配置 JSON');
  const edited = JSON.parse(await editor.inputValue());
  edited.model.model_id = 'draft-model'; edited.model.api_key = 'temporary-private-value';
  await editor.fill(JSON.stringify(edited, null, 2));
  await openLegacyValidation(page);
  await expect(page.locator('.validation-layout')).toBeVisible();
  await expect(page.locator('.config-state')).toContainText('有未保存的更改');
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByLabel('模型 ID')).toHaveValue('draft-model');
  await expect(page.locator('.config-state')).toContainText('有未保存的更改');
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByLabel(/^API Key/)).toHaveValue('temporary-private-value');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('temporary-private-value');
  expect(loadOptimizationConfig(f.configPath).config.model.model_id).toBe('fixture-model');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已保存');
  await expect(page.getByLabel(/^API Key/)).toHaveValue('[redacted]');
  expect(loadOptimizationConfig(f.configPath).config.model.model_id).toBe('draft-model');
  expect(loadOptimizationConfig(f.configPath).config.model.api_key).toBe('temporary-private-value');
  await page.getByRole('button', { name: '高级配置', exact: true }).click();
  await page.getByLabel('高级配置 JSON').fill('{invalid');
  await page.getByRole('button', { name: '模型连接', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('JSON 格式错误');
  await expect(page.getByLabel('高级配置 JSON')).toHaveValue('{invalid');
  await page.getByRole('button', { name: '放弃更改并重新读取' }).click();
  await expect(page.getByLabel('高级配置 JSON')).toHaveValue(/draft-model/);
  await page.screenshot({ path: path.join(repositoryRoot, 'build', 'frontend-audit', 'configuration.png'), fullPage: true });
  const validAdvanced = await page.getByLabel('高级配置 JSON').inputValue();
  await page.getByLabel('高级配置 JSON').fill('{invalid');
  await openLegacyValidation(page);
  await expect(page.getByRole('alert')).toContainText('JSON 格式错误');
  await expect(page.getByLabel('高级配置 JSON')).toHaveValue('{invalid');
  await page.getByLabel('高级配置 JSON').fill(validAdvanced);
  await page.getByRole('button', { name: '应用并继续构建与验证', exact: true }).click();
  await expect(page.getByLabel('验证模式', { exact: true })).toBeVisible();
  await expect(page.getByLabel('高级配置 JSON')).toHaveCount(0);
});

test('model lists load on entry and vendor selection, react to credential changes and leave other drafts unsaved', async ({ page }) => {
  const f = fixture;
  const p = f.projects.add({ name: 'Auto models', repository_root: f.repo, config_path: f.configPath });
  const original = fs.readFileSync(f.configPath, 'utf8');
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.locator('.model-discovery')).toContainText('已加载 1 个模型');
  expect(f.modelRequests.lists).toHaveLength(1);
  await openLegacyValidation(page);
  await page.getByRole('button', { name: '自定义构建', exact: true }).click();
  await page.getByLabel('构建命令', { exact: true }).fill('make "unsaved build argument"');
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  const previews: Array<{ endpoint: string; api_key: string; proxy: string }> = [];
  await page.route(`**/v1/projects/${p.project_id}/models`, async route => {
    const { model } = route.request().postDataJSON();
    previews.push(model);
    await route.fulfill({ json: { models: [{ id: 'vendor-chat-model', label: 'Chat' }, { id: 'vendor-reasoning-model', label: 'Reasoning' }] } });
  });
  await page.getByLabel('模型来源').selectOption('deepseek');
  await expect(page.getByLabel(/^API Key/)).toHaveValue('');
  await expect(page.getByLabel('模型 ID')).toHaveValue('');
  await expect(page.locator('.model-discovery')).toContainText('已加载 2 个模型');
  expect(previews.at(-1)?.endpoint).toBe('https://api.deepseek.com/v1');
  const beforeTyping = previews.length;
  await page.getByLabel(/^API Key/).pressSequentially('new-vendor-key', { delay: 25 });
  await expect.poll(() => previews.length).toBe(beforeTyping + 1);
  expect(previews.at(-1)?.api_key).toBe('new-vendor-key');
  await expect(page.getByLabel('模型 ID').getByRole('option', { name: 'vendor-chat-model', exact: true })).toHaveCount(1);
  await page.getByLabel('模型 ID').selectOption('vendor-reasoning-model');
  await expect(page.getByLabel('模型 ID')).toHaveValue('vendor-reasoning-model');
  await expect(page.locator('.config-state')).toContainText('有未保存的更改');
  expect(fs.readFileSync(f.configPath, 'utf8')).toBe(original);
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
  await openLegacyValidation(page);
  await expect(page.locator('.setup-current-build')).toContainText('make "unsaved build argument"');
  await expect(page.getByLabel('构建命令', { exact: true })).toHaveCount(0);
});

test('automatic model discovery failures preserve manual IDs and can be refreshed without saving', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Model recovery', repository_root: f.repo, config_path: f.configPath });
  let unavailable = true;
  await page.route('**/v1/projects/*/models', route => unavailable
    ? route.fulfill({ status: 503, json: { error: { message: '模型服务暂时不可用' } } })
    : route.continue());
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.locator('.model-discovery')).toContainText('模型服务暂时不可用');
  await page.getByLabel('模型 ID').fill('private-model-id');
  unavailable = false;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.locator('.model-discovery')).toContainText('已加载 1 个模型');
  await expect(page.getByLabel('模型 ID')).toHaveValue('private-model-id');
  await expect(page.getByLabel('模型 ID').getByRole('option', { name: 'fixture-model', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: '手动输入模型 ID', exact: true }).click();
  await page.getByLabel('模型 ID').fill('another-private-id');
  await page.getByRole('button', { name: '从模型列表选择', exact: true }).click();
  await expect(page.getByLabel('模型 ID')).toHaveValue('another-private-id');
  expect(loadOptimizationConfig(f.configPath).config.model.model_id).toBe('fixture-model');
  expect(f.modelRequests.inference).toBe(0);
});

test('editing a custom endpoint and proxy automatically reloads models and ignores earlier responses', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Model race', repository_root: f.repo, config_path: f.configPath });
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>(resolve => { releaseSlow = resolve; });
  let slowStarted = false;
  let slowFinished = false;
  const previews: Array<{ endpoint: string; proxy: string }> = [];
  await page.route('**/v1/projects/*/models', async route => {
    const { model } = route.request().postDataJSON();
    previews.push(model);
    if (model.endpoint.includes('/slow')) {
      slowStarted = true;
      await slowGate;
      await route.fulfill({ json: { models: [{ id: 'stale-model', label: 'Stale' }] } }).catch(() => {});
      slowFinished = true;
    } else await route.fulfill({ json: { models: [{ id: 'latest-model', label: 'Latest' }] } });
  });
  await login(page);
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.locator('.model-discovery')).toContainText('已加载 1 个模型');
  await page.getByLabel('Endpoint', { exact: true }).fill('http://127.0.0.1/slow');
  await expect.poll(() => slowStarted).toBe(true);
  await page.getByLabel('Endpoint', { exact: true }).fill('http://127.0.0.1/latest');
  await expect(page.getByLabel('模型 ID').getByRole('option', { name: 'latest-model', exact: true })).toHaveCount(1);
  releaseSlow();
  await expect.poll(() => slowFinished).toBe(true);
  await expect(page.getByLabel('模型 ID').getByRole('option', { name: 'stale-model', exact: true })).toHaveCount(0);
  await page.locator('.model-advanced > summary').click();
  await page.getByLabel('模型代理（可选）').fill('http://127.0.0.1:7890');
  await expect.poll(() => previews.at(-1)?.proxy).toBe('http://127.0.0.1:7890');
  await expect(page.locator('.model-discovery')).toContainText('已加载 1 个模型');
  await expect(page.getByLabel('模型 ID')).toHaveValue('fixture-model');
  expect(loadOptimizationConfig(f.configPath).config.model.endpoint).not.toContain('/latest');
});

test('maintainers register machines once and projects select shared resources without seeing connection credentials', async ({ page }) => {
  const f = fixture;
  const first = f.projects.add({ name: 'First project', repository_root: f.repo, config_path: f.configPath });
  const secondRoot = path.join(f.root, 'second-project'); fs.mkdirSync(secondRoot);
  const second = f.projects.add({ name: 'Second project', repository_root: secondRoot });
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'registered-browser-secret', dbPath: path.join(f.root, 'runner.sqlite'), workspaceRoot: path.join(f.root, 'runner') });
  try {
    await login(page);
    await page.getByRole('button', { name: '执行机器', exact: true }).click();
    await expect(page.getByRole('heading', { name: '注册第一台执行机器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '注册执行机器', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '注册执行机器' });
    await dialog.getByLabel('机器名称', { exact: true }).fill('Shared optimization CPU');
    await dialog.getByLabel('Runner RPC 地址', { exact: true }).fill(runner.url);
    await dialog.getByLabel(/^Runner Token/).fill('registered-browser-secret');
    await dialog.getByText('部署环境（维护者配置）', { exact: true }).click();
    await dialog.getByLabel('登记源码传输环境').check();
    await dialog.getByLabel('部署 SSH Alias', { exact: true }).fill('maintainer-fixture-target');
    await dialog.getByLabel('Runner 工作目录', { exact: true }).fill(path.join(f.root, 'runner'));
    await dialog.getByRole('button', { name: '保存并检测', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.machine-card .machine-status')).toHaveText('在线');
    await expect(page.locator('.machine-card')).toContainText('CPU');
    const list = await runFixtureCli(f.url, f.token, ['machine', 'list']);
    expect(list.code, list.stderr).toBe(0);
    const machineId = JSON.parse(list.stdout).machines[0].machine_id;
    expect(list.stdout).not.toContain('registered-browser-secret');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('registered-browser-secret');
    let finishCheck!: () => void;
    const checkGate = new Promise<void>(resolve => { finishCheck = resolve; });
    await page.route('**/v1/machines/*/check', async route => { await checkGate; await route.continue(); });
    try {
      await page.getByRole('button', { name: '检测连接', exact: true }).click();
      await expect(page.getByRole('button', { name: '正在检测…', exact: true })).toBeDisabled();
      await expect(page.locator('.machine-card [role="status"]')).toContainText('正在连接 Runner');
    } finally { finishCheck(); }
    await expect(page.locator('.machine-card [role="status"]')).toContainText('连接成功');
    await expect(page.locator('.machine-card [role="status"]')).toContainText('检测时间');
    await expect(page.getByRole('button', { name: '检测连接', exact: true })).toBeEnabled();
    await page.unroute('**/v1/machines/*/check');
    for (const project of [first, second]) {
      await page.getByLabel('当前项目', { exact: true }).selectOption(project.project_id);
      await page.getByRole('button', { name: '模型与机器', exact: true }).click();
      await page.getByRole('button', { name: '目标机器', exact: true }).click();
      await expect(page.getByLabel('Runner RPC 地址')).toHaveCount(0);
      await expect(page.getByLabel(/^Runner Token/)).toHaveCount(0);
      await expect(page.getByLabel('部署 SSH Alias')).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: '执行机器', exact: true }).getByRole('option', { name: '选择已注册机器', exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: '执行机器', exact: true }).getByRole('option', { name: /Shared optimization CPU/ })).toHaveCount(1);
      await page.getByRole('combobox', { name: '执行机器', exact: true }).selectOption(machineId);
      await expect(page.locator('.machine-selection')).toContainText('Shared optimization CPU');
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('配置已保存');
      expect(loadOptimizationConfig(project.config_path).config.runner).toEqual({ mode: 'rpc', machine_id: machineId });
      expect(fs.readFileSync(project.config_path, 'utf8')).not.toContain('registered-browser-secret');
    }
    expect(f.store.listExecutionMachines()).toHaveLength(1);
    await page.getByRole('button', { name: '检测所选机器', exact: true }).click();
    await expect(page.locator('.machine-selection [role="status"]')).toContainText('连接成功');
    await expect(page.locator('.machine-selection [role="status"]')).toContainText('Shared optimization CPU');
    await page.getByRole('button', { name: '执行机器', exact: true }).click();
    await page.getByRole('button', { name: '编辑机器', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑执行机器' });
    await expect(edit.getByLabel(/^Runner Token/)).toHaveValue('[redacted]');
    await edit.getByLabel('机器名称', { exact: true }).fill('Renamed shared CPU');
    await edit.getByRole('button', { name: '保存并检测', exact: true }).click();
    await expect(edit).toHaveCount(0);
    expect(f.store.getExecutionMachine(machineId)?.runner.token).toBe('registered-browser-secret');
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await page.getByRole('button', { name: '目标机器', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '执行机器', exact: true })).toHaveValue(machineId);
    await expect(page.locator('.machine-selection')).toContainText('Renamed shared CPU');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '检测所选机器', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: '执行机器', exact: true }).click();
    await expect(page.getByRole('heading', { name: '执行机器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '模型与机器', exact: true }).click();
    await page.getByRole('button', { name: '目标机器', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '执行机器', exact: true })).toHaveValue(machineId);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await runner.close();
    await page.getByRole('button', { name: '检测所选机器', exact: true }).click();
    await expect(page.locator('.machine-selection .machine-status')).toHaveText('离线');
    await expect(page.locator('.machine-selection')).toContainText('无法连接 Runner');
    await expect(page.locator('.machine-selection [role="alert"]')).toContainText('连接失败');
    await expect(page.locator('.machine-selection [role="status"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '检测所选机器', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '执行机器', exact: true }).click();
    await page.getByRole('button', { name: '检测连接', exact: true }).click();
    await expect(page.locator('.machine-card [role="alert"]')).toContainText('连接失败');
    await expect(page.locator('.machine-card [role="alert"]')).toContainText('无法连接 Runner');
    expect(f.modelRequests.inference).toBe(0); expect(f.service.list()).toHaveLength(0);
  } finally { await runner.close(); }
});


test('optimization creation reports missing secure entropy without losing its inputs', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(window.crypto, 'getRandomValues', { value: undefined, configurable: true });
  });
  const f = fixture;
  f.projects.add({ name: 'Entropy check', repository_root: f.repo, config_path: f.configPath });
  await login(page); await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建优化任务' });
  await dialog.getByRole('radio', { name: /仅生成优化代码/ }).check();
  await dialog.getByLabel('优化函数').fill('kernel');
  await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法提供安全随机数');
  await expect(dialog.getByLabel('优化函数')).toHaveValue('kernel');
  expect(f.service.list()).toHaveLength(0);
});

test('preflight checks the typed function and configuration read failures can be retried', async ({ page }) => {
  const f = fixture;
  const p = f.projects.add({ name: 'Checks', repository_root: f.repo, config_path: f.configPath });
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建优化任务' });
  await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await dialog.getByLabel('优化函数').fill('wrong_function');
  await dialog.getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('wrong_function');
  expect(f.service.list()).toHaveLength(0);
  await dialog.getByLabel('优化函数').fill('kernel');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(dialog.locator('.check-output')).toContainText('函数：kernel');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  let fail = true;
  await page.route(`**/v1/projects/${p.project_id}/config`, route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: '暂时无法读取配置' } }) }) : route.continue());
  await page.getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('暂时无法读取配置');
  fail = false;
  await page.getByRole('button', { name: '重新读取配置' }).click();
  await expect(page.getByLabel('模型 ID')).toHaveValue('fixture-model');
});

test('connection loss preserves records and missing workflow links show an explicit error', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Reconnect', repository_root: f.repo, config_path: f.configPath });
  await login(page);
  await expect(page.getByRole('heading', { name: 'Reconnect' })).toBeVisible();
  let offline = true;
  await page.route('**/v1/projects', route => offline ? route.abort() : route.continue());
  await expect(page.locator('.connection-banner')).toContainText('连接已中断');
  await expect(page.getByRole('heading', { name: 'Reconnect' })).toBeVisible();
  offline = false;
  await page.getByRole('button', { name: '立即重连' }).click();
  await expect(page.locator('.connection-banner')).toHaveCount(0);
  await page.goto(f.url + '/#/tasks/missing-workflow');
  await expect(page.getByRole('heading', { name: '任务暂时无法打开' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新读取任务' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '还没有优化任务' })).toHaveCount(0);
  await page.goto(f.url + '/favicon.svg');
  expect((await page.request.get(f.url + '/favicon.svg')).status()).toBe(200);
});

test('source picker jumps between disk roots and paths, and saves the selected default branch', async ({ page }) => {
  const f = fixture;
  f.git('branch', 'feature/browse');
  await login(page);
  await page.getByRole('button', { name: '添加第一个项目' }).click();
  const dialog = page.getByRole('dialog', { name: '添加源码项目' });
  await dialog.getByLabel('项目名称').fill('Source picker');
  await expect(dialog.getByText('首次使用无需准备配置文件。', { exact: false })).toBeVisible();
  await expect(dialog.getByLabel('CorePilot 配置文件路径')).not.toBeVisible();
  await dialog.getByRole('button', { name: '浏览', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择源码文件夹' });
  await picker.locator('.picker-sidebar').getByRole('button', { name: path.parse(f.repo).root, exact: true }).click();
  await expect(picker.locator('.picker-selection strong')).toHaveText(path.parse(f.repo).root);
  await expect(picker.getByRole('button', { name: '上一级', exact: true })).toBeDisabled();
  await jumpToFolder(page, f.root);
  await picker.getByRole('row', { name: 'repo', exact: true }).click();
  await expect(picker.locator('.picker-selection strong')).toHaveText(f.repo);
  await expect(picker.locator('.picker-content-heading h3')).toHaveText(path.basename(f.root));
  await picker.getByRole('row', { name: 'repo', exact: true }).dblclick();
  await expect(picker.locator('.picker-content-heading h3')).toHaveText('repo');
  await expect(picker.getByRole('navigation', { name: '目录层级' })).toContainText(path.basename(f.root));
  await picker.getByRole('button', { name: '后退', exact: true }).click();
  await expect(picker.locator('.picker-selection strong')).toHaveText(f.root);
  await picker.getByRole('button', { name: '前进', exact: true }).click();
  await expect(picker.locator('.picker-selection strong')).toHaveText(f.repo);
  await picker.screenshot({ path: path.join(repositoryRoot, 'build', 'frontend-audit', 'directory-picker.png') });
  await picker.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(dialog.getByLabel('服务器上的源码目录')).toHaveValue(f.repo);
  await expect(dialog.getByLabel('优化分支')).toHaveValue('main');
  await dialog.getByLabel('优化分支').selectOption('feature/browse');
  await page.screenshot({ path: path.join(repositoryRoot, 'build', 'frontend-audit', 'source-project.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(dialog.getByLabel('优化分支')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Source picker' })).toBeVisible();
  const project = f.projects.list()[0];
  expect(project.source_branch).toBe('feature/browse');
  expect(loadOptimizationConfig(project.config_path).config.model.model_id).toBe('configure-model');
  expect(f.git('branch', '--show-current')).toBe('main');
});

test('folder picker recovers from a bad path and cancellation preserves the project form', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Recently used', repository_root: f.repo, config_path: f.configPath });
  await login(page);
  await page.locator('.sidebar').getByRole('button', { name: '添加项目', exact: true }).click();
  const form = page.getByRole('dialog', { name: '添加源码项目' });
  await form.getByLabel('项目名称').fill('Keep my draft');
  await form.getByLabel('服务器上的源码目录').fill(f.repo);
  await form.getByText('导入已有 CorePilot 配置（可选）', { exact: true }).click();
  await form.getByLabel('CorePilot 配置文件路径').fill(f.configPath);
  await form.getByRole('button', { name: '浏览', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择源码文件夹' });
  await picker.getByRole('button', { name: '输入文件夹路径', exact: true }).click();
  await picker.getByLabel('文件夹路径', { exact: true }).fill(path.join(f.root, 'missing-directory'));
  await picker.getByLabel('文件夹路径', { exact: true }).press('Enter');
  await expect(picker.getByRole('alert')).toContainText('找不到源码目录');
  await expect(picker.getByRole('button', { name: '选择文件夹', exact: true })).toBeDisabled();
  await picker.locator('.picker-sidebar').getByRole('button', { name: 'Recently used', exact: true }).click();
  await expect(picker.getByRole('alert')).toHaveCount(0);
  await picker.getByRole('row', { name: 'include', exact: true }).click();
  await expect(picker.locator('.picker-selection strong')).toHaveText(path.join(f.repo, 'include'));
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(form).toBeVisible();
  await expect(form.getByLabel('项目名称')).toHaveValue('Keep my draft');
  await expect(form.getByLabel('服务器上的源码目录')).toHaveValue(f.repo);
  await expect(form.getByLabel('CorePilot 配置文件路径')).toHaveValue(f.configPath);
  await form.getByRole('button', { name: '浏览', exact: true }).click();
  await picker.getByRole('row', { name: 'include', exact: true }).click();
  await picker.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(form.getByLabel('服务器上的源码目录')).toHaveValue(path.join(f.repo, 'include'));
  expect(f.projects.list()).toHaveLength(1);
  expect(f.service.list()).toHaveLength(0);
});

test('keyboard selection and long folder lists keep the confirmation visible on a phone', async ({ page }) => {
  const f = fixture;
  const many = path.join(f.root, 'folders'); fs.mkdirSync(many);
  for (let index = 0; index < 215; index++) fs.mkdirSync(path.join(many, `folder-${index}`));
  await login(page);
  await page.getByRole('button', { name: '添加第一个项目' }).click();
  const form = page.getByRole('dialog', { name: '添加源码项目' });
  await form.getByLabel('服务器上的源码目录').fill(many);
  await form.getByRole('button', { name: '浏览', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择源码文件夹' });
  const grid = picker.getByRole('grid', { name: '文件夹列表' });
  await expect(picker.locator('.picker-selection strong')).toHaveText(many);
  await grid.focus(); await grid.press('ArrowDown');
  await expect(picker.locator('.picker-selection strong')).toHaveText(path.join(many, 'folder-0'));
  await grid.press('Enter');
  await expect(picker.getByText('此文件夹为空', { exact: true })).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(picker.locator('.picker-selection strong')).toHaveText(many);
  await picker.getByLabel('搜索当前文件夹').fill('folder-214');
  await expect(grid.getByRole('row', { name: 'folder-214', exact: true })).toBeVisible();
  await expect(grid.getByRole('row')).toHaveCount(2);
  await picker.getByLabel('搜索当前文件夹').fill('no-such-folder');
  await expect(picker.getByText('没有匹配的文件夹', { exact: true })).toBeVisible();
  await picker.getByRole('button', { name: '清除搜索', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 640 });
  await grid.focus(); await grid.press('End');
  await expect(picker.locator('.picker-selection strong')).toHaveText(path.join(many, 'folder-214'));
  await expect(picker.getByRole('button', { name: '选择文件夹', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await picker.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await picker.screenshot({ path: path.join(repositoryRoot, 'build', 'frontend-audit', 'directory-picker-mobile.png') });
  await picker.getByRole('button', { name: '打开文件夹 folder-214', exact: true }).click();
  await expect(picker.getByText('此文件夹为空', { exact: true })).toBeVisible();
  await picker.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(form.getByLabel('服务器上的源码目录')).toHaveValue(path.join(many, 'folder-214'));
});

test('a task optimizes another branch and delivers there while preserving the original checkout and edits', async ({ page }) => {
  const f = fixture;
  const originalHead = f.git('rev-parse', 'HEAD');
  f.git('checkout', '-b', 'feature/vector');
  fs.writeFileSync(path.join(f.repo, 'branch.txt'), 'feature source\n');
  f.git('add', '.'); f.git('commit', '-m', 'Feature source only');
  const branchHead = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'main');
  fs.writeFileSync(path.join(f.repo, 'local-note.txt'), 'keep original edits');
  f.projects.add({ name: 'Branch integration', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(dialog.getByLabel('优化分支')).toHaveValue('main');
  await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await dialog.getByLabel('优化分支').selectOption('feature/vector');
  await dialog.getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(dialog.locator('.check-output')).toContainText('源码分支：feature/vector');
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  const workflowId = f.service.list()[0].workflow_id;
  await addVerifiedFixtureExperiments(f, workflowId);
  await page.reload();
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toBeVisible();
  const workflow = f.service.list()[0];
  expect(workflow.source_branch).toBe('feature/vector');
  expect(workflow.baseline_commit).toBe(branchHead);
  expect(fs.readFileSync(path.join(workflow.workspace_editing!, 'branch.txt'), 'utf8').trim()).toBe('feature source');
  expect(f.git('rev-parse', 'main')).toBe(originalHead);
  const cli = await runFixtureCli(f.url, f.token, ['workflow', 'report', workflow.workflow_id, '--json']);
  expect(JSON.parse(cli.stdout).workflow.source_branch).toBe('feature/vector');
  await approveCurrentFixture(page);
  await page.getByRole('button', { name: '交付已批准候选', exact: true }).click();
  const approval = page.getByRole('dialog', { name: '人工审阅与源码交付' });
  await expect(approval).toContainText('交付分支：feature/vector');
  await approval.getByLabel('合并提交说明').fill('Optimize feature/vector');
  await approval.getByRole('button', { name: '确认交付并合并', exact: true }).click();
  await expect(page.locator('.title-row .badge')).toContainText('已交付');
  const api = new ApiClient(f.url, { token: f.token });
  await expect.poll(async () => {
    const { workflow: current } = await api.getOptimizationWorkflow(workflow.workflow_id) as { workflow: OptimizationWorkflowRecord };
    const operation = current.delivery_operation;
    if (!operation || current.status !== 'DELIVERABLE' || operation.status !== 'COMPLETED') {
      throw new Error('交付记录尚未确认，请核对任务状态。');
    }
    if (operation.cleanup === 'NEEDS_ATTENTION') {
      throw new Error(operation.cleanup_message ?? '候选工作区清理失败。');
    }
    return operation.cleanup;
  }, { timeout: 15_000, message: '等待已确认交付的候选工作区完成清理' }).toBe('DONE');
  expect(f.git('branch', '--show-current')).toBe('main');
  expect(f.git('rev-parse', 'main')).toBe(originalHead);
  expect(f.git('show', 'main:kernel.c')).toContain('return 1 + 1');
  expect(f.git('show', 'feature/vector:kernel.c')).toContain('return 2');
  expect(fs.readFileSync(path.join(f.repo, 'local-note.txt'), 'utf8')).toBe('keep original edits');
  expect(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1);
});


test('workload JSON preserves existing settings, fills new defaults and keeps invalid edits out of saved assets', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Workload JSON', repository_root: f.repo, config_path: f.configPath });
  const discovered = await f.projects.discover(project.project_id, 'kernel');
  const pkg = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, target = discovered.targets[0].target_id;
  const initial = f.projects.validationAssets.get(project, pkg, version, target);
  f.projects.validationAssets.save(project, pkg, version, target, { ...initial, source: 'edited', expected_digest: initial.evaluator_digest,
    workloads: [{ workload_id: 'large', parameters: { length: 128 }, threads: 4, critical: true, weight: 3 }] });
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
  await login(page);
  await openTaskPreparation(page);
  const inventory = page.locator('.test-inventory').filter({ has: page.getByText('性能负载', { exact: true }) });
  await inventory.locator('summary').filter({ hasText: '高级：编辑性能负载 JSON' }).click();
  await inventory.getByLabel('性能负载 JSON').fill(JSON.stringify([
    { workload_id: 'large', parameters: { length: 256 } }, { workload_id: 'small', parameters: { length: 16 } },
  ]));
  await inventory.getByRole('button', { name: '应用 JSON', exact: true }).click();
  await expect(page.getByLabel('性能负载 1 线程数', { exact: true })).toHaveValue('4');
  await expect(page.getByLabel('性能负载 2 线程数', { exact: true })).toHaveValue('1');
  await inventory.getByRole('button', { name: /^高级：权重与关键负载/ }).click();
  await expect(page.getByLabel('性能负载 1 关键负载', { exact: true })).toBeChecked();
  await expect(page.getByLabel('性能负载 1 权重', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('性能负载 2 权重', { exact: true })).toHaveValue('1');
  let saves = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().includes('/validation-assets/')) saves++; });
  await page.getByRole('button', { name: '保存条件并准备测试代码', exact: true }).click();
  await expect(page.getByRole('tab', { name: '2 测试代码' })).toHaveAttribute('aria-selected', 'true');
  const saved = f.projects.validationAssets.get(project, pkg, version, target);
  expect(saved.workloads).toEqual([{ workload_id: 'large', parameters: { length: 256 }, threads: 4, critical: true, weight: 3 },
    { workload_id: 'small', parameters: { length: 16 }, threads: 1, critical: false, weight: 1 }]);
  expect(saves).toBe(1);
  await page.getByRole('tab', { name: '1 测试条件' }).click();
  await page.getByLabel('性能负载 2 名称', { exact: true }).fill('large');
  await page.getByRole('button', { name: '保存条件并准备测试代码', exact: true }).click();
  await expect(page.locator('.validation-editor')).toContainText('名称“large”与第 1 行重复');
  await expect(page.getByLabel('性能负载 2 名称', { exact: true })).toHaveValue('large');
  expect(saves).toBe(1);
  expect(f.projects.validationAssets.get(project, pkg, version, target).evaluator_digest).toBe(saved.evaluator_digest);
  await inventory.locator('summary').filter({ hasText: '高级：编辑性能负载 JSON' }).click();
  await inventory.getByLabel('性能负载 JSON').fill('[{"workload_id":"nested","parameters":{"alpha":[1,0]}}]');
  await inventory.getByRole('button', { name: '应用 JSON', exact: true }).click();
  await expect(inventory.getByRole('alert')).toContainText('参数“alpha”');
  await expect(inventory.getByLabel('性能负载 JSON')).toHaveValue('[{"workload_id":"nested","parameters":{"alpha":[1,0]}}]');
  expect(f.projects.validationAssets.get(project, pkg, version, target).evaluator_digest).toBe(saved.evaluator_digest);
  expect(f.modelRequests.inference).toBe(0);
});

test('test conditions expand thread and binding selections while advanced sampling stays optional', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'CPU testing', repository_root: f.repo, config_path: f.configPath });
  const discovered = await f.projects.discover(project.project_id, 'kernel');
  const pkg = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, target = discovered.targets[0].target_id;
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
  // A deterministic machine topology fixture; no performance measurement is claimed here.
  await page.route('**/validation-assets/**/context', async route => {
    const response = await route.fetch(); const body = await response.json();
    body.machine = { name: 'Fixture 2 NUMA CPU', health: { capabilities: { resource_matrix: 1 } },
      hardware: { cpu_count: 8, cpu_topology: { online_cpus: '0-7', node_cpu_lists: { node0: '0-3', node1: '4-7' } } } };
    await route.fulfill({ response, json: body });
  });
  await login(page);
  await openTaskPreparation(page);
  await expect(page.getByLabel('预热次数', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '配置多线程与绑核对比', exact: true }).click();
  await page.getByRole('button', { name: '2 线程', exact: true }).click();
  await page.getByRole('button', { name: '添加另一组绑核配置', exact: true }).click();
  await page.getByLabel('运行配置 2 CPU 分配', { exact: true }).selectOption('shared');
  await expect(page.locator('.execution-preview')).toContainText('4 组线程与绑核组合');
  await expect(page.locator('.execution-preview tbody tr')).toHaveCount(4);
  await expect(page.getByLabel('性能负载 1 线程数', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '复制性能负载 1', exact: true }).click();
  await expect(page.getByLabel('性能负载 2 名称', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '重复测量', exact: false }).click();
  await expect(page.locator('.sampling-advanced > summary')).toContainText('每端 9 个样本');
  const logicalInput = f.projects.validationAssets.get(project, pkg, version, target).cases[0].case_id;
  await page.locator('.validation-quality > summary').click();
  await page.getByRole('button', { name: '添加覆盖维度', exact: true }).click();
  await page.getByLabel('覆盖维度 1', { exact: true }).fill('尾部与尺寸');
  await page.getByLabel('覆盖状态', { exact: true }).selectOption('COVERED');
  await page.getByLabel('覆盖依据', { exact: true }).fill('长度 17 覆盖向量尾部；只对声明的输入作结论');
  await page.getByLabel('逻辑输入 ID（逗号分隔）', { exact: true }).fill(logicalInput);
  await page.getByRole('button', { name: '添加错误实现检验', exact: true }).click();
  await page.getByLabel('故意引入的错误', { exact: true }).fill('漏算尾部');
  const weights = f.projects.validationAssets.get(project, pkg, version, target).workloads.map(row => row.weight);
  await page.getByRole('button', { name: '保存条件并准备测试代码', exact: true }).click();
  await expect(page.getByRole('tab', { name: '2 测试代码' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(page.getByRole('tab', { name: '1 测试条件' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.execution-preview tbody tr')).toHaveCount(4);
  await expect(page.getByLabel('性能负载 2 名称', { exact: true })).toBeVisible();
  const saved = f.projects.validationAssets.get(project, pkg, version, target);
  expect(saved.test_plan.execution_matrix!.thread_counts).toEqual([1, 2]);
  expect(saved.test_plan.execution_matrix!.profiles[1].numa_node).toBe(1);
  expect(saved.workloads[0].weight).toBe(weights[0]);
  expect(saved.test_plan.sampling.sample_count).toBe(9);
  expect(saved.test_plan.statistics?.method).toBe('paired-block-bootstrap-v1');
  expect(saved.quality?.coverage[0].input_ids).toEqual([logicalInput]);
  expect(saved.quality?.probes[0].defect).toBe('漏算尾部');
  const resolved = f.projects.packageLoader.resolveSelection({ package_id: pkg, package_version: version, target_id: target });
  expect(resolved.bundle.workloads.workloads).toHaveLength(saved.workloads.length * 4);
  await page.screenshot({ path: path.join(repositoryRoot, 'build/frontend-audit/test-matrix-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const clipped = await page.locator('.validation-editor, .test-plan, .execution-profile, .thread-chips').evaluateAll(elements =>
    elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className));
  expect(clipped).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: path.join(repositoryRoot, 'build/frontend-audit/test-matrix-mobile.png'), fullPage: true });
  expect(f.service.list()).toHaveLength(0);
});

test('model drafting keeps navigation usable, reconnects after reload and preserves edits made while waiting', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await fixture.close(); fixture = await startWebFixture({ execute: true, validationGate: gate });
  const f = fixture;
  try {
    const project = f.projects.add({ name: 'Drafting progress', repository_root: f.repo, config_path: f.configPath });
    const d = await f.projects.discover(project.project_id, 'kernel');
    const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
    const before = f.readyValidation(project, pkg, version, target);
    f.projects.validationAssets.save(project, pkg, version, target, { ...before, source: 'edited', expected_digest: before.evaluator_digest,
      workloads: [{ workload_id: 'small', parameters: { length: 64 }, threads: 1, critical: false, weight: 1 }] });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
      library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
    await login(page); await openTaskPreparation(page);
    await page.getByRole('tab', { name: '2 测试代码' }).click();
    await page.getByRole('button', { name: '用 AI 生成正确性代码', exact: true }).click();
    await expect(page.locator('.validation-generation')).toContainText('已发送 1 次请求');
    await expect(page.getByRole('tab', { name: '1 测试条件' })).toBeEnabled();
    await page.reload();
    await expect(page.locator('.validation-generation')).toContainText('AI 正在生成测试代码');
    await page.getByRole('tab', { name: '1 测试条件' }).click();
    await page.getByLabel('性能负载 1 length', { exact: true }).fill('128');
    await page.getByRole('tab', { name: '2 测试代码' }).click();
    release();
    await expect(page.locator('.validation-generation')).toContainText('生成完成');
    await page.getByRole('button', { name: '应用生成草稿', exact: true }).click();
    await page.getByRole('tab', { name: '1 测试条件' }).click();
    await expect(page.getByLabel('性能负载 1 length', { exact: true })).toHaveValue('128');
    await page.getByText('查看模型调用记录', { exact: true }).click();
    await expect(page.locator('.validation-generation')).toContainText('实际请求模型：fixture-model');
    expect(f.projects.validationAssets.get(project, pkg, version, target).workloads[0].parameters.length).toBe(64);
    expect(f.modelRequests.validationBodies).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator('.validation-generation').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  } finally { release(); }
});

test('empty instructions directly generate correctness code and draft missing conditions without a plan adoption step', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Missing oracle', repository_root: f.repo, config_path: f.configPath });
  const d = await f.projects.discover(project.project_id, 'kernel');
  const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
  const before = f.projects.validationAssets.get(project, pkg, version, target);
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: d.evidence.generated.package_id, package_version: d.evidence.generated.version, target_id: d.targets[0].target_id }, baseline_artifact: '' } });
  await login(page); await openTaskPreparation(page);
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  await expect(page.getByLabel('生成提示词（可选）', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '用 AI 生成正确性代码', exact: true }).click();
  await expect(page.locator('.validation-generation')).toContainText('生成完成');
  await expect(page.locator('.validation-generation')).toContainText('已发送 1 次请求');
  await expect(page.getByRole('button', { name: '采用方案并生成正确性代码', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('support/test-correctness.py', { exact: true })).toContainText('ctx.emit_correctness');
  expect(f.projects.validationAssets.get(project, pkg, version, target).evaluator_digest).toBe(before.evaluator_digest);
  expect(f.modelRequests.validationBodies).toHaveLength(1); expect(f.modelRequests.planBodies).toHaveLength(0);
  await page.reload();
  await expect(page.locator('.validation-generation')).toContainText('生成完成');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  expect(await page.locator('.test-code-card').first().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '保存测试方案草稿', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存测试方案草稿', exact: true }).click();
  await expect(page.getByText('测试方案草稿已保存', { exact: false })).toBeVisible();
  const accepted = f.projects.validationAssets.get(project, pkg, version, target);
  expect(accepted.evaluator_digest).not.toBe(before.evaluator_digest);
  expect(accepted.qualification).toBe('DRAFT');
  expect(accepted.test_plan).toEqual(before.test_plan); expect(accepted.workloads).toEqual(before.workloads);
  expect(f.modelRequests.planBodies).toHaveLength(0); expect(f.modelRequests.validationBodies).toHaveLength(1);
});

test('editing during correctness plan drafting preserves edits and disables adoption of the older proposal', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await fixture.close(); fixture = await startWebFixture({ execute: true, validationGate: gate });
  const f = fixture;
  try {
    const project = f.projects.add({ name: 'Plan edits', repository_root: f.repo, config_path: f.configPath });
    const d = await f.projects.discover(project.project_id, 'kernel');
    const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
    const before = f.projects.validationAssets.get(project, pkg, version, target);
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '', library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
    await login(page); await openTaskPreparation(page);
    await page.getByText(/^正确性测试与误差规则/).click();
    await page.getByRole('button', { name: '用 AI 起草正确性方案', exact: true }).click();
    await expect(page.locator('.validation-generation')).toContainText('已发送 1 次请求');
    await page.getByRole('tab', { name: '1 测试条件' }).click();
    if (!await page.getByLabel('独立正确性参考与失败判断', { exact: true }).isVisible()) await page.getByText(/^正确性测试与误差规则/).click();
    await page.getByLabel('独立正确性参考与失败判断', { exact: true }).fill('My independently reviewed reference');
    release();
    await expect(page.getByRole('region', { name: 'AI 正确性方案建议' })).toBeVisible();
    await expect(page.getByRole('button', { name: '采用方案并生成正确性代码', exact: true })).toBeDisabled();
    await expect(page.getByLabel('独立正确性参考与失败判断', { exact: true })).toHaveValue('My independently reviewed reference');
    expect(f.projects.validationAssets.get(project, pkg, version, target).evaluator_digest).toBe(before.evaluator_digest);
  } finally { release(); }
});

test('custom correctness generation instructions are passed directly to the model and shown in its receipt', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Custom test prompt', repository_root: f.repo, config_path: f.configPath });
  const d = await f.projects.discover(project.project_id, 'kernel');
  const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
  f.readyValidation(project, pkg, version, target);
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '', library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
  await login(page); await openTaskPreparation(page);
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  const instructions = '重点测试边界情况，失败时输出预期值和实际值。';
  await page.getByLabel('生成提示词（可选）', { exact: true }).fill(instructions);
  await page.getByRole('button', { name: '用 AI 生成正确性代码', exact: true }).click();
  await expect(page.locator('.validation-generation')).toContainText('生成完成');
  expect(JSON.stringify(f.modelRequests.validationBodies[0])).toContain(instructions);
  expect(f.modelRequests.planBodies).toHaveLength(0);
  await page.getByText('查看模型调用记录', { exact: true }).click();
  await expect(page.locator('.validation-generation')).toContainText(`生成提示词：${instructions}`);
});

test('performance generation replaces the ungenerated state with an actual program and reviewable workload details', async ({ page }) => {
  await fixture.close(); fixture = await startWebFixture({ execute: true, validationProposal: { status: 'ready',
    workloads: [{ workload_id: 'small-64', parameters: { length: 64 }, input_generation: 'i=0..63: x[i]=i/64; identical values for both roles.' }],
    benchmark_description: 'Offline fixture for kernel timing and seconds-per-call normalization.',
    supporting_files: [{ path: 'support/test-performance.py', content: 'from corepilot_test import TestContext\nctx=TestContext.for_performance(__file__)\nlib=ctx.load_library()\n# Protocol fixture only, no performance evidence.\n' }] } });
  const f = fixture;
  const project = f.projects.add({ name: 'Performance code', repository_root: f.repo, config_path: f.configPath });
  const d = await f.projects.discover(project.project_id, 'kernel');
  const pkg = d.evidence.generated.package_id, version = d.evidence.generated.version, target = d.targets[0].target_id;
  const original = f.readyValidation(project, pkg, version, target);
  const before = f.projects.validationAssets.save(project, pkg, version, target, { ...original, expected_digest: original.evaluator_digest, source: 'edited',
    workloads: [{ workload_id: 'small-64', parameters: {}, threads: 1, critical: false, weight: 1 }], test_plan: { ...original.test_plan, resources: { cpu_set: '0', numa_node: 0 } } });
  const artifact = path.join(f.root, 'baseline.so'); fs.writeFileSync(artifact, 'offline baseline fixture');
  await f.projects.validationAssets.bindSingleBaseline(project, pkg, version, target, { artifactPath: artifact,
    sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'), library: 'fixture', versionLabel: '1', source: { kind: 'upload', detail: 'fixture' } });
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '', baseline_artifact: artifact, library_package: { package_id: pkg, package_version: version, target_id: target } } });
  await login(page); await openTaskPreparation(page);
  await page.getByRole('tab', { name: '2 测试代码' }).click();
  await expect(page.getByText('尚未生成性能测试程序', { exact: true })).toBeVisible();
  await expect(page.getByLabel('性能测试脚本', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '用 AI 生成两库性能代码', exact: true }).click();
  await expect(page.locator('.validation-generation')).toContainText('生成完成');
  await expect(page.getByLabel('support/test-performance.py', { exact: true })).toContainText('ctx.load_library()');
  await expect(page.getByText('尚未生成性能测试程序', { exact: true })).toHaveCount(0);
  expect(f.projects.validationAssets.get(project, pkg, version, target).workloads[0].parameters).toEqual({});
  await page.getByText('查看生成草稿的性能负载与计时方式', { exact: true }).click();
  await expect(page.locator('.generated-performance-conditions')).toContainText('length=64');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载性能代码', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('test-performance.py');
  await page.getByRole('button', { name: '保存测试方案草稿', exact: true }).click();
  await expect(page.getByText('测试方案草稿已保存', { exact: false })).toBeVisible();
  const saved = f.projects.validationAssets.get(project, pkg, version, target);
  expect(saved.workloads[0].parameters).toEqual({ length: 64 }); expect(saved.workloads[0].input_generation).toContain('i=0..63');
  expect(saved.test_plan).toEqual(before.test_plan); expect(saved.cases).toEqual(before.cases);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
