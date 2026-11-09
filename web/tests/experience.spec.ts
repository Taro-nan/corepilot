import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { startWebFixture, repositoryRoot } from '../../tests/web-fixture.js';
import { finishWorkflowExecution, initialOptimizationWorkflowRecord } from '../../src/workflow/optimization-workflow.js';
import { OptimizationRuntime } from '../../src/core/optimization-runtime.js';
import { seedBlockedValidation } from '../../tests/validation-recovery-fixture.js';
import { seedApprovalFacts } from '../../tests/workflow-approval-fixture.js';

let fixture: Awaited<ReturnType<typeof startWebFixture>>;
test.beforeEach(async () => { fixture = await startWebFixture(); });
test.afterEach(async () => { await fixture.close(); });
const screenshots = path.join(repositoryRoot, 'build/ux-review');
async function login(page: Page) {
  await page.goto(fixture.url);
  await page.getByLabel('管理员访问凭据').fill(fixture.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await expect(page.getByRole('main')).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test('first-use guidance and advanced settings keep context, expose changes while collapsed, and save through the shared API', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: '体验验证 · 示例库', repository_root: f.repo, config_path: f.configPath });
  await page.route('**/v1/projects/*/models', route => route.fulfill({ json: { models: [{ id: 'fixture-model', label: 'Fixture model' }] } }));
  await login(page);
  const guide = page.getByRole('region', { name: '项目准备与下一步' });
  await expect(guide).toContainText('下一步：创建优化任务');
  await expect(guide).toContainText('测试可以稍后单独进行');
  await expect(guide.locator('li')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '创建优化任务', exact: true })).toHaveCount(1);
  await expect(page.getByText(project.config_path, { exact: true })).not.toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'fixture-overview.png'), fullPage: true });
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  const advanced = page.locator('.model-advanced');
  await expect(page.getByLabel('模型代理（可选）')).not.toBeVisible();
  await advanced.locator('summary').click();
  await page.getByLabel('模型代理（可选）').fill('http://127.0.0.1:7890');
  await page.getByLabel('推理强度').selectOption('high');
  await advanced.locator('summary').click();
  await expect(advanced.locator('summary')).toContainText('代理已配置');
  await expect(advanced.locator('summary')).toContainText('high');
  await expect(advanced.locator('summary')).toContainText('已调整');
  await expect(page.getByLabel('模型代理（可选）')).not.toBeVisible();
  await page.getByRole('navigation').getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.locator('.model-advanced > summary')).toContainText('high');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('.config-layout .feedback')).toContainText('配置已保存');
  expect(f.projects.config(project.project_id).model.proxy).toBe('http://127.0.0.1:7890');
  expect(f.projects.config(project.project_id).model.reasoning_effort).toBe('high');
  await page.reload();
  await expect(page.locator('.model-advanced > summary')).toContainText('high');
  await expect(page.getByLabel('模型代理（可选）')).not.toBeVisible();
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
    await page.screenshot({ path: path.join(screenshots, 'fixture-settings-' + width + '.png'), fullPage: true });
  }
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
});

test('overview changes project branch, machine and target without losing task draft or mixing validation', async ({ page }) => {
  const f = fixture;
  f.git('branch', 'feature/overview');
  fs.appendFileSync(path.join(f.repo, 'include', 'kernel.h'), '\nint kernel_extra(void);\n');
  const project = f.projects.add({ name: 'Overview defaults fixture', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
  const discovery = await f.projects.setup.inspect(project);
  expect(discovery.functions.map(item => item.symbol)).toContain('kernel_extra');
  const first = f.projects.machines.save({ name: 'Overview CPU A', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: 'unused-a' } });
  const second = f.projects.machines.save({ name: 'Overview CPU B', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:2', token: 'unused-b' } });
  f.projects.bindMachine(project.project_id, first.machine_id);
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  let task = page.getByRole('dialog', { name: '创建优化任务' });
  await task.locator('summary').filter({ hasText: '高级设置' }).click();
  await task.getByLabel('运行时间（分钟）').fill('25');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /更换优化分支/ }).click();
  let picker = page.getByRole('dialog', { name: '更换优化分支' });
  await picker.getByLabel('优化分支').selectOption('feature/overview');
  await picker.getByRole('button', { name: '保存选择' }).click();
  await expect(page.getByRole('button', { name: /更换优化分支/ })).toContainText('feature/overview');
  expect(f.git('branch', '--show-current')).toBe('main');

  await page.getByRole('button', { name: /更换执行机器/ }).click();
  picker = page.getByRole('dialog', { name: '更换执行机器' });
  await picker.getByLabel('执行机器').selectOption(second.machine_id);
  await picker.getByRole('button', { name: '保存选择' }).click();
  await expect(page.getByRole('button', { name: /更换执行机器/ })).toContainText('Overview CPU B');

  await page.getByRole('button', { name: /更换目标函数/ }).click();
  picker = page.getByRole('dialog', { name: '更换目标函数' });
  await picker.getByLabel('搜索或输入函数名').fill('kernel_extra');
  await picker.locator('.context-function-list').getByRole('button').filter({ hasText: 'kernel_extra' }).click();
  await expect(picker).toContainText('现有测试方案用于 kernel');
  await picker.getByRole('button', { name: '保存选择' }).click();
  await expect(page.getByRole('button', { name: /更换目标函数/ })).toContainText('kernel_extra');
  await expect(page.getByRole('region', { name: '项目准备与下一步' })).toContainText('需要匹配的测试方案');
  await page.reload();
  await expect(page.getByRole('button', { name: /更换目标函数/ })).toContainText('kernel_extra');
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  task = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(task.getByLabel('优化函数')).toHaveValue('kernel_extra');
  await expect(task.getByLabel('优化分支')).toHaveValue('feature/overview');
  await expect(task.getByLabel('执行机器', { exact: true })).toHaveValue(second.machine_id);
  await expect(page.locator('.composer-actions')).toContainText('25 分钟');
  await expect(task.locator('.notice').filter({ hasText: '当前测试方案用于 kernel' })).toBeVisible();
  await expect(task.getByRole('button', { name: '开始优化' })).toBeDisabled();
  // A task's one-off selections must reach preparation and survive its return path.
  // They differ from project defaults; neither opening nor refreshing starts a job.
  await task.getByLabel('优化分支').selectOption('main');
  await task.getByLabel('执行机器', { exact: true }).selectOption(first.machine_id);
  const planLookup = page.waitForResponse(response => response.url().includes('/validation-plans?')
    && new URL(response.url()).searchParams.get('function_name') === 'kernel_extra');
  await task.getByRole('button', { name: '准备构建与验证', exact: true }).click();
  expect((await planLookup).status()).toBe(200);
  const preparation = page.getByRole('region', { name: '当前任务准备上下文' });
  await expect(preparation).toContainText('kernel_extra');
  await expect(preparation).toContainText('main');
  await expect(preparation).toContainText('Overview CPU A');
  await expect(page.getByText(/已保存方案属于 kernel/)).toBeVisible();
  await expect(page.getByText('任务目标：kernel_extra', { exact: true })).toBeVisible();
  await expect(page.getByLabel('优化目标', { exact: true })).toHaveCount(0);
  await expect(page.locator('.notice').filter({ hasText: '试跑环境与本次任务不同' })).toContainText('feature/overview');
  await page.reload();
  await expect(preparation).toContainText('kernel_extra');
  await expect(preparation).toContainText('Overview CPU A');
  await page.getByRole('button', { name: '返回任务配置', exact: true }).click();
  task = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(task.getByLabel('优化函数')).toHaveValue('kernel_extra');
  await expect(task.getByLabel('优化分支')).toHaveValue('main');
  await expect(task.getByLabel('执行机器', { exact: true })).toHaveValue(first.machine_id);
  await expect(page.locator('.composer-actions')).toContainText('25 分钟');
  await expect(task.getByRole('button', { name: '开始优化' })).toBeDisabled();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /更换目标函数/ }).click();
  picker = page.getByRole('dialog', { name: '更换目标函数' });
  await picker.locator('.context-function-list').getByRole('button').filter({ hasText: 'kernel' }).first().click();
  await picker.getByRole('button', { name: '保存选择' }).click();
  await expect(page.getByRole('button', { name: /更换目标函数/ })).toContainText('kernel');
  await page.screenshot({ path: path.join(screenshots, 'fixture-overview-context.png'), fullPage: true });
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  task = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(task.getByLabel('优化函数')).toHaveValue('kernel');
  await expect(page.locator('.composer-actions')).toContainText('25 分钟');
  await expect(task.getByRole('button', { name: '开始优化' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 900 }); await noOverflow(page);

  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await page.getByRole('button', { name: '目标机器', exact: true }).click();
  await page.getByRole('combobox', { name: '执行机器', exact: true }).selectOption(first.machine_id);
  await page.getByRole('navigation').getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: /更换执行机器/ }).click();
  picker = page.getByRole('dialog', { name: '更换执行机器' });
  await picker.getByLabel('执行机器').selectOption(first.machine_id);
  await picker.getByRole('button', { name: '保存选择' }).click();
  await expect(picker.getByRole('alert')).toContainText('有未保存的更改');
  expect(f.projects.config(project.project_id).runner).toMatchObject({ machine_id: second.machine_id });
  await picker.getByRole('button', { name: '取消' }).click();
  await page.getByRole('navigation').getByRole('button', { name: '模型与机器', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '执行机器', exact: true })).toHaveValue(first.machine_id);
  expect(f.service.list()).toHaveLength(0);
  expect(f.modelRequests.inference).toBe(0);
});

test('task preparation lists the current project’s matching plans and explicitly adopts the chosen plan and its own baseline', async ({ page }) => {
  const f = fixture;
  fs.appendFileSync(path.join(f.repo, 'include', 'kernel.h'), '\nint kernel_extra(void);\n');
  fs.appendFileSync(path.join(f.repo, 'kernel.c'), '\nint kernel_extra(void) { return 3; }\n');
  const project = f.projects.add({ name: 'Plan owner', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
  const one = await f.projects.discover(project.project_id, 'kernel_extra');
  const two = await f.projects.discover(project.project_id, 'kernel_extra');
  expect(one.evidence.generated.version).not.toBe(two.evidence.generated.version);
  const firstPath = path.join(f.root, 'first-baseline.so');
  const secondPath = path.join(f.root, 'second-baseline.so');
  for (const [draft, artifactPath, contents, label] of [[one, firstPath, 'first fixture', 'First reference'], [two, secondPath, 'second fixture', 'Second reference']] as const) {
    const bytes = Buffer.from(contents); fs.writeFileSync(artifactPath, bytes);
    await f.projects.validationAssets.bindSingleBaseline(project, draft.evidence.generated.package_id, draft.evidence.generated.version, draft.targets[0].target_id,
      { artifactPath, sha256: createHash('sha256').update(bytes).digest('hex'), library: label, versionLabel: '1', source: { kind: 'upload', detail: 'fixture' } });
  }
  const otherRoot = path.join(f.root, 'other-source');
  fs.mkdirSync(path.join(otherRoot, 'include'), { recursive: true });
  fs.writeFileSync(path.join(otherRoot, 'include', 'other.h'), 'int kernel_extra(void);\n');
  fs.writeFileSync(path.join(otherRoot, 'other.c'), 'int kernel_extra(void) { return 4; }\n');
  const other = f.projects.add({ name: 'Other project', repository_root: otherRoot });
  const otherDraft = await f.projects.discover(other.project_id, 'kernel_extra');
  const before = fs.readFileSync(project.config_path, 'utf8');

  await login(page);
  await page.getByLabel('当前项目').selectOption(project.project_id);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const task = page.getByRole('dialog', { name: '创建优化任务' });
  await task.getByLabel('优化函数').fill('kernel_extra');
  await expect(task.getByRole('button', { name: '开始优化' })).toBeDisabled();
  await task.getByRole('button', { name: '准备构建与验证', exact: true }).click();
  await expect(page.getByRole('button', { name: '已有方案 · 2' })).toHaveAttribute('aria-pressed', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  await expect(page.getByRole('group', { name: '测试方案方式' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('link', { name: '从完整目录选择' })).toHaveAttribute('href', '#/validation');
  const choices = page.getByLabel('当前函数的测试方案', { exact: true });
  const selected = choices.locator('option').filter({ hasText: two.evidence.generated.version });
  await expect(selected).toHaveCount(1);
  await expect(choices.locator('option').filter({ hasText: one.evidence.generated.version })).toHaveCount(1);
  await expect(choices.locator('option').filter({ hasText: otherDraft.evidence.generated.version })).toHaveCount(0);
  await choices.selectOption((await selected.getAttribute('value'))!);
  expect(fs.readFileSync(project.config_path, 'utf8')).toBe(before);
  await page.getByRole('button', { name: '使用所选方案', exact: true }).click();
  await expect(page.getByText('当前目标：kernel_extra。先确定条件，再接入测试代码，最后试运行。')).toBeVisible();
  await page.locator('summary').filter({ hasText: '高级：手动指定已准备的基线文件' }).click();
  await expect(page.getByLabel('比较基线文件', { exact: true })).toHaveValue(secondPath);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByText('配置已保存；请按接入状态补齐未完成项。')).toBeVisible();
  const saved = f.projects.config(project.project_id).validation;
  expect(saved.library_package).toEqual({ package_id: two.evidence.generated.package_id, package_version: two.evidence.generated.version, target_id: two.targets[0].target_id });
  expect(saved.baseline_artifact).toBe(secondPath);
  expect(f.projects.packageLoader.resolveSelection(saved.library_package!).bundle.qualification.status).toBe('DRAFT');
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
});

test('a single matching plan is offered without changing the saved project until the user chooses it', async ({ page }) => {
  const f = fixture;
  fs.appendFileSync(path.join(f.repo, 'include', 'kernel.h'), '\nint kernel_extra(void);\n');
  fs.appendFileSync(path.join(f.repo, 'kernel.c'), '\nint kernel_extra(void) { return 3; }\n');
  const project = f.projects.add({ name: 'Single matching plan', repository_root: f.repo, config_path: f.configPath });
  await f.projects.discover(project.project_id, 'kernel_extra');
  const before = fs.readFileSync(project.config_path, 'utf8');
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const task = page.getByRole('dialog', { name: '创建优化任务' });
  await task.getByLabel('优化函数').fill('kernel_extra');
  await task.getByRole('button', { name: '准备构建与验证', exact: true }).click();
  await expect(page.getByRole('button', { name: '已有方案 · 1' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '使用所选方案' })).toBeEnabled();
  await expect(page.getByText('已保存方案属于 kernel，请为 kernel_extra 选择方案。')).toBeVisible();
  expect(fs.readFileSync(project.config_path, 'utf8')).toBe(before);
  expect(f.service.list()).toHaveLength(0);
});

test('task preparation preserves unapplied inputs across navigation and detects a newer server version', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Unsaved test inputs', repository_root: f.repo, config_path: f.configPath });
  const discovered = await f.projects.discover(project.project_id, 'kernel');
  const pkg = discovered.evidence.generated.package_id, version = discovered.evidence.generated.version, target = discovered.targets[0].target_id;
  const initial = f.readyValidation(project, pkg, version, target);
  f.projects.validationAssets.save(project, pkg, version, target, { ...initial, expected_digest: initial.evaluator_digest, source: 'edited',
    test_plan: { ...initial.test_plan, execution_matrix: { thread_counts: [1], profiles: [
      { id: 'p1', name: 'CPU fixture', cpu_set: '0-3', numa_node: 0, cpu_allocation: 'per_thread', omp_proc_bind: 'close' },
    ] } } });
  f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id), validation: { testpack: '',
    library_package: { package_id: pkg, package_version: version, target_id: target }, baseline_artifact: '' } });
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const initialTask = page.getByRole('dialog', { name: '创建优化任务' });
  await initialTask.getByRole('radio', { name: /优化并自动验证/ }).check();
  await initialTask.getByRole('button', { name: '准备构建与验证' }).click();
  const editor = page.locator('.validation-editor');
  await expect(editor.getByText('准备当前函数的测试方案', { exact: true })).toBeVisible();
  const inventory = editor.locator('.test-inventory').filter({ has: page.getByText('性能负载', { exact: true }) });
  await inventory.getByText('添加输入参数', { exact: true }).first().click();
  await inventory.getByLabel('性能负载新增参数名').fill('unfinished_width');
  await inventory.locator('summary').filter({ hasText: '高级：编辑性能负载 JSON' }).click();
  await inventory.getByLabel('性能负载 JSON').fill('[{"unfinished":');
  await editor.getByText('其他线程数', { exact: true }).click();
  await editor.getByLabel('自定义线程数').fill('1, 3,');
  await editor.getByRole('button', { name: '保存条件并准备测试代码' }).click();
  await expect(editor).toContainText('还有未应用的输入参数、JSON 或线程数');
  await page.getByRole('button', { name: '返回任务配置', exact: true }).click();
  const task = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(task).toContainText('还有未保存的配置或测试修改');
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  const saved = f.projects.validationAssets.get(project, pkg, version, target);
  f.projects.validationAssets.save(project, pkg, version, target, { ...saved, expected_digest: saved.evaluator_digest, source: 'edited', oracle_description: 'An independently updated reference.' });
  await task.getByRole('button', { name: '准备构建与验证', exact: true }).click();
  await expect(editor).toContainText('服务器上的测试方案已更新或已启用');
  await expect(inventory.getByLabel('性能负载新增参数名')).toHaveValue('unfinished_width');
  await expect(inventory.getByLabel('性能负载 JSON')).toHaveValue('[{"unfinished":');
  await expect(editor.getByLabel('自定义线程数')).toHaveValue('1, 3,');
  await editor.getByRole('button', { name: '放弃测试修改并重新读取' }).click();
  await expect(editor).not.toContainText('服务器上的测试方案已更新或已启用');
  expect(f.projects.validationAssets.get(project, pkg, version, target).oracle_description.trim()).toBe('An independently updated reference.');
  expect(f.modelRequests.inference).toBe(0);
  expect(f.service.list()).toHaveLength(0);
});

test('task draft restores after close and refresh, advanced validation reveals hidden invalid fields, and preflight uses the selected machine', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Task setup fixture', repository_root: f.repo, config_path: f.configPath });
  const registry = f.projects.machines;
  const first = registry.save({ name: 'Fixture CPU A', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:1', token: 'not-used' }, target: { ssh_alias: 'fixture-a', workspace_root: '/fixture/a' } });
  const second = registry.save({ name: 'Fixture CPU B', runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:2', token: 'not-used' }, target: { ssh_alias: 'fixture-b', workspace_root: '/fixture/b' } });
  const original = fs.readFileSync(project.config_path, 'utf8');
  const checks: Record<string, unknown>[] = [];
  await page.route('**/v1/projects/*/check', async route => { checks.push(route.request().postDataJSON()); await route.fulfill({ status: 400, json: { error: { code: 'FIXTURE_OFFLINE', message: '所选示例机器离线，请检查 Runner 连接后重试。' } } }); });
  await login(page);
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(dialog.getByLabel('运行时间（分钟）')).not.toBeVisible();
  await dialog.getByLabel('执行机器', { exact: true }).selectOption(second.machine_id);
  await dialog.locator('summary').filter({ has: page.getByText('高级设置', { exact: true }) }).click();
  await dialog.getByLabel('运行时间（分钟）').fill('25');
  await dialog.getByLabel('最多评估候选数').fill('3');
  await dialog.getByLabel('优先调查文件（可选）').fill('kernel.c');
  await dialog.locator('summary').filter({ has: page.getByText('高级设置', { exact: true }) }).click();
  await expect(dialog.locator('summary').filter({ has: page.getByText('高级设置', { exact: true }) })).toContainText('25 分钟 · 3 个候选');
  await expect(page.locator('.composer-actions')).toContainText('25 分钟 · 3 个候选');
  await page.setViewportSize({ width: 1280, height: 720 });
  const submit = await dialog.getByRole('button', { name: '开始优化', exact: true }).boundingBox();
  expect(submit).not.toBeNull(); expect(submit!.y + submit!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: '创建优化任务', exact: true })).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(dialog.getByLabel('执行机器', { exact: true })).toHaveValue(second.machine_id);
  await expect(page.locator('.composer-actions')).toContainText('25 分钟 · 3 个候选');
  await dialog.getByRole('button', { name: '运行前检查', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('所选示例机器离线');
  expect(checks.at(-1)?.machine_id).toBe(second.machine_id);
  expect(checks.at(-1)?.machine_id).not.toBe(first.machine_id);
  await expect(dialog.getByLabel('执行机器', { exact: true })).toHaveValue(second.machine_id);
  await dialog.locator('summary').filter({ has: page.getByText('高级设置', { exact: true }) }).click();
  await dialog.getByLabel('运行时间（分钟）').fill('0');
  await dialog.locator('summary').filter({ has: page.getByText('高级设置', { exact: true }) }).click();
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByLabel('运行时间（分钟）')).toBeVisible();
  expect(await dialog.getByLabel('运行时间（分钟）').evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  expect(f.service.list()).toHaveLength(0); expect(f.modelRequests.inference).toBe(0);
  expect(fs.readFileSync(project.config_path, 'utf8')).toBe(original);
  await page.screenshot({ path: path.join(screenshots, 'fixture-task-composer-1280.png'), fullPage: true });
});

test('invalid experimental evidence remains distinct from correctness, approval and delivery, with logs and identities on demand', async ({ page }) => {
  const f = fixture;
  const seeded = await seedBlockedValidation(f);
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(seeded.workflowId));
  const states = page.getByLabel('验证与交付状态');
  await expect(states).toBeVisible();
  await expect(states.locator('dt')).toHaveText(['实验执行', '正确性', '性能验收', '人工批准', '源码交付']);
  await expect(states.locator('div').filter({ has: page.getByText('人工批准', { exact: true }) })).toContainText('未记录');
  await expect(states.locator('div').filter({ has: page.getByText('源码交付', { exact: true }) })).toContainText('未交付');
  await expect(page.getByRole('heading', { name: '执行进度', exact: true })).toBeVisible();
  await expect(page.locator('.stage-evidence[open]')).toHaveCount(0);
  await expect(page.getByText('验证环境异常，候选已保留', { exact: true })).toBeVisible();
  const experiments = page.locator('summary').filter({ has: page.getByText('实验记录', { exact: true }) });
  await experiments.focus(); await page.keyboard.press('Enter');
  await expect(experiments.locator('..').getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '日志与详情' }).click();
  await expect(page.getByRole('dialog')).toContainText('EVALUATOR_FAILURE');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('summary').filter({ has: page.getByText('任务标识与测试资产', { exact: true }) }).click();
  await expect(page.getByRole('button', { name: '复制任务标识', exact: true })).toBeVisible();
  for (const width of [1440, 1280, 390]) {
    await page.setViewportSize({ width, height: 900 }); await noOverflow(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(screenshots, 'fixture-blocked-task-' + width + '.png'), fullPage: true });
  }
  expect(f.modelRequests.inference).toBe(0);
  expect(f.store.listExperiments(seeded.candidate.task_id)).toHaveLength(1);
});

test('unconfirmed cancellation remains recoverable in the API and task page', async ({ page }) => {
  const f = fixture; const seeded = await seedBlockedValidation(f);
  const record = f.service.get(seeded.workflowId)!;
  const runtime = new OptimizationRuntime(f.store);
  const experiment = runtime.startExperiment({ taskId: record.optimization_task_id!, candidateId: seeded.candidate.candidate_id, type: 'FORMAL_EVALUATION' });
  runtime.failExperiment({ experimentId: experiment.experiment_id, error: 'Runner 未确认停止', cancelled: true, remoteStateUnknown: true });
  // A legacy UNKNOWN record may contain historical NOT_EXECUTED placeholders;
  // keep the bytes but do not display them as confirmed facts.
  const legacy = f.store.getExperiment(experiment.experiment_id)!;
  expect(legacy.evaluation).toBeNull();
  legacy.evaluation = { build: 'NOT_EXECUTED', correctness: 'NOT_EXECUTED', performance: 'NOT_EXECUTED' };
  f.store.saveExperiment(legacy);
  const task = runtime.getTask(record.optimization_task_id!);
  f.store.saveOptimizationTask({ ...task, status: 'RUNNING' });
  Object.assign(record, { status: 'GENERATING', experiment_id: experiment.experiment_id, candidate_evaluation_feedback: null,
    candidate_evaluation_decision: null, stop_reason: undefined });
  f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
  finishWorkflowExecution(f.store, record.workflow_id, task.task_id, { status: 'INTERRUPTED', error: 'Runner 尚未确认停止，请核对原实验。',
    progress: { phase: 'INTERRUPTED', last_event: 'Runner 尚未确认停止，请核对原实验。' } }, value => value);
  expect(f.store.getOptimizationTask(task.task_id)?.status).toBe('INTERRUPTED');
  const result = await fetch(`${f.url}/v1/workflows/${encodeURIComponent(record.workflow_id)}`, { headers: { authorization: `Bearer ${f.token}` } });
  expect(result.status).toBe(200);
  expect((await result.json() as { workflow: { status: string } }).workflow.status).toBe('INTERRUPTED');
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(record.workflow_id));
  await expect(page.locator('.page-heading .badge')).toContainText('已中断，可继续');
  await expect(page.getByLabel('验证与交付状态')).toContainText('待核对');
  await page.locator('summary').filter({ hasText: '实验记录' }).click();
  const lastExperiment = page.locator('.evidence-disclosure table tbody tr').last();
  await expect(lastExperiment.locator('td').nth(3)).toHaveText('待核对');
  await expect(lastExperiment.locator('td').nth(4)).toHaveText('待核对');
  expect(f.store.getExperiment(experiment.experiment_id)?.evaluation?.correctness).toBe('NOT_EXECUTED');
  await expect(page.locator('.agent-session')).toContainText('继续时会恢复工作区，并核对已有 Runner 实验');
  await expect(page.locator('main')).not.toContainText('已取消');
});

test('an interrupted delivery can be checked in the page without merging when verification is no longer valid', async ({ page }) => {
  const f = fixture;
  const seeded = await seedBlockedValidation(f);
  const record = f.service.get(seeded.workflowId)!;
  const now = new Date().toISOString();
  record.status = 'WAITING_APPROVAL';
  record.delivery_operation = { schema_version: 1, operation_id: '12345678-1234-4234-8234-123456789012',
    status: 'NEEDS_ATTENTION', target: { kind: 'BRANCH', branch: 'main' }, repository: f.repo,
    editing_workspace: seeded.workspace.editing, validation_workspace: seeded.workspace.validation,
    baseline_commit: seeded.workspace.baseline_commit, candidate_id: seeded.candidate.candidate_id,
    candidate_commit: seeded.checkpoint.commit, candidate_tree: seeded.checkpoint.tree,
    formal_experiment_id: seeded.experiment.experiment_id, revalidation_experiment_id: 'experiment:missing-fixture',
    commit_message: 'fixture delivery', prepared_commit: null, requested_at: now, updated_at: now,
    last_checked_at: null, observation: 'UNKNOWN', message: '此前的交付需要核对。',
    stop_confirmation_required: false, stop_confirmed_at: null, cleanup: 'PENDING', cleanup_message: null };
  f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(record.workflow_id));
  const panel = page.getByRole('region', { name: '源码交付进度' });
  await expect(panel).toContainText('此前的交付需要核对');
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '核对交付状态', exact: true }).click();
  await expect(panel).toContainText('历史交付请求没有关联正式批准');
  await expect(panel.getByRole('button', { name: '继续原交付', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(panel).toContainText('历史交付请求没有关联正式批准');
  const failed = f.service.get(record.workflow_id)!;
  failed.status = 'FAILED';
  f.store.saveOptimizationWorkflowJson(failed.workflow_id, JSON.stringify(failed));
  await page.reload();
  await expect(page.getByRole('button', { name: '重新验证当前候选', exact: true })).toHaveCount(0);
  const reproduction = page.locator('details').filter({ has: page.getByText('重建复现与身份清单', { exact: true }) });
  await reproduction.locator('summary').click();
  await expect(reproduction).toContainText('请先核对或撤回未完成的交付请求');
  await expect(reproduction.getByRole('button', { name: '在 Runner 重建复现' })).toBeDisabled();
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'fixture-delivery-recovery.png'), fullPage: true });
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: '撤回未完成交付', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const history = page.locator('details').filter({ has: page.getByText('历史交付请求', { exact: true }) });
  await expect(history).toBeVisible();
  await history.locator('summary').click();
  await expect(history).toContainText('已撤回');
  await expect(reproduction.getByRole('button', { name: '在 Runner 重建复现' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '重新验证当前候选', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('历史交付请求', { exact: true })).toBeVisible();
  expect(f.git('rev-parse', 'HEAD')).toBe(seeded.workspace.baseline_commit);
  expect(f.store.getCandidateApproval(seeded.candidate.candidate_id)).toBeNull();
  expect(f.service.get(record.workflow_id)?.delivery_operation).toBeUndefined();
  expect(f.service.get(record.workflow_id)?.delivery_history?.at(-1)?.status).toBe('WITHDRAWN');
  expect(f.modelRequests.inference).toBe(0);
});

test('a stale review status does not offer delivery when the latest recorded verification is invalid', async ({ page }) => {
  const f = fixture;
  const seeded = await seedBlockedValidation(f, true);
  const facts = seedApprovalFacts(f, seeded.workflowId);
  const workflow = f.service.get(seeded.workflowId)!;
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(workflow.workflow_id));
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toBeVisible();
  const repeated = f.store.getExperiment(facts.repeated.experiment_id)!;
  f.store.createExperiment({ ...repeated, experiment_id: 'experiment:later-ui-invalid', validity: 'INVALID', failure_category: 'EVALUATOR_FAILURE' });
  await page.reload();
  await expect(page.getByText('需要先核对当前验证记录', { exact: true })).toBeVisible();
  await expect(page.getByText(/最近一次独立复验未形成完整有效/)).toBeVisible();
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toHaveCount(0);
  await expect(page.locator('.customer-report-summary')).toContainText('尚无满足完整验证条件的当前交付建议');
  expect(f.git('rev-parse', 'HEAD')).toBe(seeded.workspace.baseline_commit);
  expect(f.store.getCandidateApproval(seeded.candidate.candidate_id)).toBeNull();
  expect(f.store.getExperiment(repeated.experiment_id)).toEqual(repeated);
});

test('legacy point estimates remain visible without offering a new approval', async ({ page }) => {
  const f = fixture;
  const seeded = await seedBlockedValidation(f, true);
  seedApprovalFacts(f, seeded.workflowId, { statisticalGate: false });
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(seeded.workflowId));
  const report = page.locator('.customer-report-summary');
  await expect(report).toContainText('原实验通过旧版评价口径');
  await expect(report).toContainText('确认新版测试方案');
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toHaveCount(0);
  await expect(page.getByText('尚不满足当前批准条件', { exact: true })).toBeVisible();
  await expect(page.getByLabel('验证与交付状态')).toContainText('待补充批准依据');
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'fixture-legacy-statistics.png'), fullPage: true });
  expect(f.store.getCandidateApproval(seeded.candidate.candidate_id)).toBeNull();
  expect(f.modelRequests.inference).toBe(0);
});

test('a missing Runner plan explains why new approval is unavailable', async ({ page }) => {
  const f = fixture;
  const seeded = await seedBlockedValidation(f, true);
  const facts = seedApprovalFacts(f, seeded.workflowId);
  const experiment = f.store.getExperiment(facts.repeated.experiment_id)!;
  delete experiment.declared_context.runner_execution_plan;
  f.store.saveExperiment(experiment);
  await login(page);
  await page.goto(f.url + '/#/tasks/' + encodeURIComponent(seeded.workflowId));
  await expect(page.locator('.customer-report-summary')).toContainText('缺少原始 Runner 执行计划');
  await expect(page.getByRole('button', { name: '审阅与批准', exact: true })).toHaveCount(0);
  expect(f.store.getCandidateApproval(seeded.candidate.candidate_id)).toBeNull();
});

test('task filters survive refresh and detail navigation without surfacing raw identifiers by default', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: 'Filter fixture', repository_root: f.repo, config_path: f.configPath });
  for (const [name, status, branch] of [['vector_add', 'FAILED', 'feature/vector'], ['matrix_product', 'WAITING_APPROVAL', 'main']] as const) {
    const record = initialOptimizationWorkflowRecord('workflow:' + name, { functionName: name, entryFile: null, configPath: f.configPath, repositoryRoot: f.repo, enablePerformance: true });
    f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify({ ...record, status, source_branch: branch }));
  }
  await login(page);
  await page.getByRole('navigation').getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByLabel('搜索任务').fill('vector');
  await page.getByLabel('筛选分支').selectOption('feature/vector');
  await page.getByLabel('筛选状态').selectOption('failed');
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('搜索任务')).toHaveValue('vector');
  await expect(page.getByLabel('筛选分支')).toHaveValue('feature/vector');
  await expect(page.getByLabel('筛选状态')).toHaveValue('failed');
  await expect(page.getByText('workflow:vector_add', { exact: true })).not.toBeVisible();
  await page.locator('.workflow-list').getByRole('button', { name: '查看任务', exact: true }).click();
  await page.getByRole('button', { name: '返回任务列表' }).click();
  await expect(page.getByLabel('搜索任务')).toHaveValue('vector');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.locator('.workflow-list tbody tr')).toHaveCount(2);
  expect(f.modelRequests.inference).toBe(0);
});

test('execution view explains a real-shaped queue snapshot, summarizes recent tools and keeps full logs available without starting work', async ({ page }) => {
  const f = fixture;
  f.projects.add({ name: '交互验证 · 示例任务', repository_root: f.repo, config_path: f.configPath });
  const record = initialOptimizationWorkflowRecord('workflow:execution-preview', { functionName: 'vector_add', entryFile: null, configPath: f.configPath, repositoryRoot: f.repo, enablePerformance: true });
  const stored = { ...record, status: 'GENERATING', source_branch: 'feature/vector', progress: { phase: 'FORMAL_EVALUATION',
    last_event: '示例：候选已固定，等待独占资源', runner_status: 'PENDING', runner_step: 'CORRECTNESS',
    runner_queue: { position: 2, reason: '等待独占测量时段（示例）', wait_ms: 1500, waiting_for: 'fixture-resource-holder' } } };
  f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(stored));
  // Only the browser's observation is simulated. No executor or model is started.
  await page.route(/\/v1\/workflows\?/, async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), active_workflow_ids: [record.workflow_id] } }); });
  await page.route(/\/v1\/workflows\/[^/]+\/events/, async route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
    await route.fulfill({ json: { next_cursor: 2, events: after ? [] : [
      { id: 1, timestamp: record.created_at, kind: 'tool_call', tool_name: 'search_code', text: '搜索向量化循环和尾部处理（示例）', is_error: false },
      { id: 2, timestamp: record.created_at, kind: 'progress', text: '候选已固定，等待执行机器的独占时段（示例）', is_error: false },
    ] } });
  });
  await login(page);
  await page.locator('.workflow-list').getByRole('button', { name: '查看任务', exact: true }).click();
  await expect(page.getByLabel('当前执行阶段')).toContainText('正式测试与测量');
  await expect(page.getByLabel('当前执行阶段')).toContainText('排队位置 2');
  await expect(page.getByLabel('当前执行阶段')).toContainText('等待独占测量时段');
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toBeVisible();
  await expect(page.getByLabel('最近进展').getByRole('button')).toHaveCount(2);
  await expect(page.getByLabel('Agent 过程记录')).not.toBeVisible();
  await page.locator('summary').filter({ has: page.getByText('完整过程记录', { exact: true }) }).click();
  await expect(page.getByLabel('Agent 过程记录')).toBeVisible();
  await page.locator('summary').filter({ has: page.getByText('完整过程记录', { exact: true }) }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'fixture-running-task.png') });
  await page.setViewportSize({ width: 1280, height: 800 }); await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(screenshots, 'fixture-running-task-1280.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
  expect(f.service.activeWorkflowIds()).toHaveLength(0);
  expect(f.modelRequests.inference).toBe(0);
});
