import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { startWebFixture, repositoryRoot } from '../../tests/web-fixture.js';
import type { CreateTestingTask, TestingAsset, TestingPlanPreview, TestingTaskDetails, TestingTaskRecord } from '../../src/contracts/testing.js';
import { ApiClient } from '../../src/client/api-client.js';
import { loadSourceOptimizationPreflight, sourceOptimizationContractDigest } from '../../src/workflow/source-optimization.js';

let fixture: Awaited<ReturnType<typeof startWebFixture>>;
test.beforeEach(async () => { fixture = await startWebFixture({ execute: true }); });
test.afterEach(async () => { await fixture.close(); });
const digest = 'a'.repeat(64);
const ref = { package_id: 'fixture-tests', package_version: '1', target_id: 'kernel' };
const plan: TestingPlanPreview = { ref, function_name: 'kernel', package_digest: digest, evaluator: { id: 'fixture-rules', version: '1', digest, qualification: 'DRAFT' },
  correctness: { definition: '独立整数参考：函数返回值应为 2', reference: { implementation: 'reference.c', accumulation: 'int32' }, tolerance: { rule: '整数精确相等', absolute: 0, relative: 0 } },
  build: { command: 'make -j4', cwd: '.', artifact: 'libkernel.so' }, code: { setup: true, correctness: true, performance: true, issues: [] },
  test_plan: { schema_version: 1, resources: { cpu_set: '0-7', numa_node: 0 }, sampling: { warmup_count: 2, sample_count: 9, order: 'paired' },
    seed: 1, inner_iterations: 100, timing_scope: 'kernel', candidate_api: 'kernel', baseline_api: 'kernel',
    execution_matrix: { thread_counts: [1, 4], profiles: [{ id: 'compact', name: '同节点紧凑', cpu_set: '0-7', numa_node: 0, cpu_allocation: 'shared', omp_proc_bind: 'close' }] } },
  cases: [{ case_id: 'check', parameters: { n: 8 }, threads: 1 }], workloads: [{ workload_id: 'p1', parameters: { n: 256 }, threads: 4, critical: true, weight: 1 }],
  note: 'Browser fixture only; no hardware or model is used.' };
function asset(id: string, name: string): TestingAsset {
  return { schema_version: 1, asset_id: id, name, version: '1', state: 'READY', files: [{ path: 'libkernel.so', sha256: digest, bytes: 40 }], entries: ['libkernel.so'], entry_path: 'libkernel.so', sha256: digest, created_at: '2026-11-04T00:00:00Z', finalized_at: '2026-11-04T00:00:00Z' };
}
function record(input: CreateTestingTask): TestingTaskRecord {
  return { schema_version: 1, task_id: 'testing:11111111-1111-4111-8111-111111111111', name: input.name ?? 'kernel 测试', request_id: 'browser-fixture', request_digest: digest, input, plan,
    machine: { machine_id: 'machine-fixture', name: '隔离 CPU', revision: 1, connection_key: digest, runner_id: 'fixture-runner', hardware: null },
    subjects: { candidate: { kind: input.candidate.kind, name: '待测库', version: '2', artifact_path: '/fixture/b/libkernel.so', artifact_sha256: digest, library_paths: [], dependencies: [] }, baseline: input.baseline ? { kind: input.baseline.kind, name: '对照库', version: '1', artifact_path: '/fixture/a/libkernel.so', artifact_sha256: digest, library_paths: [], dependencies: [] } : null },
    workspace: { run_root: '/fixture/testing', logs_root: '/fixture/testing/logs', assets_root: '/fixture/testing/assets', runtime_root: '/fixture/testing/runtime' },
    execution: { status: 'SUCCEEDED', phase: 'FINISHED', message: null, cancel_requested: false, submission_attempted: true, failure: null }, created_at: '2026-11-04T00:00:00Z', updated_at: '2026-11-04T00:00:01Z', formal_evidence: false };
}
function details(task: TestingTaskRecord): TestingTaskDetails {
  return { task, status: null, formal_evidence: false, commands: [], measurements: [], output: null,
    summary: { correctness: { status: task.input.mode === 'performance' ? 'NOT_REQUESTED' : 'FAILED', planned: 1, passed: 0, failed: task.input.mode === 'performance' ? 0 : 1, missing: [], invalid: [] },
      performance: { status: 'REGRESSED', planned: 18, measured: 18, speedup: 0.8, interval: { lower: 0.7, upper: 0.9 }, issues: [] },
      comparisons: [{ workload_id: 'p1', parameters: { n: 256 }, threads: 4, critical: true, baseline_samples: [1], candidate_samples: [1.25], baseline_median: 1, candidate_median: 1.25, speedup: 0.8, interval: { lower: 0.7, upper: 0.9 }, conclusion: 'REGRESSED' }], conclusion_scope: '离线浏览器夹具，只证明界面行为。' } };
}
async function login(page: Page) {
  await page.goto(fixture.url); await page.getByLabel('管理员访问凭据').fill(fixture.token); await page.getByRole('button', { name: '进入工作台' }).click(); await expect(page.getByRole('main')).toBeVisible();
}
async function mockTesting(page: Page) {
  const libraries = [asset('library-a', '对照库'), asset('library-b', '待测库')];
  let current: TestingTaskRecord | null = null;
  const submissions: CreateTestingTask[] = [];
  const requestIds: string[] = [];
  const uploads: Array<{ name: string; bytes: number }> = [];
  await page.route('**/v1/catalog', route => route.fulfill({ json: { packages: [{ package_id: ref.package_id, version: '1', library_name: 'Fixture', qualification: { state: 'DRAFT' }, functions: [{ function_id: 'kernel', api: 'kernel' }], targets: [{ target_id: 'kernel', function_id: 'kernel', evaluator: { evaluator_id: 'fixture-rules', evaluator_version: '1', qualification: 'DRAFT' } }] }] } }));
  await page.route('**/v1/machines', route => route.fulfill({ json: { machines: [{ machine_id: 'machine-fixture', name: '隔离 CPU', enabled: true, status: 'ONLINE', setup_complete: true }] } }));
  await page.route('**/v1/testing-plans/preview', route => route.fulfill({ json: { plan } }));
  await page.route('**/v1/testing-assets**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'PUT') { uploads.push({ name: url.searchParams.get('path')!, bytes: request.postDataBuffer()?.length ?? 0 }); await route.fulfill({ json: { file: { path: url.searchParams.get('path'), sha256: digest, bytes: 40 } } }); }
    else if (url.pathname.endsWith('/finalize')) { const library = { ...asset('library-upload', '新库'), entry_path: request.postDataJSON().entry_path }; libraries.push(library); await route.fulfill({ json: { asset: library } }); }
    else if (request.method() === 'POST') await route.fulfill({ json: { asset: { ...asset('library-upload', request.postDataJSON().name), state: 'UPLOADING' } } });
    else await route.fulfill({ json: { assets: libraries } });
  });
  await page.route('**/v1/testing-tasks**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/cancel')) { current!.execution.cancel_requested = true; await route.fulfill({ json: details(current!) }); }
    else if (request.method() === 'POST') { submissions.push(request.postDataJSON()); requestIds.push(request.headers()['idempotency-key']); current = record(request.postDataJSON()); await route.fulfill({ status: 202, json: { task: current } }); }
    else if (url.pathname === '/v1/testing-tasks') await route.fulfill({ json: { tasks: current ? [current] : [] } });
    else await route.fulfill({ json: details(current!) });
  });
  return { libraries, submissions, requestIds, uploads, current: () => current };
}

test('historical testing results show unchecked library identity without claiming an improvement', async ({ page }) => {
  const task = record({ machine_id: 'machine-fixture', plan: ref, mode: 'both',
    candidate: { kind: 'binary', asset_id: 'library-b' }, baseline: { kind: 'binary', asset_id: 'library-a' } });
  const result = details(task);
  result.summary.correctness = { ...result.summary.correctness, status: 'UNVERIFIED', passed: 1, failed: 0 };
  result.summary.performance = { ...result.summary.performance, status: 'UNVERIFIED', speedup: null, interval: null };
  result.summary.comparisons[0] = { ...result.summary.comparisons[0], conclusion: 'UNVERIFIED', baseline_median: null, candidate_median: null, speedup: null, interval: null };
  result.summary.provenance_issues = ['部分历史测量缺少有效的 Runner 库路径核对，原始记录已保留；请升级 Runner 并创建新测试。'];
  await page.route('**/v1/testing-tasks/**', route => route.fulfill({ json: result }));
  await login(page);
  await page.goto(fixture.url + '/#/testing/' + encodeURIComponent(task.task_id));
  await expect(page.getByLabel('测试结果')).toContainText('身份待核对');
  await expect(page.getByLabel('测试结果')).toContainText('条原始样本');
  await expect(page.getByLabel('测试结果')).not.toContainText('有改善');
  await expect(page.getByRole('status').filter({ hasText: '库身份待核对' })).toContainText('原始记录已保留');
  await page.reload();
  await expect(page.getByLabel('测试结果')).toContainText('身份待核对');
  fs.mkdirSync(path.join(repositoryRoot, 'build/ux-review'), { recursive: true });
  await page.screenshot({ path: path.join(repositoryRoot, 'build/ux-review/testing-unverified.png'), fullPage: true });
});

test('standalone library comparison preserves conditions and separates execution from correctness and performance', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true }); });
  const data = await mockTesting(page); await login(page);
  await page.getByRole('navigation').getByRole('button', { name: '测试任务', exact: true }).click();
  await page.getByRole('button', { name: '创建测试任务' }).click();
  let composer = page.getByRole('dialog', { name: '创建测试任务' });
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await composer.getByRole('group', { name: '待测对象 B', exact: true }).getByLabel('测试库包').selectOption('library-b');
  await composer.getByRole('group', { name: '比较对象 A', exact: true }).getByLabel('测试库包').selectOption('library-a');
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await expect(composer.getByRole('region', { name: '本次测试条件' })).toContainText('1 / 4 线程');
  await expect(composer).toContainText('CPU 0-7'); await expect(composer).toContainText('每端 9 个样本');
  await expect(composer.getByRole('region', { name: '本次测试条件' })).toContainText('整数精确相等');
  await page.setViewportSize({ width: 1280, height: 720 });
  const startButton = await composer.getByRole('button', { name: '开始测试' }).boundingBox();
  expect(startButton).not.toBeNull(); expect(startButton!.y + startButton!.height).toBeLessThanOrEqual(720);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await composer.locator('summary').filter({ hasText: '任务名称' }).click(); await composer.getByLabel('测试任务名称').fill('两个库的独立比较');
  await composer.locator('summary').filter({ hasText: '任务名称' }).click(); await expect(composer.locator('summary').filter({ hasText: '任务名称' })).toContainText('已调整');
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: '创建测试任务' }).click();
  composer = page.getByRole('dialog', { name: '创建测试任务' }); await expect(composer.getByLabel('执行机器')).toHaveValue('machine-fixture');
  await expect(composer.getByRole('group', { name: '待测对象 B' }).getByLabel('测试库包')).toHaveValue('library-b');
  await composer.getByRole('button', { name: '开始测试' }).click();
  await expect(page.getByRole('heading', { name: '两个库的独立比较' })).toBeVisible();
  const outcome = page.getByRole('definition').filter({ hasText: '执行' }).first();
  await expect(page.getByLabel('测试结果')).toContainText('执行完成'); await expect(page.getByLabel('测试结果')).toContainText('失败'); await expect(page.getByLabel('测试结果')).toContainText('有退化');
  await expect(page.getByRole('button', { name: /批准|交付/ })).toHaveCount(0);
  await page.reload(); await expect(page.getByRole('heading', { name: '两个库的独立比较' })).toBeVisible();
  for (const width of [1440, 1280, 390]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(repositoryRoot, 'build/ux-review/testing-result.png'), fullPage: true });
  expect(data.submissions[0].candidate).toEqual({ kind: 'binary', asset_id: 'library-b' }); expect(data.submissions[0].baseline).toEqual({ kind: 'binary', asset_id: 'library-a' });
  expect(data.submissions[0]).toMatchObject({ expected_evaluator_digest: digest, expected_package_digest: digest });
  expect(data.requestIds[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(fixture.modelRequests.inference).toBe(0); expect(fixture.service.list()).toHaveLength(0);
});

test('missing browser entropy leaves the independent testing form usable and does not submit', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
    Object.defineProperty(window.crypto, 'getRandomValues', { value: undefined, configurable: true });
  });
  const data = await mockTesting(page); await login(page); await page.goto(fixture.url + '/#/testing/new');
  const composer = page.getByRole('dialog', { name: '创建测试任务' });
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await composer.getByRole('group', { name: '待测对象 B', exact: true }).getByLabel('测试库包').selectOption('library-b');
  await composer.getByRole('group', { name: '比较对象 A', exact: true }).getByLabel('测试库包').selectOption('library-a');
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await composer.getByRole('button', { name: '开始测试' }).click();
  await expect(composer.getByRole('alert')).toContainText('无法提供安全随机数');
  await expect(composer.getByLabel('执行机器')).toHaveValue('machine-fixture');
  expect(data.submissions).toHaveLength(0);
});

test('normal source selection fills both branches and pins the reviewed build settings', async ({ page }) => {
  const project = fixture.projects.add({ name: '双源码示例', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  const data = await mockTesting(page); await login(page); await page.goto(fixture.url + '/#/testing/new');
  const composer = page.getByRole('dialog', { name: '创建测试任务' });
  const candidate = composer.getByRole('group', { name: '待测对象 B', exact: true });
  const baseline = composer.getByRole('group', { name: '比较对象 A', exact: true });
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await candidate.getByRole('button', { name: '源码分支', exact: true }).click();
  await candidate.getByLabel('源码项目').selectOption(project.project_id);
  await baseline.getByRole('button', { name: '源码分支', exact: true }).click();
  await baseline.getByLabel('源码项目').selectOption(project.project_id);
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await expect(candidate.getByLabel('测试分支', { exact: true })).toHaveValue('main');
  await expect(baseline.getByLabel('测试分支', { exact: true })).toHaveValue('main');
  await composer.getByRole('button', { name: '开始测试' }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].candidate).toMatchObject({ kind: 'source', project_id: project.project_id, branch: 'main', build: { cwd: '.' } });
  expect(data.submissions[0].baseline).toMatchObject({ kind: 'source', project_id: project.project_id, branch: 'main', build: { cwd: '.' } });
  expect(fixture.modelRequests.inference).toBe(0);
});

test('correctness-only can explicitly provide a comparison library without requesting performance', async ({ page }) => {
  const data = await mockTesting(page); await login(page); await page.goto(fixture.url + '/#/testing/new');
  const composer = page.getByRole('dialog', { name: '创建测试任务' });
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await composer.getByLabel('测试内容').selectOption('correctness');
  await expect(composer.getByRole('group', { name: '比较对象 A' })).toHaveCount(0);
  await composer.getByLabel('向正确性脚本提供比较库').check();
  await composer.getByRole('group', { name: '待测对象', exact: true }).getByLabel('测试库包').selectOption('library-b');
  await composer.getByRole('group', { name: '比较对象 A', exact: true }).getByLabel('测试库包').selectOption('library-a');
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await composer.getByRole('button', { name: '开始测试' }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0]).toMatchObject({ mode: 'correctness', baseline: { kind: 'binary', asset_id: 'library-a' } });
  expect(fixture.modelRequests.inference).toBe(0);
});

test('source and binary comparison reuses build settings and a fixed optimization commit', async ({ page }) => {
  const project = fixture.projects.add({ name: '源码示例', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  const data = await mockTesting(page); await login(page);
  const commit = fixture.git('rev-parse', 'HEAD');
  await page.goto(fixture.url + '/#/testing/new?' + new URLSearchParams({ project: project.project_id, branch: 'main', commit, function: 'kernel' }));
  const composer = page.getByRole('dialog', { name: '创建测试任务' });
  await expect(composer).toContainText('固定优化候选');
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await composer.getByRole('group', { name: '比较对象 A' }).getByLabel('测试库包').selectOption('library-a');
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await composer.getByRole('group', { name: '待测对象 B' }).locator('summary').filter({ hasText: '构建设置' }).click();
  await composer.getByLabel('自定义本次构建').check(); await composer.getByLabel('构建命令').fill('make -j2');
  await composer.getByRole('group', { name: '待测对象 B' }).locator('summary').filter({ hasText: '构建设置' }).click();
  await expect(composer.getByRole('group', { name: '待测对象 B' }).locator('summary').filter({ hasText: '构建设置' })).toContainText('已调整');
  await page.screenshot({ path: path.join(repositoryRoot, 'build/ux-review/testing-composer.png'), fullPage: true });
  await composer.getByRole('button', { name: '开始测试' }).click();
  await expect.poll(() => data.submissions.length).toBe(1);
  expect(data.submissions[0].candidate).toMatchObject({ kind: 'source', project_id: project.project_id, branch: 'main', commit, build: { command: 'make -j2' } });
  expect(fixture.git('branch', '--show-current')).toBe('main'); expect(fixture.modelRequests.inference).toBe(0);
});

test('library upload keeps dependencies and explicitly selects the dynamic-library entry', async ({ page }) => {
  const data = await mockTesting(page); await login(page); await page.goto(fixture.url + '/#/testing/new');
  await page.getByRole('group', { name: '待测对象 B' }).getByRole('button', { name: '上传新的库包' }).click();
  const upload = page.getByRole('dialog', { name: '上传测试库包' });
  await upload.getByLabel('选择库包文件', { exact: true }).setInputFiles([{ name: 'libkernel.so', mimeType: 'application/octet-stream', buffer: Buffer.from('fixture ELF') }, { name: 'kernel.h', mimeType: 'text/plain', buffer: Buffer.from('int kernel(void);') }]);
  await upload.getByLabel('库包名称').fill('新库'); await expect(upload.getByLabel('动态库入口')).toHaveValue('libkernel.so');
  await upload.getByRole('button', { name: '上传并固定版本' }).click();
  await expect(page.getByRole('dialog', { name: '上传测试库包' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: '待测对象 B' }).getByLabel('测试库包')).toHaveValue('library-upload');
  expect(data.uploads.map(item => item.name)).toEqual(['libkernel.so', 'kernel.h']); expect(fixture.modelRequests.inference).toBe(0);
});

test('without a test plan users can explicitly produce unverified source and preflight sends the selected mode', async ({ page }) => {
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')); config.validation.testpack = ''; fs.writeFileSync(fixture.configPath, JSON.stringify(config));
  fixture.projects.add({ name: '先优化代码', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  const checks: unknown[] = [];
  await page.route('**/v1/projects/*/check', route => { checks.push(route.request().postDataJSON()); return route.fulfill({ json: { message: '源码与模型输入可用' } }); });
  await login(page); await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const task = page.getByRole('dialog', { name: '创建优化任务' });
  await expect(task.getByRole('radio', { name: /仅生成优化代码/ })).toBeChecked();
  await expect(task).toContainText('正确性未验证 · 性能未测量'); await expect(task.getByRole('button', { name: '开始优化' })).toBeEnabled();
  await task.getByRole('radio', { name: /优化并自动验证/ }).check(); await expect(task.getByRole('button', { name: '开始优化' })).toBeDisabled();
  await task.getByRole('radio', { name: /仅生成优化代码/ }).check();
  await task.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await task.getByRole('button', { name: '运行前检查', exact: true }).click(); await expect(task.getByText('源码与模型输入可用')).not.toBeVisible();
  expect(checks).toEqual([expect.objectContaining({ verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] } })]);
  expect(fixture.modelRequests.inference).toBe(0); expect(fixture.service.list()).toHaveLength(0);
});

test('test-code preparation returns to the testing draft instead of the optimization flow', async ({ page }) => {
  const project = fixture.projects.add({ name: '测试准备返回', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  await mockTesting(page);
  let addedVersion = false;
  const catalogEntry = (version: string) => ({ package_id: ref.package_id, version, library_name: 'Fixture', qualification: { state: 'DRAFT' },
    functions: [{ function_id: 'kernel', api: 'kernel' }], targets: [{ target_id: 'kernel', function_id: 'kernel', evaluator: { evaluator_id: 'fixture-rules', evaluator_version: version, qualification: 'DRAFT' } }] });
  await page.route('**/v1/catalog', route => route.fulfill({ json: { packages: [catalogEntry('1'), ...(addedVersion ? [catalogEntry('2')] : [])] } }));
  await page.route('**/v1/testing-plans/preview', route => route.fulfill({ json: { plan: { ...plan, code: { setup: true, correctness: false, performance: true, issues: ['缺少正确性测试代码'] } } } }));
  await login(page); await page.goto(fixture.url + '/#/testing/new');
  let composer = page.getByRole('dialog', { name: '创建测试任务' });
  await composer.getByLabel('执行机器').selectOption('machine-fixture');
  await composer.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(ref));
  await composer.getByRole('button', { name: '用 AI 起草或上传测试脚本' }).click();
  await expect(page.getByRole('button', { name: '返回测试配置', exact: true })).toBeVisible();
  addedVersion = true;
  await page.reload();
  await page.getByRole('button', { name: '返回测试配置', exact: true }).click();
  composer = page.getByRole('dialog', { name: '创建测试任务' });
  await expect(composer.getByLabel('执行机器')).toHaveValue('machine-fixture');
  await expect(composer.getByLabel('测试方案', { exact: true })).toHaveValue(JSON.stringify(ref));
  await expect(composer.getByLabel('测试方案', { exact: true }).locator('option')).toHaveCount(3);
  await expect(composer.getByLabel('源码项目')).toHaveValue(project.project_id);
  expect(fixture.modelRequests.inference).toBe(0); expect(fixture.service.list()).toHaveLength(0);
});

test('unavailable creation choices explain the failure and retry without reporting an empty machine registry', async ({ page }) => {
  await mockTesting(page); await login(page);
  let available = false;
  await page.route('**/v1/machines', route => route.fulfill(available ? { json: { machines: [{ machine_id: 'machine-fixture', name: '隔离 CPU', enabled: true, status: 'ONLINE' }] } }
    : { status: 503, json: { error: { code: 'TEMPORARY_UNAVAILABLE', message: '机器目录暂时不可用' } } }));
  await page.goto(fixture.url + '/#/testing/new');
  const composer = page.getByRole('dialog', { name: '创建测试任务' });
  await expect(composer.getByRole('alert')).toContainText('机器目录暂时不可用');
  await expect(composer.getByText('还没有执行机器。', { exact: false })).toHaveCount(0);
  available = true;
  await composer.getByRole('button', { name: '重新读取创建条件' }).click();
  await expect(composer.getByLabel('执行机器').locator('option')).toHaveCount(2);
  expect(fixture.modelRequests.inference).toBe(0); expect(fixture.testing.list()).toHaveLength(0);
});

test('source-only optimization runs through the real control API and opens testing for the exact frozen candidate', async ({ page }) => {
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  config.validation = { testpack: '' }; config.build.executable = '';
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));
  const project = fixture.projects.add({ name: '未验证候选联调', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  await login(page); await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  const composer = page.getByRole('dialog', { name: '创建优化任务' });
  await composer.getByLabel('优化函数').fill('kernel');
  await expect(composer.getByRole('radio', { name: /仅生成优化代码/ })).toBeChecked();
  await composer.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await composer.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(page.getByLabel('源码优化结果')).toContainText('候选已冻结');
  await expect(page.getByLabel('最近进展')).not.toContainText('"git_status"');
  const workflow = fixture.service.list()[0];
  expect(workflow.verification_mode).toBe('source_only'); expect(workflow.experiment_id).toBeUndefined();
  await page.getByRole('button', { name: '查看源码差异', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '候选源码差异' })).toContainText('+int kernel(void) { return 2; }');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /批准|交付/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(repositoryRoot, 'build/ux-review/after-source-candidate.png'), fullPage: true });
  await page.getByRole('button', { name: '测试这个候选', exact: true }).click();
  const testing = page.getByRole('dialog', { name: '创建测试任务' });
  await expect(testing).toContainText('固定优化候选');
  await expect(testing).toContainText(workflow.candidate_commit!);
  expect(new URLSearchParams(page.url().split('?')[1]).get('commit')).toBe(workflow.candidate_commit);
  expect(new URLSearchParams(page.url().split('?')[1]).get('project')).toBe(project.project_id);
  expect(fixture.git('show', 'main:kernel.c')).toContain('return 1 + 1');
  expect(fixture.testing.list()).toHaveLength(0);
});

test('an older source session can be resumed only after its continuation scope is explicitly selected', async ({ page }) => {
  const config = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  config.validation = { testpack: '' }; config.build.executable = '';
  fs.writeFileSync(fixture.configPath, JSON.stringify(config));
  const project = fixture.projects.add({ name: '历史源码会话', repository_root: fixture.repo, config_path: fixture.configPath, source_branch: 'main' });
  const client = new ApiClient(fixture.url, { token: fixture.token });
  const created = await client.submitOptimizationWorkflow({ project_id: project.project_id, function_name: 'kernel', source_branch: 'main',
    verification_mode: 'source_only', candidate_scope: { include: ['kernel.c'], exclude: [] } }) as { workflow_id: string };
  await expect.poll(() => fixture.service.get(created.workflow_id)?.status, { timeout: 30000 }).toBe('CANDIDATE_READY');
  const old = fixture.service.get(created.workflow_id)!; const task = fixture.store.getOptimizationTask(old.optimization_task_id!)!;
  delete old.source_scope_authorization; delete task.target.scope.candidate_scope;
  old.execution_contract_digest = sourceOptimizationContractDigest(loadSourceOptimizationPreflight({ verification_mode: 'source_only',
    function_name: old.function_name, entry_file: old.entry_file, config_path: old.config_path, repository_root: old.repository_root }, { historicalScope: true }));
  fixture.store.saveOptimizationTask(task); fixture.store.saveOptimizationWorkflowJson(old.workflow_id, JSON.stringify(old));
  await login(page); await page.getByRole('button', { name: '优化任务', exact: true }).click();
  await page.getByRole('row').filter({ hasText: 'kernel' }).click();
  await expect(page.getByText('历史任务未记录修改授权')).toBeVisible();
  await page.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  await page.getByRole('button', { name: '继续优化', exact: true }).click();
  await expect.poll(() => fixture.service.get(old.workflow_id)?.source_scope_authorization?.kind, { timeout: 10000 }).toBe('CONTINUATION');
  expect(fixture.service.get(old.workflow_id)!.source_scope_authorization?.previous_candidate_id).toBe(old.candidate_id);
});
