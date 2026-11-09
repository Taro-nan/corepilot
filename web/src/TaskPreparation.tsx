import React, { useEffect, useState } from 'react';
import type { ProjectRecord } from '../../src/contracts/project';
import type { ProjectSetup, ProjectValidationPlans } from '../../src/contracts/project-setup';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import { isRegisteredRunner } from '../../src/config/runner-config';
import type { TaskPreparationContext } from './TaskComposer';
import { Configuration, type CatalogItem, type ConfigDraft } from './Configuration';
import type { ValidationEditorDraft } from './ValidationAssetsEditor';
import { request } from './api';
import { Feedback, Icon } from './components';

export function TaskPreparation({ project, context, catalog, drafts, validationDrafts, notify, refresh, manageMachines, returnToTask }: {
  project: ProjectRecord; context: TaskPreparationContext; catalog: CatalogItem[]; drafts: Map<string, ConfigDraft>;
  validationDrafts: Map<string, ValidationEditorDraft>; notify: (message: string, bad?: boolean) => void;
  refresh: () => void; manageMachines: () => void; returnToTask: () => void;
}) {
  const [data, setData] = useState<{ setup: ProjectSetup; plans: ProjectValidationPlans | null; config: OptimizationConfig; machines: ExecutionMachineSummary[] } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setData(null); setError('');
    const base = `/v1/projects/${encodeURIComponent(project.project_id)}`;
    void Promise.all([
      request<ProjectSetup>(`${base}/setup`), request<{ config: OptimizationConfig }>(`${base}/config`),
      request<{ machines: ExecutionMachineSummary[] }>('/v1/machines'),
      context.functionName ? request<ProjectValidationPlans>(`${base}/validation-plans?function_name=${encodeURIComponent(context.functionName)}`) : Promise.resolve(null),
    ]).then(([setup, config, machines, plans]) => { if (active) setData({ setup, config: config.config, machines: machines.machines, plans }); })
      .catch(failure => { if (active) setError((failure as Error).message); });
    return () => { active = false; };
  }, [project.project_id, context.functionName, retry]);
  const projectMachineId = data && isRegisteredRunner(data.config.runner) ? data.config.runner.machine_id : '';
  const projectMachine = data?.machines.find(machine => machine.machine_id === projectMachineId)?.name ?? (projectMachineId ? '已登记机器' : '尚未选择');
  const taskMachine = !data ? '读取中…' : data.machines.find(machine => machine.machine_id === context.machineId)?.name ?? (context.machineId ? '原机器不可用' : projectMachine);
  const machineDiffers = !!data && !!context.machineId && context.machineId !== projectMachineId;
  const branchDiffers = !!data && !!context.sourceBranch && context.sourceBranch !== (project.source_branch ?? '');
  return <>
    <div className="page-heading task-preparation-heading"><div><span className="page-eyebrow">优化任务 / 准备条件</span><h1>构建与验证</h1><p>选择方案，确认基线与测试条件。</p></div><button type="button" onClick={returnToTask}><Icon name="back" size={15} />{context.returnTo === 'task' ? '返回任务配置' : '返回项目概览'}</button></div>
    <section className="task-preparation-context" aria-label="当前任务准备上下文"><div><span>项目</span><strong>{project.name}</strong></div><div><span>目标函数</span><strong>{context.functionName || '尚未指定'}</strong></div><div><span>任务分支</span><strong>{context.sourceBranch || project.source_branch || '当前检出版本'}</strong></div><div><span>任务机器</span><strong>{taskMachine}</strong></div></section>
    <p className="task-preparation-note">方案与基线可供后续任务复用。</p>
    {(machineDiffers || branchDiffers) && <div className="notice compact" role="status"><strong>试跑环境与本次任务不同</strong>：测试生成和试运行使用项目分支 {project.source_branch ?? '当前检出版本'}、项目机器 {projectMachine}。如需更换，请先调整项目默认设置；分支基线构建使用单独选择的分支。</div>}
    {error ? <><Feedback text={`无法读取任务准备信息：${error}`} bad /><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取</button></> : !data ? <div className="loading" role="status">正在查找当前函数的测试方案…</div> : <Configuration key={`${project.project_id}:${context.functionName}`} mode="validation" project={project} catalog={catalog} notify={notify}
      drafts={drafts} validationDrafts={validationDrafts} preparation={{ task: context, plans: data.plans, setup: data.setup }} refresh={refresh} manageMachines={manageMachines} openValidation={() => {}} />}
  </>;
}
