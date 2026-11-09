import { test, expect, type Page } from '@playwright/test';
import { ApiClient, ApiClientError } from '../../src/client/api-client.js';
import { startWebFixture } from '../../tests/web-fixture.js';

let fixture: Awaited<ReturnType<typeof startWebFixture>>;
test.beforeEach(async () => { fixture = await startWebFixture(); });
test.afterEach(async () => { await fixture.close(); });

async function openComposer(page: Page) {
  await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
  return page.getByRole('dialog', { name: '创建优化任务' });
}

async function prepare(page: Page) {
  const f = fixture;
  f.projects.add({ name: 'Request recovery', repository_root: f.repo, config_path: f.configPath });
  await page.goto(f.url);
  await page.getByLabel('管理员访问凭据').fill(f.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  const dialog = await openComposer(page);
  await dialog.getByRole('radio', { name: /仅生成优化代码/ }).check();
  await dialog.getByLabel('优化函数').fill('kernel');
  await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
  return dialog;
}

test('a lost response and refresh recover the created task without a second POST', async ({ page }) => {
  const f = fixture;
  let posts = 0, originalId = '';
  await page.route('**/v1/control-identities/*/*/workflows', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    originalId = (await response.json()).workflow_id;
    await route.abort('failed');
  });
  let dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');
  expect(f.service.list()).toHaveLength(1);
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('corepilot-optimization-request:')));
  expect(stored).toHaveLength(1);
  expect(JSON.parse(stored[0][1])).toMatchObject({ version: 2, identity: { database_id: expect.any(String), data_root_id: expect.any(String) } });
  expect(JSON.stringify(stored)).not.toContain('kernel');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /更换目标函数，当前/ }).click();
  const picker = page.getByRole('dialog', { name: '更换目标函数' });
  await picker.getByLabel('搜索或输入函数名').fill('other_function');
  await picker.getByRole('button', { name: '使用输入的函数：other_function' }).click();
  await picker.getByRole('button', { name: '保存选择' }).click();
  dialog = await openComposer(page);
  await expect(dialog.getByLabel('优化函数')).toHaveValue('kernel');
  await page.reload();
  dialog = await openComposer(page);
  await expect(dialog.getByLabel('优化函数')).toHaveValue('kernel');
  await expect(dialog.getByLabel('允许修改的源码文件或目录')).toHaveValue('kernel.c');
  await expect(dialog.getByLabel('优化函数')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '查询原任务', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.url()).toContain(encodeURIComponent(originalId));
  await expect(page.getByText('已找到原任务，请查看当前状态。')).toBeVisible();
  await expect(page.getByText('优化任务已提交，关闭页面后后台继续执行。')).not.toBeVisible();
  expect(posts).toBe(1);
  expect(f.service.list()).toHaveLength(1);
  expect(f.modelRequests.inference).toBe(0);
});

test('not found remains unresolved until closing blocks a late POST', async ({ page }) => {
  const f = fixture;
  let posts = 0, key = '', body: Record<string, unknown> = {};
  await page.route('**/v1/control-identities/*/*/workflows', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    if (++posts > 1) return route.continue();
    key = route.request().headers()['idempotency-key'];
    body = route.request().postDataJSON();
    await route.abort('failed');
  });
  const dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');
  await dialog.getByRole('button', { name: '查询原任务', exact: true }).click();
  await expect(dialog.getByText('暂未查到任务，原请求仍可能到达。请再次查询，或关闭未创建的请求后再修改。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭未创建的请求', exact: true }).click();
  await expect(dialog.getByText('该请求已关闭且没有创建任务。现在可以修改后重新提交。')).toBeVisible();
  await expect(dialog.getByLabel('优化函数')).toBeEnabled();
  const api = new ApiClient(f.url, { token: f.token });
  await expect(api.submitOptimizationWorkflow(body, { requestId: key })).rejects.toMatchObject({ status: 409, code: 'WORKFLOW_REQUEST_CLOSED' } satisfies Partial<ApiClientError>);
  expect(f.service.list()).toHaveLength(0);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect.poll(() => f.service.list().length).toBe(1);
  expect(posts).toBe(2);
  expect(f.modelRequests.inference).toBe(0);
});

test('failed lookup and close keep the request unresolved across refresh', async ({ page }) => {
  await page.route('**/v1/control-identities/*/*/workflows', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  await page.route('**/v1/control-identities/*/*/workflow-requests/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'WORKFLOW_REQUEST_BUSY', message: '数据库忙' } }) }));
  let dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');
  await dialog.getByRole('button', { name: '查询原任务', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法确认原请求');
  await dialog.getByRole('button', { name: '关闭未创建的请求', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('暂时无法确认原请求');
  await page.reload();
  dialog = await openComposer(page);
  await expect(dialog.getByRole('region', { name: '待核对的任务请求' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  expect(fixture.service.list()).toHaveLength(0);
});

test('a second tab sees the unresolved key and cannot silently submit a new one', async ({ page, context }) => {
  await page.route('**/v1/control-identities/*/*/workflows', route => route.request().method() === 'POST' ? route.abort('failed') : route.continue());
  const dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');
  const secondPage = await context.newPage();
  try {
    await secondPage.goto(fixture.url);
    const second = await openComposer(secondPage);
    await expect(second.getByRole('region', { name: '待核对的任务请求' })).toBeVisible();
    await expect(second.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  } finally { await secondPage.close(); }
  expect(fixture.service.list()).toHaveLength(0);
});

test('refuses to send when request identity cannot be persisted', async ({ page }) => {
  let posts = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/workflows')) posts++; });
  const dialog = await prepare(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('corepilot-optimization-request:')) throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法保存任务请求标识');
  await expect(dialog.getByLabel('优化函数')).toHaveValue('kernel');
  expect(posts).toBe(0);
  expect(fixture.service.list()).toHaveLength(0);
});

test('a legacy pending key does not inherit the current Control identity', async ({ page }) => {
  const f = fixture;
  const project = f.projects.add({ name: 'Legacy pending', repository_root: f.repo, config_path: f.configPath });
  await page.goto(f.url);
  await page.getByLabel('管理员访问凭据').fill(f.token);
  await page.getByRole('button', { name: '进入工作台' }).click();
  await page.evaluate(id => localStorage.setItem(`corepilot-optimization-request:${id}:legacy-request`, '1'), project.project_id);
  let protectedCalls = 0;
  page.on('request', request => { if (request.url().includes('/v1/control-identities/')) protectedCalls++; });
  let dialog = await openComposer(page);
  await expect(dialog.getByText('此请求没有记录原控制端身份', { exact: false })).toBeVisible();
  await expect(dialog.getByText('legacy-request', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '复制请求标识' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '查询原任务', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '关闭未创建的请求', exact: true })).toHaveCount(0);
  await page.reload(); dialog = await openComposer(page);
  await expect(dialog.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  expect(protectedCalls).toBe(0);
  expect(await page.evaluate(id => localStorage.getItem(`corepilot-optimization-request:${id}:legacy-request`), project.project_id)).toBe('1');
  expect(f.service.list()).toHaveLength(0);
});

test('a changed Control identity cannot clear an unresolved request', async ({ page }) => {
  await page.route('**/v1/control-identities/*/*/workflows', route => route.abort('failed'));
  await page.route('**/v1/control-identities/*/*/workflow-requests/**', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'CONTROL_DATA_ROOT_MISMATCH', message: '当前控制端数据目录与原请求不同' } }) }));
  let dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');
  const saved = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('corepilot-optimization-request:')));
  await dialog.getByRole('button', { name: '查询原任务', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('数据目录与原请求不同');
  await dialog.getByRole('button', { name: '关闭未创建的请求', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('数据目录与原请求不同');
  await page.reload(); dialog = await openComposer(page);
  await expect(dialog.getByRole('button', { name: '开始优化', exact: true })).toBeDisabled();
  expect(await page.evaluate(key => localStorage.getItem(key), saved![0])).toBe(saved![1]);
  expect(fixture.service.list()).toHaveLength(0);
});

test('an old or unavailable control identity never falls back to the unguarded API', async ({ page }) => {
  let posts = 0;
  await page.route('**/v1/control-identity', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'old service' } }) }));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/workflows')) posts++; });
  const dialog = await prepare(page);
  await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法核对控制端身份');
  expect(posts).toBe(0);
  expect(fixture.service.list()).toHaveLength(0);
});
