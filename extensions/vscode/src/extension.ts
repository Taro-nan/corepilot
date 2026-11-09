import * as vscode from 'vscode';
import type { OptimizationWorkflowRecord } from '../../../src/contracts/workflow.js';
import { serverUrl, type CorePilotClient } from './client.js';
import { connect, selectedProject, selectProject, setToken, showConnectionError } from './session.js';
import { statusLabel, WorkflowItem, WorkflowTree } from './tasks.js';

async function chooseWorkflow(context: vscode.ExtensionContext, item?: WorkflowItem): Promise<{ id: string; client: CorePilotClient } | null> {
  const client = await connect(context);
  if (item?.workflow?.workflow_id) {
    if (item.serverUrl !== client.url) throw new Error('服务地址已改变，请刷新任务列表后重试。');
    return { id: item.workflow.workflow_id, client };
  }
  const project = await selectedProject(context, client) ?? await selectProject(context, client);
  if (!project) return null;
  const { workflows, activeIds, limited } = await client.workflows(project);
  if (!workflows.length) { void vscode.window.showInformationMessage(limited ? '最近 200 条记录中没有关联任务。' : '未找到配置或源码目录相同的任务。'); return null; }
  const selected = await vscode.window.showQuickPick(workflows.map(workflow => ({ label: workflow.function_name,
    description: statusLabel(workflow, activeIds === null ? undefined : activeIds.includes(workflow.workflow_id)),
    detail: `${workflow.source_branch ?? '未记录分支'} · ${workflow.workflow_id}`, id: workflow.workflow_id })),
  { title: '选择关联任务（按配置或源码目录匹配）' });
  return selected ? { id: selected.id, client } : null;
}

async function openText(language: string, content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ language, content });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function workflowDetail(workflow: OptimizationWorkflowRecord, attached?: boolean): string {
  const lines = [`CorePilot 优化任务：${workflow.function_name}`, `状态：${statusLabel(workflow, attached)}`,
    `任务 ID：${workflow.workflow_id}`, `分支：${workflow.source_branch ?? '未记录'}`,
    `执行模式：${workflow.verification_mode === 'source_only' ? '仅生成源码候选' : '优化并验证'}`,
    `阶段：${workflow.progress?.phase ?? '尚未开始'}`, `最近进展：${workflow.progress?.last_event ?? '暂无'}`];
  if (workflow.progress?.runner_experiment_id) lines.push(`Runner 作业：${workflow.progress.runner_experiment_id}`);
  if (workflow.progress?.runner_status) lines.push(`Runner 状态：${workflow.progress.runner_status}`);
  if (workflow.error) lines.push(`原因：${workflow.error}`);
  if (workflow.verification_mode === 'source_only') lines.push('本任务未执行构建、正确性或性能测试。');
  lines.push('查看报告以分别核对正确性、性能、人工审阅与交付状态。');
  return lines.join('\n') + '\n';
}

export function activate(context: vscode.ExtensionContext): void {
  const tree = new WorkflowTree(context);
  context.subscriptions.push(tree, vscode.window.registerTreeDataProvider('corepilot.tasks', tree));
  const command = <Args extends unknown[]>(name: string, operation: (...args: Args) => Promise<void> | void) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: Args) => {
      try { await operation(...args); } catch (error) { await showConnectionError(error); }
    }));
  };

  command('corepilot.connect', async () => {
    const current = vscode.workspace.getConfiguration('corepilot').get<string>('serverUrl', 'http://127.0.0.1:4317');
    const value = await vscode.window.showInputBox({ title: '连接 CorePilot 服务', value: current,
      prompt: '输入已运行的 CorePilot 服务地址；不会自动启动或关闭服务。',
      validateInput: input => { try { serverUrl(input); return null; } catch (error) { return (error as Error).message; } } });
    if (value === undefined) return;
    await vscode.workspace.getConfiguration('corepilot').update('serverUrl', serverUrl(value), vscode.ConfigurationTarget.Global);
    const client = await connect(context);
    await client.projects();
    tree.refresh();
    void vscode.window.showInformationMessage('CorePilot 服务已连接。请选择项目。');
  });
  command('corepilot.setToken', async () => { await setToken(context); tree.refresh(); });
  command('corepilot.selectProject', async () => { if (await selectProject(context, await connect(context))) tree.refresh(); });
  command('corepilot.refreshTasks', () => tree.refresh());
  command('corepilot.showTasks', async () => { tree.refresh(); await vscode.commands.executeCommand('corepilot.tasks.focus'); });

  const openWeb = async (page: 'tasks' | 'testing') => {
    const client = await connect(context);
    if (!client.health.capabilities?.includes('web')) throw new Error('当前服务未提供网页。请使用已启用网页的 CorePilot 服务，然后重试。');
    const url = new URL(client.url); url.hash = `/${page}`;
    await vscode.env.openExternal(vscode.Uri.parse(url.toString()));
    void vscode.window.showInformationMessage(page === 'tasks'
      ? '请在网页选择项目并创建优化任务；编辑器选区不会自动作为函数、提示词或修改范围。'
      : '请在网页选择测试对象和测试方案。');
  };
  for (const name of ['corepilot.newExperiment', 'corepilot.initTask', 'corepilot.optimize']) command(name, () => openWeb('tasks'));
  command('corepilot.openTesting', () => openWeb('testing'));

  command('corepilot.showTaskDetails', async (item?: WorkflowItem) => {
    const selected = await chooseWorkflow(context, item); if (!selected) return;
    const detail = await selected.client.workflow(selected.id);
    await openText('plaintext', workflowDetail(detail.workflow, detail.execution_attached));
  });
  command('corepilot.openReport', async (item?: WorkflowItem) => {
    const selected = await chooseWorkflow(context, item); if (!selected) return;
    const report = await selected.client.api.getOptimizationReport(selected.id);
    await openText('markdown', report.markdown);
  });
  command('corepilot.exportTask', async (item?: WorkflowItem) => {
    const selected = await chooseWorkflow(context, item); if (!selected) return;
    const report = await selected.client.api.getOptimizationReport(selected.id);
    const uri = await vscode.window.showSaveDialog({ title: '保存 CorePilot 报告', filters: { Markdown: ['md'] }, saveLabel: '保存报告' });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(report.markdown, 'utf8'));
    void vscode.window.showInformationMessage('CorePilot 报告已保存。');
  });
  command('corepilot.cancelTask', async (item?: WorkflowItem) => {
    const selected = await chooseWorkflow(context, item); if (!selected) return;
    const choice = await vscode.window.showWarningMessage('向后台请求取消此优化任务？任务停止需要后台确认。', { modal: true }, '发送取消请求');
    if (!choice) return;
    const result = await selected.client.api.cancelOptimizationWorkflow(selected.id) as { status: string; message: string };
    tree.refresh();
    void vscode.window.showInformationMessage(result.status === 'CANCEL_REQUESTED'
      ? '已发送取消请求，正在等待后台确认停止。' : result.status === 'CANCELLED' ? '后台已确认任务取消。' : `任务当前状态：${result.status}。`);
  });
  command('corepilot.showCandidateDiff', async (item?: WorkflowItem) => {
    const selected = await chooseWorkflow(context, item); if (!selected) return;
    const { id, client } = selected, report = await client.api.getOptimizationReport(id);
    const candidates = report.report.candidates;
    if (!candidates.length) { void vscode.window.showInformationMessage('此任务尚无冻结的源码候选。'); return; }
    const picked = candidates.length === 1 ? candidates[0] : (await vscode.window.showQuickPick(candidates.map(candidate => ({
      label: `候选 ${candidate.candidate.sequence}`, description: candidate.candidate.status, detail: candidate.candidate.candidate_id, candidate,
    })), { title: '选择要查看的候选补丁' }))?.candidate;
    if (!picked) return;
    const diff = await client.candidateDiff(id, picked.candidate.candidate_id);
    await openText('diff', diff || '此候选没有源码差异。');
  });

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('corepilot.serverUrl')) tree.refresh(); }));
  const timer = setInterval(() => tree.refresh(), 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void { /* VS Code disposes the subscriptions. */ }
