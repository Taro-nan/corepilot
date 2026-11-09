import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect } from '@playwright/test';
import { startWebFixture } from '../../tests/web-fixture.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from '../../tests/testing-fixture.js';

test('the workbench keeps history visible and warns when the connected control loses its lease', async ({ page }) => {
  const f = await startWebFixture();
  const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    f.projects.add({ name: 'Lease fixture', repository_root: f.repo, config_path: f.configPath });
    await page.goto(f.url);
    await page.getByLabel('管理员访问凭据').fill(f.token);
    await page.getByRole('button', { name: '进入工作台' }).click();
    await expect(page.getByRole('heading', { name: 'Lease fixture' })).toBeVisible();
    db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1').run('2000-01-01T00:00:00.000Z');
    await expect(page.getByRole('alert').filter({ hasText: '后台已失去执行权' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lease fixture' })).toBeVisible();
    await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建优化任务' });
    await dialog.getByRole('radio', { name: /仅生成优化代码/ }).check();
    await dialog.getByLabel('优化函数').fill('kernel');
    await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
    await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('失去执行权');
    await expect(dialog.getByRole('region', { name: '待核对的任务请求' })).toBeVisible();
    expect(f.service.list()).toHaveLength(0);
    expect(f.modelRequests.inference).toBe(0);
  } finally { db.close(); await f.close(); }
});

test('a testing task is shown as a saved snapshot after lease loss and cannot be cancelled there', async ({ page }) => {
  const testing = createTestingFixture();
  const f = await startWebFixture({ testingService: testing.service });
  const db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
  try {
    const candidate = await testing.binary('待测库'), baseline = await testing.binary('比较库');
    const plan = testing.service.plan(testingPlanRef);
    const task = await testing.service.start({ machine_id: testing.machine.identity.machine_id, plan: testingPlanRef,
      mode: 'performance', candidate, baseline, expected_evaluator_digest: plan.evaluator.digest, expected_package_digest: plan.package_digest });
    await waitTestingPreparation(testing.service, task.task_id);
    const reads = testing.getCalls;
    db.prepare('UPDATE host_lease SET expires_at = ? WHERE lease_key = 1').run('2000-01-01T00:00:00.000Z');
    await page.goto(f.url);
    await page.getByLabel('管理员访问凭据').fill(f.token);
    await page.getByRole('button', { name: '进入工作台' }).click();
    await page.getByRole('navigation').getByRole('button', { name: '测试任务', exact: true }).click();
    await expect(page.getByText('当前仅显示已保存记录，未查询 Runner。', { exact: false })).toBeVisible();
    await page.getByRole('row').filter({ hasText: 'cblas_saxpy' }).getByRole('button', { name: '查看任务' }).click();
    await expect(page.getByText('仅显示上次保存的状态，未向 Runner 查询或发送取消请求。')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消测试' })).toBeDisabled();
    expect(testing.getCalls).toBe(reads);
  } finally { db.close(); await f.close(); testing.close(); }
});
