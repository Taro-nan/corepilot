import React, { useEffect, useState } from 'react';
import type { ProjectRecord } from '../../src/contracts/project';
import type { OptimizationWorkflowRecord } from '../../src/contracts/workflow';
import { isRegisteredRunner } from '../../src/config/runner-config';
import { request } from './api';
import { Badge, CopyValue, Disclosure, Feedback, Icon, Metric, time } from './components';
import { WorkflowList, matchesWorkflowStatus, type WorkflowStatusFilter } from './Workbench';
import { ProjectContextPicker, type ProjectContextField, type ProjectOverviewContext, type SavedProjectContext } from './ProjectContextPicker';
import type { CatalogItem } from './Configuration';
import type { TaskPreparationContext } from './TaskComposer';

export function ProjectOverview({ project, workflows, activeIds, navigate, create, check, discover, busy, checkResult, checkError, catalog, hasUnsavedConfig, contextSaved, prepare }: {
  project: ProjectRecord; workflows: OptimizationWorkflowRecord[]; activeIds: string[] | null;
  navigate: (page: string, workflow?: string, status?: WorkflowStatusFilter) => void;
  create: () => void; check: () => void; discover: () => void; busy: boolean; checkResult: string; checkError: boolean;
  catalog: CatalogItem[]; hasUnsavedConfig: () => boolean; contextSaved: (result: SavedProjectContext) => void;
  prepare: (context: TaskPreparationContext) => void;
}) {
  const [context, setContext] = useState<ProjectOverviewContext | null>(null);
  const [picker, setPicker] = useState<ProjectContextField | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setContext(null); setError('');
    void Promise.all([
      request<{ config: ProjectOverviewContext['config'] }>('/v1/projects/' + project.project_id + '/config'),
      request<ProjectOverviewContext['setup']>('/v1/projects/' + project.project_id + '/setup'),
      request<{ machines: ProjectOverviewContext['machines'] }>('/v1/machines'),
    ]).then(([config, setup, machines]) => { if (active) setContext({ config: config.config, setup, machines: machines.machines }); })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [project.project_id, project.updated_at, retry]);
  const config = context?.config;
  const runner = config?.runner;
  const machine = isRegisteredRunner(runner) ? context?.machines.find(item => item.machine_id === runner.machine_id) : undefined;
  const functionName = project.default_function ?? context?.setup.validation?.function_name ?? '';
  const functionMismatch = !!functionName && !!context?.setup.validation?.function_name && functionName !== context.setup.validation.function_name;
  // New projects contain editable placeholders; this is a configuration hint, not model qualification.
  const modelReady = !!config?.model.endpoint && !!config.model.model_id && config.model.model_id !== 'configure-model' && config.model.endpoint !== 'https://api.example.com/v1';
  const machineReady = !!machine?.enabled && machine.setup_complete;
  const validationReady = !!context && !functionMismatch && context.setup.checks.length > 0 && context.setup.checks.every(item => item.state === 'CONFIGURED')
    && (['QUALIFIED', 'LEGACY'].includes(context.setup.validation?.evaluator_status ?? '') || !!config?.validation.testpack.trim());
  const next = !modelReady ? { page: 'settings', title: '配置优化模型', text: '选择可调用工具的模型，即可让 Agent 调查和修改源码。' }
    : { page: 'tasks', title: '创建优化任务', text: validationReady ? '选择函数和分支，可仅生成代码，也可使用现有方案自动验证。' : '选择函数和分支开始代码优化；测试可以稍后单独进行。' };
  const attention = workflows.find(item => matchesWorkflowStatus(item, 'running', activeIds))
    ?? workflows.find(item => item.status === 'WAITING_APPROVAL');
  const prepareTarget = () => prepare({ projectId: project.project_id, functionName, sourceBranch: project.source_branch ?? '', machineId: machine?.machine_id ?? '', returnTo: 'overview' });
  return <>
    <div className="page-heading"><div><span className="page-eyebrow">项目工作台</span><h1>{project.name}</h1><p>让 Agent 优化源码，或单独创建两库测试。</p></div>
      <button className="primary" disabled={busy} onClick={create}><Icon name="plus" size={17} />创建优化任务</button></div>
    <div className="project-context-bar" aria-label="项目默认任务条件">
      <button type="button" aria-label={`更换优化分支，当前 ${project.source_branch ?? '当前检出版本'}`} onClick={() => setPicker('branch')}><Icon name="folder" size={15} /><span><small>分支</small><strong>{project.source_branch ?? '当前检出版本'}</strong></span><Icon name="edit" size={13} /></button>
      <button type="button" aria-label={`更换执行机器，当前 ${machine?.name ?? '尚未选择'}`} disabled={!context} onClick={() => setPicker('machine')}><Icon name="server" size={15} /><span><small>机器</small><strong>{machine?.name ?? (context ? '尚未选择' : '读取中…')}</strong>{machine && <small>{machine.status === 'ONLINE' ? '最近检测在线' : machine.status === 'OFFLINE' ? '最近检测离线' : '连接状态待检测'}</small>}</span><Icon name="edit" size={13} /></button>
      <button type="button" aria-label={`更换目标函数，当前 ${functionName || '尚未选择'}`} disabled={!context} onClick={() => setPicker('function')}><Icon name="code" size={15} /><span><small>目标函数</small><strong>{functionName || (context ? '尚未选择' : '读取中…')}</strong>{functionMismatch && <small className="context-warning">测试方案不匹配</small>}</span><Icon name="edit" size={13} /></button>
    </div>
    <section className="project-journey" aria-label="项目准备与下一步">
      <div className="journey-heading"><div><h2>{context ? '下一步：' + next.title : error ? '项目准备状态暂时不可用' : '正在读取项目准备状态…'}</h2><p>{context ? next.text : '不会启动构建、模型生成或性能实验。'}</p></div>{context && next.page !== 'tasks' && <button onClick={() => navigate(next.page)} disabled={busy}>{next.title}<Icon name="arrow" size={15} /></button>}</div>
      {error && <><Feedback text={error} bad /><button onClick={() => setRetry(value => value + 1)}>重新读取准备状态</button></>}
      <details className="journey-more"><summary>查看准备状态</summary><ol className="journey-steps">
        <li><span className="journey-index">1</span><div><strong>模型与执行机器</strong><p>{context ? modelReady ? config?.model.model_id : '尚未配置模型' : '读取已保存配置…'}{machine && ' · ' + machine.name}</p><button className="text-btn" onClick={() => navigate('settings')}>{modelReady && machineReady ? '查看或更换' : '完成设置'}<Icon name="arrow" size={13} /></button></div><span className="journey-state">{context ? modelReady && machineReady ? '已配置' : '待配置' : '读取中'}</span></li>
        <li><span className="journey-index">2</span><div><strong>测试准备（按需）</strong><p>{context ? validationReady ? '已有可复用方案；提交测试时核对当前条件' : functionMismatch ? '自动验证需要匹配的测试方案' : '仅生成代码时可跳过；测试时再准备构建与规则' : '读取接入状态…'}</p><button className="text-btn" onClick={prepareTarget}>{validationReady ? '查看测试方案' : '准备测试方案'}<Icon name="arrow" size={13} /></button></div><span className="journey-state">{context ? validationReady ? '已准备' : '按需准备' : '读取中'}</span></li>
        <li><span className="journey-index">3</span><div><strong>创建并执行任务</strong><p>确认函数、分支、机器与测试条件</p><span className="hint">执行后在任务详情查看阶段和结果</span></div><span className="journey-state">待选择目标</span></li>
      </ol></details>
    </section>
    {attention && <div className="attention-row"><div><strong>{attention.function_name}</strong><Badge value={attention.status} /><p>{attention.status === 'WAITING_APPROVAL' ? '已有结果等待人工决定。先查看测试、性能和适用范围。' : '任务在后台执行，可继续查看当前阶段与等待原因。'}</p></div><button onClick={() => navigate('tasks', attention.workflow_id)}>查看任务<Icon name="arrow" size={15} /></button></div>}
    <div className="metrics overview-metrics">
      <Metric title="近期优化任务" value={workflows.length} onClick={() => navigate('tasks')} />
      <Metric title="正在运行" value={workflows.filter(w => matchesWorkflowStatus(w, 'running', activeIds)).length} onClick={() => navigate('tasks', '', 'running')} />
      <Metric title="待人工审阅" value={workflows.filter(w => matchesWorkflowStatus(w, 'review')).length} onClick={() => navigate('tasks', '', 'review')} />
      <Metric title="已交付" value={workflows.filter(w => matchesWorkflowStatus(w, 'delivered')).length} onClick={() => navigate('tasks', '', 'delivered')} />
      <Metric title="失败或未达标" value={workflows.filter(w => matchesWorkflowStatus(w, 'failed')).length} onClick={() => navigate('tasks', '', 'failed')} />
    </div>
    <WorkflowList workflows={workflows.slice(0, 4)} compact activeIds={activeIds} open={id => navigate('tasks', id)} />
    {workflows.length > 4 && <button className="text-btn all-tasks-link" onClick={() => navigate('tasks')}>查看全部 {workflows.length} 个近期任务<Icon name="arrow" size={15} /></button>}
    <Disclosure title="项目详情与诊断" summary="源码位置、配置文件、运行前检查和源码调查">
      <dl className="definition"><dt>源码目录</dt><dd><CopyValue value={project.repository_root} label="源码目录" /></dd><dt>配置文件</dt><dd><CopyValue value={project.config_path} label="配置路径" /></dd><dt>添加时间</dt><dd>{time(project.created_at)}</dd></dl>
      <div className="actions"><button disabled={busy} onClick={check}>运行前检查</button><button disabled={busy} onClick={discover}>调查源码</button><span className="hint">检查不会创建优化任务；调查生成的内容仍是待验证草稿。</span></div>
      {checkResult && <><Feedback text={checkResult} bad={checkError} />{checkError && <button type="button" className="text-btn" onClick={prepareTarget}>检查构建与验证<Icon name="arrow" size={14} /></button>}</>}
    </Disclosure>
    {picker && <ProjectContextPicker key={picker} field={picker} project={project} context={context} catalog={catalog} hasUnsavedConfig={hasUnsavedConfig} close={() => setPicker(null)} navigate={navigate} saved={result => { if (result.config) setContext(current => current ? { ...current, config: result.config! } : current); contextSaved(result); setPicker(null); setRetry(count => count + 1); }} />}
  </>;
}
