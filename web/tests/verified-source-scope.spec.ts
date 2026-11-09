import { test, expect, type Page } from '@playwright/test';
import { startWebFixture } from '../../tests/web-fixture.js';
import { seedBlockedValidation } from '../../tests/validation-recovery-fixture.js';
import { PiOptimizationSession } from '../../src/agent/pi-optimization-session.js';
import { COREPILOT_PI_PROVIDER_ID, createPiModels } from '../../src/model/pi-provider.js';
import { loadOptimizationConfig } from '../../src/config/optimization-config.js';

async function login(page: Page, url: string, token: string) {
  await page.goto(url);
  await page.getByLabel('管理员访问凭据').fill(token);
  await page.getByRole('button', { name: '进入工作台' }).click();
}

test('verified task without a Package shows the same source authorization in preflight and intake', async ({ page }) => {
  const f = await startWebFixture();
  try {
    f.projects.add({ name: '显式源码授权', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    await login(page, f.url, f.token);
    await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建优化任务' });
    await dialog.getByRole('radio', { name: /优化并自动验证/ }).check();
    await expect(dialog.getByLabel('允许修改的源码文件或目录')).toBeVisible();
    await dialog.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
    await dialog.getByRole('button', { name: '运行前检查', exact: true }).click();
    await expect(dialog.locator('.check-output')).toContainText('允许修改：kernel.c');
    await dialog.getByRole('button', { name: '开始优化', exact: true }).click();
    await expect.poll(() => f.service.list().length).toBe(1);
    const record = f.service.list()[0];
    expect(record.source_scope_authorization?.candidate_scope).toEqual({ include: ['kernel.c'], exclude: [] });
    expect(f.store.getOptimizationTask(record.optimization_task_id!)!.target.scope.candidate_scope).toEqual({ include: ['kernel.c'], exclude: [] });
    expect(f.modelRequests.inference).toBe(0);
  } finally { await f.close(); }
});

test('a Package keeps its own scope and does not ask for a second authorization', async ({ page }) => {
  const f = await startWebFixture();
  try {
    const project = f.projects.add({ name: '接入包范围', repository_root: f.repo, config_path: f.configPath });
    f.projects.saveConfig(project.project_id, { ...f.projects.config(project.project_id),
      validation: { library_package: { package_id: 'ftblas', package_version: '1.0.0', target_id: 'sgemv-n' }, baseline_artifact: '/fixture/baseline.so' },
      runner: { mode: 'rpc', endpoint: 'http://127.0.0.1:4327', token: 'fixture-token' } });
    await login(page, f.url, f.token);
    await page.getByRole('button', { name: '创建优化任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '创建优化任务' });
    await dialog.getByRole('radio', { name: /优化并自动验证/ }).check();
    await expect(dialog.getByLabel('允许修改的源码文件或目录')).toHaveCount(0);
    expect(f.service.list()).toHaveLength(0);
  } finally { await f.close(); }
});

test('historical verified session asks for continuation scope before editing', async ({ page }) => {
  const f = await startWebFixture();
  try {
    f.projects.add({ name: '历史授权', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const seeded = await seedBlockedValidation(f, false, true);
    const old = f.service.get(seeded.workflowId)!;
    old.status = 'INTERRUPTED'; old.candidate_evaluation_feedback = null;
    f.store.saveOptimizationWorkflowJson(old.workflow_id, JSON.stringify(old));
    await login(page, f.url, f.token);
    await page.getByRole('button', { name: '优化任务', exact: true }).click();
    await page.getByRole('row').filter({ hasText: 'kernel' }).click();
    await expect(page.getByText('历史任务未记录修改授权')).toBeVisible();
    await page.getByLabel('允许修改的源码文件或目录').fill('kernel.c');
    await page.getByRole('button', { name: '继续优化', exact: true }).click();
    await expect.poll(() => f.service.get(old.workflow_id)?.source_scope_authorization?.kind).toBe('CONTINUATION');
    expect(f.store.getCandidate(seeded.candidate.candidate_id)?.source.commit).toBe(seeded.candidate.source.commit);
  } finally { await f.close(); }
});

test('historical unresolved experiment can be checked without source authorization or another run', async ({ page }) => {
  const f = await startWebFixture();
  try {
    f.projects.add({ name: '历史实验对账', repository_root: f.repo, config_path: f.configPath, source_branch: 'main' });
    const seeded = await seedBlockedValidation(f, false, true);
    const old = f.service.get(seeded.workflowId)!;
    old.status = 'INTERRUPTED'; old.candidate_evaluation_feedback = null;
    f.store.saveOptimizationWorkflowJson(old.workflow_id, JSON.stringify(old));
    const running = { ...f.store.getExperiment(seeded.experiment.experiment_id)!, status: 'RUNNING' as const, validity: 'UNKNOWN' as const,
      ended_at: null, failure_category: null, evaluation: null };
    f.store.saveExperiment(running);
    const model = loadOptimizationConfig(f.configPath).config.model;
    const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
    const session = await PiOptimizationSession.open({ id: old.agent_session!.id, directory: old.agent_session!.directory,
      models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'Browser recovery fixture.' });
    await session.checkpoint({ ...seeded.saved, phase: 'VALIDATION', activeExperimentId: running.experiment_id,
      pendingDecision: null, evaluationFeedback: null }); await session.close();
    await login(page, f.url, f.token);
    await page.getByRole('button', { name: '优化任务', exact: true }).click();
    await page.getByRole('row').filter({ hasText: 'kernel' }).click();
    await page.getByRole('button', { name: '核对原实验', exact: true }).click();
    await expect.poll(() => f.service.get(old.workflow_id)?.error ?? '', { timeout: 15000 }).toContain('本地进程状态未确认');
    expect(f.service.get(old.workflow_id)?.source_scope_authorization).toBeUndefined();
    expect(f.store.getExperiment(running.experiment_id)).toEqual(running);
    expect(f.store.listExperiments(seeded.candidate.task_id)).toHaveLength(1);
    expect(f.modelRequests.inference).toBe(0);
  } finally { await f.close(); }
});
