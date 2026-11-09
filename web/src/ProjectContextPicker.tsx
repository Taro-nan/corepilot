import React, { useEffect, useMemo, useState } from 'react';
import type { ProjectRecord, RepositoryInspection } from '../../src/contracts/project';
import type { ProjectSetup } from '../../src/contracts/project-setup';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import { isRegisteredRunner } from '../../src/config/runner-config';
import type { CatalogItem } from './Configuration';
import { api, request } from './api';
import { Feedback, Field, Modal } from './components';
import { SourceBranchSelect } from './SourceProject';

export type ProjectContextField = 'branch' | 'machine' | 'function';
export interface ProjectOverviewContext { config: OptimizationConfig; setup: ProjectSetup; machines: ExecutionMachineSummary[] }
export interface SavedProjectContext { field: ProjectContextField; value: string; project?: ProjectRecord; config?: OptimizationConfig }

export function ProjectContextPicker({ field, project, context, catalog, hasUnsavedConfig, close, saved, navigate }: {
  field: ProjectContextField; project: ProjectRecord; context: ProjectOverviewContext | null; catalog: CatalogItem[];
  hasUnsavedConfig: () => boolean; close: () => void; saved: (result: SavedProjectContext) => void; navigate: (page: string) => void;
}) {
  const titles = { branch: '更换优化分支', machine: '更换执行机器', function: '更换目标函数' };
  const initial = field === 'branch' ? project.source_branch ?? '' : field === 'machine'
    ? isRegisteredRunner(context?.config.runner) ? context.config.runner.machine_id : ''
    : project.default_function ?? context?.setup.validation?.function_name ?? '';
  const [value, setValue] = useState(initial);
  const [repository, setRepository] = useState<RepositoryInspection | null>(null);
  const [machines, setMachines] = useState(context?.machines ?? []);
  const [setup, setSetup] = useState(context?.setup ?? null);
  const [loading, setLoading] = useState(field !== 'function');
  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(30);
  const selection = context?.config.validation.library_package;
  const availableFunctions = useMemo(() => {
    const names = new Set(setup?.discovery?.functions.map(item => item.symbol) ?? []);
    if (setup?.validation?.function_name) names.add(setup.validation.function_name);
    const selectedPackage = catalog.find(item => item.package_id === selection?.package_id && item.version === selection.package_version);
    for (const target of selectedPackage?.targets ?? []) {
      const name = selectedPackage?.functions.find(item => item.function_id === target.function_id)?.api;
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [catalog, selection?.package_id, selection?.package_version, setup]);
  const matching = availableFunctions.filter(name => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const machine = machines.find(item => item.machine_id === value);
  const mismatch = field === 'function' && !!value.trim() && !!setup?.validation?.function_name && value.trim() !== setup.validation.function_name;
  useEffect(() => {
    if (field === 'function') return;
    let active = true;
    setLoading(true); setError('');
    const load = field === 'branch' ? api.inspectRepository(project.repository_root) : request<{ machines: ExecutionMachineSummary[] }>('/v1/machines');
    void load.then(result => {
      if (!active) return;
      if (field === 'branch') {
        const found = result as RepositoryInspection;
        setRepository(found);
        setValue(current => current || found.current_branch || found.branches[0]?.name || '');
      } else setMachines((result as { machines: ExecutionMachineSummary[] }).machines);
    }).catch(failure => { if (active) setError((failure as Error).message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [field, project.repository_root, retry]);

  async function inspectFunctions() {
    setInspecting(true); setError('');
    try { setSetup(await request<ProjectSetup>(`/v1/projects/${project.project_id}/source-inspection`, 'POST', {})); }
    catch (failure) { setError((failure as Error).message); }
    finally { setInspecting(false); }
  }
  async function save() {
    const choice = value.trim();
    if (!choice || saving) return;
    if (field === 'machine' && hasUnsavedConfig()) {
      setError('项目配置中有未保存的更改。请先到模型与机器或构建与验证保存或放弃更改，再切换默认机器。'); return;
    }
    setSaving(true); setError('');
    try {
      if (field === 'machine') {
        const result = await request<{ config: OptimizationConfig }>(`/v1/projects/${project.project_id}/machine`, 'PUT', { machine_id: choice });
        saved({ field, value: choice, config: result.config });
      } else {
        const result = await request<{ project: ProjectRecord }>(`/v1/projects/${project.project_id}/defaults`, 'PUT',
          field === 'branch' ? { source_branch: choice } : { function_name: choice });
        saved({ field, value: choice, project: result.project });
      }
    } catch (failure) { setError((failure as Error).message); } finally { setSaving(false); }
  }

  return <Modal title={titles[field]} onClose={() => { if (!saving) close(); }} className="project-context-dialog"
    footer={<div className="actions"><button type="button" disabled={saving} onClick={close}>取消</button><button type="button" className="primary" disabled={saving || loading || !value.trim() || (field === 'branch' && !repository?.branches.some(item => item.name === value)) || (field === 'machine' && !machine?.enabled)} onClick={() => void save()}>{saving ? '正在保存…' : '保存选择'}</button></div>}>
    <p className="context-picker-intro">保存后作为本项目后续任务的默认选择；已经创建的任务继续使用原有条件。</p>
    {loading && <p className="hint" role="status">正在读取{field === 'branch' ? '分支' : '执行机器'}…</p>}
    {error && <><Feedback text={error} bad />{field !== 'function' && !loading && !saving && <button type="button" className="text-btn" onClick={() => setRetry(count => count + 1)}>重新读取</button>}</>}
    {field === 'branch' && repository && <><SourceBranchSelect repository={repository} value={value} onChange={setValue} disabled={saving} /><p className="hint">这里只更换项目默认分支，不会切换源码目录中的 Git 检出分支。创建任务时仍可单独调整。</p></>}
    {field === 'machine' && !loading && <>{machines.length ? <Field label="执行机器" help="显示维护者注册的机器及最近一次连接状态。"><select value={value} onChange={event => setValue(event.target.value)} disabled={saving}>
      <option value="" disabled hidden>选择已注册机器</option>{value && !machine && <option value={value} disabled>原执行机器不可用</option>}
      {machines.map(item => <option key={item.machine_id} value={item.machine_id} disabled={!item.enabled}>{item.name} · {item.status === 'ONLINE' ? '在线' : item.status === 'OFFLINE' ? '离线' : '状态待检测'}{!item.enabled ? ' · 已停用' : ''}</option>)}
    </select></Field> : <p className="hint">尚未注册执行机器，请先由维护者添加 Runner。</p>}
      {machine && machine.status !== 'ONLINE' && <p className="notice compact">所选机器最近未确认在线，运行前检查会检测连接。</p>}
      <button type="button" className="text-btn" onClick={() => { close(); navigate('machines'); }}>管理执行机器</button></>}
    {field === 'function' && <div className="context-function-picker">
      <p className="hint">函数列表来自已识别的源码和当前接入方案；源码识别基于当前检出版本，其他分支仍需核对。</p>
      <Field label="搜索或输入函数名"><input type="search" autoFocus value={query} onChange={event => { setQuery(event.target.value); setShown(30); }} placeholder="输入函数名筛选" /></Field>
      {query.trim() && <button type="button" className="text-btn" onClick={() => setValue(query.trim())}>使用输入的函数：{query.trim()}</button>}
      <div className="context-function-list" aria-label="可选函数">{matching.length ? matching.slice(0, shown).map(name => <button key={name} type="button" aria-pressed={value === name} onClick={() => setValue(name)}><span>{name}</span><small>{value === name ? '已选择' : name === setup?.validation?.function_name ? '当前测试方案' : '选择'}</small></button>) : <p className="hint">{availableFunctions.length ? '没有匹配的已识别函数，可以使用输入的函数名。' : '尚未识别源码函数，可以输入函数名或先识别源码。'}</p>}</div>
      {matching.length > shown && <button type="button" className="text-btn" onClick={() => setShown(count => count + 30)}>显示更多（剩余 {matching.length - shown} 项）</button>}
      <div className="context-function-selection"><span>当前选择</span><strong>{value || '尚未选择'}</strong></div>
      {mismatch && <p className="notice compact">现有测试方案用于 {setup?.validation?.function_name}。保存后请为 {value.trim()} 准备匹配的测试方案，再开始优化。</p>}
      <button type="button" className="text-btn" disabled={inspecting} onClick={() => void inspectFunctions()}>{inspecting ? '正在识别源码…' : setup?.discovery ? '重新识别源码函数' : '识别源码函数'}</button>
    </div>}
  </Modal>;
}
