import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { TestingService } from '../../src/application/testing-service.js';
import { createHttpServer } from '../../src/http/server.js';
import { ControlIdentityGuard } from '../../src/storage/control-identity.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from '../../tests/testing-fixture.js';
import { repositoryRoot, startWebFixture } from '../../tests/web-fixture.js';

async function setup(page: Page) {
  const testing = createTestingFixture(), second = new TestingService(testing.options);
  const a = await startWebFixture({ testingService: testing.service }), b = await startWebFixture({ testingService: second });
  const guardA = ControlIdentityGuard.initialize(a.store, testing.root, { initializeNewDataDir: true });
  const guardB = ControlIdentityGuard.initialize(b.store, testing.root, { initializeNewDataDir: true });
  const makeServer = (f: typeof a, service: TestingService, guard: ControlIdentityGuard) => createHttpServer(f.host, {
    host: '127.0.0.1', port: 0, workflowService: f.service, projectService: f.projects, testingService: service,
    controlIdentity: guard, accessToken: a.token, webRoot: path.join(repositoryRoot, 'web', 'dist'),
  });
  const serverA = makeServer(a, testing.service, guardA), serverB = makeServer(b, second, guardB);
  await Promise.all([once(serverA, 'listening'), once(serverB, 'listening')]);
  const addrA = serverA.address(), addrB = serverB.address();
  if (!addrA || typeof addrA === 'string' || !addrB || typeof addrB === 'string') throw new Error('fixture server did not start');
  let destination = 0;
  const ports = [addrA.port, addrB.port];
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: ports[destination], method: request.method, path: request.url, headers: request.headers }, reply => {
      response.writeHead(reply.statusCode ?? 500, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const addr = proxy.address(); if (!addr || typeof addr === 'string') throw new Error('fixture proxy did not start');
  const url = `http://127.0.0.1:${addr.port}`;
  const candidate = await testing.binary('待测库'), baseline = await testing.binary('比较库');
  if (candidate.kind !== 'binary' || baseline.kind !== 'binary') throw new Error('fixture binaries required');
  const candidateId = candidate.asset_id, baselineId = baseline.asset_id;
  await page.route('**/v1/catalog', route => route.fulfill({ json: { packages: [{ package_id: testingPlanRef.package_id,
    version: testingPlanRef.package_version, library_name: '测试库', qualification: { state: 'DRAFT' },
    functions: [{ function_id: 'test-function', api: 'cblas_saxpy' }], targets: [{ target_id: testingPlanRef.target_id,
      function_id: 'test-function', evaluator: { evaluator_id: 'test-evaluator', evaluator_version: '1.0.0', qualification: 'DRAFT' } }] }] } }));
  await page.route('**/v1/machines', route => route.fulfill({ json: { machines: [{ ...testing.machine.identity, enabled: true, status: 'ONLINE', setup_complete: true }] } }));
  async function login() {
    await page.goto(url); await page.getByLabel('管理员访问凭据').fill(a.token);
    await page.getByRole('button', { name: '进入工作台' }).click();
  }
  async function fill() {
    await page.goto(url + '/#/testing/new');
    const dialog = page.getByRole('dialog', { name: '创建测试任务' });
    await dialog.getByLabel('执行机器').selectOption(testing.machine.identity.machine_id);
    await dialog.getByRole('group', { name: '待测对象 B' }).getByLabel('测试库包').selectOption(candidateId);
    await dialog.getByRole('group', { name: '比较对象 A' }).getByLabel('测试库包').selectOption(baselineId);
    await dialog.getByLabel('测试方案', { exact: true }).selectOption(JSON.stringify(testingPlanRef));
    return dialog;
  }
  async function close() {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await Promise.all([new Promise<void>(resolve => serverA.close(() => resolve())), new Promise<void>(resolve => serverB.close(() => resolve()))]);
    await a.close(); await b.close(); testing.close();
  }
  return { testing, a, guardA, guardB, url, login, fill, close, switchTo: (value: number) => { destination = value; } };
}

async function stored(page: Page, key: string): Promise<unknown> {
  return page.evaluate(key => new Promise((resolve, reject) => {
    const request = indexedDB.open('corepilot-testing-request-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, read = db.transaction('pending').objectStore('pending').get(key);
      read.onsuccess = () => { db.close(); resolve(read.result); }; read.onerror = () => reject(read.error); };
  }), key);
}

test('a recovered task remains bound across proxy switches, reloads and unreadable browser storage', async ({ page }) => {
  const f = await setup(page), paths: string[] = [];
  try {
    await page.route('**/testing-tasks', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      expect((await route.fetch()).status()).toBe(202); await route.abort('failed');
    });
    page.on('request', request => { if (request.method() === 'GET' && /\/testing-tasks\/[^/]+$/.test(new URL(request.url()).pathname)) paths.push(new URL(request.url()).pathname); });
    await f.login(); const dialog = await f.fill();
    await dialog.getByRole('button', { name: '开始测试' }).click();
    await expect(dialog).toContainText('上次测试创建请求尚未确认');
    const pending = await stored(page, 'active');
    expect(pending).toMatchObject({ version: 2, identity: f.guardA.current() });
    expect(f.testing.service.list()).toHaveLength(1);
    const taskId = f.testing.service.list()[0].task_id;
    await waitTestingPreparation(f.testing.service, taskId);
    f.switchTo(1);
    await dialog.getByRole('button', { name: '核对原请求' }).click();
    await expect(dialog.getByRole('alert')).toContainText('数据库与原请求不同');
    await dialog.getByRole('button', { name: '关闭未创建的请求' }).click();
    await expect(dialog.getByRole('alert')).toContainText('数据库与原请求不同');
    expect(await stored(page, 'active')).toEqual(pending);
    expect(f.testing.service.list()).toHaveLength(1);
    f.switchTo(0); await dialog.getByRole('button', { name: '核对原请求' }).click();
    await expect(page.getByLabel('测试结果')).toBeVisible();
    expect(await stored(page, 'active')).toBeUndefined();
    const binding = await stored(page, 'task:' + taskId);
    expect(binding).toMatchObject({ version: 1, identity: f.guardA.current() });
    f.switchTo(1);
    await expect(page.getByText('当前控制端数据库与原请求不同', { exact: false })).toBeVisible();
    await expect(page.getByLabel('测试结果')).toHaveCount(0);
    await page.reload(); await expect(page.getByText('当前控制端数据库与原请求不同', { exact: false })).toBeVisible();
    const reads = f.testing.getCalls;
    await page.goto(f.url + '/#/testing');
    await expect(page.getByText('部分测试属于其他控制端或身份暂不可核对', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: '创建测试任务' })).toBeEnabled();
    await page.getByRole('row').filter({ hasText: 'cblas_saxpy' }).getByRole('button', { name: '查看任务' }).click();
    await expect(page.getByText('当前控制端数据库与原请求不同', { exact: false })).toBeVisible();
    expect(f.testing.getCalls).toBe(reads);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every(value => value.startsWith('/v1/control-identities/'))).toBe(true);
    // Even if this browser loses its task binding, the shared record still rejects the other DB.
    await page.evaluate(taskId => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('corepilot-testing-request-v1', 1);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').delete('task:' + taskId);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; open.onerror = () => reject(open.error);
    }), taskId);
    await page.reload(); await expect(page.getByText('测试请求属于另一控制端', { exact: false })).toBeVisible();
    await expect(page.getByLabel('测试结果')).toHaveCount(0);
    await page.evaluate(({ taskId, binding }) => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('corepilot-testing-request-v1', 1);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(binding, 'task:' + taskId);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; open.onerror = () => reject(open.error);
    }), { taskId, binding });
    f.switchTo(0); await page.reload(); await expect(page.getByLabel('测试结果')).toBeVisible();
    const before = paths.length;
    await page.evaluate(() => { Object.defineProperty(indexedDB, 'open', { value: () => { throw new Error('storage unavailable'); }, configurable: true }); });
    await expect(page.getByText('无法访问浏览器请求存储', { exact: false })).toBeVisible();
    await expect(page.getByLabel('测试结果')).toHaveCount(0);
    expect(paths.length).toBe(before);
    await page.reload(); await expect(page.getByLabel('测试结果')).toBeVisible();
    await page.evaluate(taskId => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('corepilot-testing-request-v1', 1);
      open.onsuccess = () => { const db = open.result, tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put({ version: 1, identity: 'damaged' }, 'task:' + taskId);
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); }; open.onerror = () => reject(open.error);
    }), taskId);
    const beforeCorrupt = paths.length;
    await page.reload(); await expect(page.getByText('测试任务绑定的控制端身份无法读取', { exact: false })).toBeVisible();
    await expect(page.getByLabel('测试结果')).toHaveCount(0); expect(paths.length).toBe(beforeCorrupt);
    expect(f.testing.plans).toHaveLength(1);
  } finally { await f.close(); }
});

test('a legacy pending key remains unresolved instead of inheriting the current Control identity', async ({ page }) => {
  const f = await setup(page), key = '12345678-1234-4234-8234-123456789abc';
  try {
    await f.login();
    await page.evaluate(key => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('corepilot-testing-request-v1', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('pending');
      open.onsuccess = () => { const db = open.result, tx = db.transaction('pending', 'readwrite'); tx.objectStore('pending').put(key, 'active');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); };
      open.onerror = () => reject(open.error);
    }), key);
    await page.goto(f.url + '/#/testing/new');
    const dialog = page.getByRole('dialog', { name: '创建测试任务' });
    await expect(dialog).toContainText('此请求没有记录原控制端身份');
    await expect(dialog.getByRole('button', { name: '核对原请求' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '关闭未创建的请求' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '开始测试' })).toBeDisabled();
    await page.reload(); await expect(dialog).toContainText('此请求没有记录原控制端身份');
    expect(await stored(page, 'active')).toBe(key); expect(f.testing.service.list()).toHaveLength(0);
  } finally { await f.close(); }
});

test('failure to persist a task binding retains the created request for later reconciliation', async ({ page }) => {
  const f = await setup(page);
  try {
    await page.route('**/testing-tasks', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch(); expect(response.status()).toBe(202);
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function(value, key) {
          if (typeof key === 'string' && key.startsWith('task:')) throw new DOMException('fixture task binding failed', 'QuotaExceededError');
          return original.call(this, value, key);
        };
      });
      await route.fulfill({ response });
    });
    await f.login(); let dialog = await f.fill();
    await dialog.getByRole('button', { name: '开始测试' }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法保存测试任务与原控制端的关联');
    const pending = await stored(page, 'active'); expect(pending).toMatchObject({ version: 2, identity: f.guardA.current() });
    expect(f.testing.service.list()).toHaveLength(1);
    await waitTestingPreparation(f.testing.service, f.testing.service.list()[0].task_id);
    await page.reload(); dialog = page.getByRole('dialog', { name: '创建测试任务' });
    await expect(dialog).toContainText('上次测试创建请求尚未确认');
    await dialog.getByRole('button', { name: '核对原请求' }).click();
    await expect(page.getByLabel('测试结果')).toBeVisible();
    expect(await stored(page, 'active')).toBeUndefined(); expect(f.testing.service.list()).toHaveLength(1);
  } finally { await f.close(); }
});

test('a mismatched creation receipt retains the original pending request', async ({ page }) => {
  const f = await setup(page);
  try {
    await page.route('**/testing-tasks', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch(); expect(response.status()).toBe(202);
      const payload = await response.json(); payload.task.request_control_identity = f.guardB.current();
      await route.fulfill({ response, json: payload });
    });
    await f.login(); const dialog = await f.fill();
    await dialog.getByRole('button', { name: '开始测试' }).click();
    await expect(dialog.getByRole('alert')).toContainText('测试回执与原请求或控制端身份不一致');
    expect(await stored(page, 'active')).toMatchObject({ version: 2, identity: f.guardA.current() });
    expect(f.testing.service.list()).toHaveLength(1);
    await waitTestingPreparation(f.testing.service, f.testing.service.list()[0].task_id);
    await dialog.getByRole('button', { name: '核对原请求' }).click();
    await expect(page.getByLabel('测试结果')).toBeVisible();
    expect(await stored(page, 'active')).toBeUndefined();
  } finally { await f.close(); }
});

test('an old Control without identity support never receives an unguarded testing submission', async ({ page }) => {
  const f = await setup(page); let posts = 0;
  try {
    await page.route('**/v1/control-identity', route => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'old service' } } }));
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/testing-tasks')) posts++; });
    await f.login(); const dialog = await f.fill();
    await dialog.getByRole('button', { name: '开始测试' }).click();
    await expect(dialog.getByRole('alert')).toContainText('无法核对控制端身份');
    expect(posts).toBe(0); expect(f.testing.service.list()).toHaveLength(0); expect(await stored(page, 'active')).toBeUndefined();
  } finally { await f.close(); }
});
