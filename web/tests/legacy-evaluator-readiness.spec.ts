import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { startWebFixture } from '../../tests/web-fixture.js';
import { prepareReviewFixture } from '../../tests/validation-review-fixture.js';
import { seedHistoricalQualification } from '../../tests/legacy-evaluator-fixture.js';

test('historically qualified old adapter explains how to prepare a new plan before verified optimization', async ({ page }) => {
  const f = await startWebFixture();
  const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const history = seedHistoricalQualification(f, r, true);
    const oldQualification = fs.readFileSync(history.qualificationPath);
    await page.goto(f.url);
    await page.getByLabel('管理员访问凭据').fill(f.token);
    await page.getByRole('button', { name: '进入工作台' }).click();
    await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
    const task = page.getByRole('dialog', { name: '创建优化任务' });
    await expect(task.getByRole('radio', { name: /优化并自动验证/ })).toBeChecked();
    await expect(task).toContainText('旧版生成适配器');
    await expect(task).toContainText('旧条件不会自动复制');
    await expect(task.getByRole('button', { name: '开始优化' })).toBeDisabled();
    await task.getByRole('radio', { name: /仅生成优化代码/ }).check();
    await expect(task.getByRole('button', { name: '开始优化' })).toBeEnabled();
    await task.getByRole('radio', { name: /优化并自动验证/ }).check();
    await task.getByRole('button', { name: '准备构建与验证', exact: true }).click();
    const review = page.locator('.validation-review');
    await expect(review).toContainText('历史上已获资格，暂不能用于新的正式优化');
    await expect(review).toContainText('Historical fixture reviewer');
    await expect(review).toContainText('请新建测试方案');
    await expect(review).not.toContainText('测试方案已确认，可用于正式优化');
    await page.getByRole('button', { name: '新建方案', exact: true }).click();
    await expect(page.getByRole('button', { name: /识别源码与测试资产|重新识别源码/ })).toBeVisible();
    expect(fs.readFileSync(history.qualificationPath)).toEqual(oldQualification);
    expect(f.service.list()).toHaveLength(0);
    expect(f.modelRequests.inference).toBe(0);
  } finally { await r.close(); await f.close(); }
});
