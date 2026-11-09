import * as vscode from 'vscode';
import type { OptimizationWorkflowRecord } from '../../../src/contracts/workflow.js';
import { connect, selectedProject } from './session.js';

const labels: Record<string, string> = {
  CREATED: '等待执行', GENERATING: '正在优化', BUDGET_EXHAUSTED: '预算已用完', INTERRUPTED: '已中断',
  VALIDATION_BLOCKED: '验证受阻', WAITING_APPROVAL: '审阅与交付状态见报告', CANDIDATE_READY: '候选待测试',
  PERFORMANCE_THRESHOLD_NOT_MET: '性能未达标', NO_CANDIDATE: '未生成候选', DELIVERABLE: '交付状态见报告', FAILED: '失败', CANCELLED: '已取消',
};

export function statusLabel(workflow: OptimizationWorkflowRecord, attached?: boolean): string {
  if (workflow.progress?.phase === 'CANCEL_REQUESTED' && workflow.status !== 'CANCELLED') return '已请求取消，等待停止';
  if (attached === false && ['CREATED', 'GENERATING'].includes(workflow.status)) return '后台未接管，请核对';
  return labels[workflow.status] ?? workflow.status;
}

export class WorkflowItem extends vscode.TreeItem {
  constructor(readonly workflow: OptimizationWorkflowRecord, readonly serverUrl: string, association: string, attached?: boolean) {
    super(workflow.function_name, vscode.TreeItemCollapsibleState.None);
    this.description = `${statusLabel(workflow, attached)} · ${workflow.source_branch ?? '未记录分支'}`;
    this.tooltip = `${workflow.workflow_id}\n${association}；服务未记录项目身份，可能包含其他项目的任务。\n${workflow.progress?.last_event ?? '尚无阶段进展'}`;
    this.contextValue = 'corepilot.workflow';
    this.command = { command: 'corepilot.showTaskDetails', title: '查看任务进展', arguments: [this] };
  }
}

function action(label: string, command: string): vscode.TreeItem {
  const item = new vscode.TreeItem(label); item.command = { command, title: label }; return item;
}

/** A tree is only a view of server facts; no task state is maintained in VS Code. */
export class WorkflowTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly context: vscode.ExtensionContext) {}
  refresh(): void { this.emitter.fire(); }
  dispose(): void { this.emitter.dispose(); }
  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    try {
      const client = await connect(this.context);
      const project = await selectedProject(this.context, client);
      if (!project) return [action('选择 CorePilot 项目', 'corepilot.selectProject')];
      const result = await client.workflows(project);
      const heading = action(`项目：${project.name}（切换）`, 'corepilot.selectProject');
      const scope = new vscode.TreeItem('按配置或源码目录关联，可能包含其他项目的任务');
      const rows = result.workflows.map(workflow => new WorkflowItem(workflow, client.url,
        workflow.config_path === project.config_path ? '配置路径相同' : '源码目录相同',
        result.activeIds === null ? undefined : result.activeIds.includes(workflow.workflow_id)));
      return [heading, scope, ...(rows.length ? rows : [action(result.limited ? '最近 200 条记录中没有关联任务' : '暂无关联任务，在网页创建', 'corepilot.newExperiment')]),
        ...(result.limited ? [new vscode.TreeItem('仅查询最近 200 条任务记录')] : [])];
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : null;
      return [action(status === 401 ? '需要连接令牌，点击设置' : '连接失败，点击检查服务地址', status === 401 ? 'corepilot.setToken' : 'corepilot.connect')];
    }
  }
}
