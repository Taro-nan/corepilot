import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '../../src/contracts/project';
import type { OptimizationWorkflowRecord } from '../../src/contracts/workflow';
import type { OptimizationReportResponse } from '../../src/contracts/optimization-report';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ProjectSetup } from '../../src/contracts/project-setup';
import { api, request } from './api';
import { Brand, Empty, Field, Icon, Metric, Modal, Feedback } from './components';
import { Configuration, type CatalogItem, type ConfigDraft } from './Configuration';
import { Workbench, WorkflowList, type WorkflowStatusFilter } from './Workbench';
import { AddProject } from './SourceProject';
import { ProjectOverview } from './ProjectOverview';
import { TaskComposer, updateTaskDraftSelection, type TaskComposerContext, type TaskPreparationContext } from './TaskComposer';
import { TaskPreparation } from './TaskPreparation';
import type { SavedProjectContext } from './ProjectContextPicker';
import type { ValidationEditorDraft } from './ValidationAssetsEditor';
import { ExecutionMachines } from './ExecutionMachines';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';

const menus = [{ id: 'overview', title: '项目概览', icon: 'home' }, { id: 'tasks', title: '优化任务', icon: 'tasks' }, { id: 'analysis', title: '实验分析', icon: 'chart' }, { id: 'reports', title: '优化报告', icon: 'report' }, { id: 'settings', title: '模型与机器', icon: 'server' }, { id: 'machines', title: '执行机器', icon: 'server' }];
const statusFilters: WorkflowStatusFilter[] = ['all', 'running', 'review', 'success', 'delivered', 'failed', 'blocked', 'cancelled'];
const route = () => {
  const [pathname, query = ''] = location.hash.split('?');
  const [, requestedPage = 'overview', segment = ''] = pathname.split('/');
  const page = requestedPage === 'settings' && segment === 'validation' ? 'validation' : requestedPage === 'tasks' && segment === 'prepare' ? 'task-setup' : requestedPage;
  const params = new URLSearchParams(query);
  const requestedStatus = params.get('status') as WorkflowStatusFilter | null;
  const preparation: TaskPreparationContext | null = page === 'task-setup' ? { projectId: params.get('project') ?? '', functionName: params.get('function') ?? '',
    sourceBranch: params.get('source_branch') ?? '', machineId: params.get('machine') ?? '', returnTo: params.get('return') === 'task' ? 'task' : 'overview' } : null;
  return { page, preparation, workflow: ['tasks', 'analysis', 'reports'].includes(page) ? decodeURIComponent(segment) : '', status: requestedStatus && statusFilters.includes(requestedStatus) ? requestedStatus : 'all' as WorkflowStatusFilter };
};

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [projectId, setProjectId] = useState(localStorage.getItem('corepilot-project') ?? '');
  const [workflows, setWorkflows] = useState<OptimizationWorkflowRecord[]>([]);
  const [activeIds, setActiveIds] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [currentRoute, setRoute] = useState(route);
  const [response, setResponse] = useState<OptimizationReportResponse | null>(null);
  const [online, setOnline] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const [modal, setModal] = useState<'project' | 'run' | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<unknown>(null);
  const [runSetup, setRunSetup] = useState<TaskComposerContext | null>(null);
  const [check, setCheck] = useState('');
  const [checkError, setCheckError] = useState(false);
  const [reportError, setReportError] = useState('');
  const [reportRetry, setReportRetry] = useState(0);
  const [bootRetry, setBootRetry] = useState(0);
  const drafts = useRef(new Map<string, ConfigDraft>());
  const validationDrafts = useRef(new Map<string, ValidationEditorDraft>());
  const loading = useRef(false);
  const runReturnFocus = useRef<HTMLElement | null>(null);
  const notify = useCallback((text: string, bad = false) => setNotice({ text, bad }), []);
  const project = projects.find(p => p.project_id === projectId) ?? projects[0];
  const matchingResponse = response?.report.workflow.workflow_id === currentRoute.workflow ? response : null;
  const selected = workflows.find(w => w.workflow_id === currentRoute.workflow) ?? matchingResponse?.report.workflow;
  const visible = project ? workflows.filter(w => w.config_path === project.config_path || w.repository_root === project.repository_root) : workflows;
  const navigate = (page: string, workflow = '', status: WorkflowStatusFilter = 'all') => {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (page !== currentRoute.page) { params.delete('search'); params.delete('branch'); }
    for (const name of ['project', 'function', 'source_branch', 'machine', 'return']) params.delete(name);
    if (status === 'all') params.delete('status'); else params.set('status', status);
    location.hash = '/' + page + (workflow ? '/' + encodeURIComponent(workflow) : '') + (params.size ? '?' + params.toString() : '');
  };
  const openTaskPreparation = (context: TaskPreparationContext) => {
    const params = new URLSearchParams({ project: context.projectId, function: context.functionName, source_branch: context.sourceBranch,
      machine: context.machineId, return: context.returnTo });
    setModal(null); location.hash = '/tasks/prepare?' + params.toString();
  };
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const [p, w] = await Promise.all([api.listProjects(), api.listOptimizationWorkflows(200)]);
      setProjects(p.projects); setWorkflows(w.workflows); setActiveIds(w.active_workflow_ids ?? null); setOnline(true); setHasLoaded(true);
    } catch (e) { setOnline(false); if ((e as { status?: number }).status === 401) setAuthenticated(false); }
    finally { loading.current = false; }
  }, [notify]);
  useEffect(() => { const update = () => setRoute(route()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      const pendingConfig = [...drafts.current.values()].some(draft => JSON.stringify(draft.config) !== draft.saved
        || draft.args !== JSON.stringify(draft.config.build.args)
        || draft.section === 'advanced' && draft.advanced !== JSON.stringify(draft.config, null, 2));
      if (pendingConfig || validationDrafts.current.size) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  useEffect(() => { setNotice(null); }, [currentRoute.page, currentRoute.workflow]);
  useEffect(() => {
    const expired = () => setAuthenticated(false);
    window.addEventListener('corepilot-session-expired', expired);
    setOnline(true);
    request<{ authenticated: boolean }>('/v1/session').then(s => { setAuthenticated(s.authenticated); setOnline(true); }).catch(e => { setOnline(false); notify(e.message, true); });
    return () => window.removeEventListener('corepilot-session-expired', expired);
  }, [bootRetry]);
  useEffect(() => {
    if (!authenticated) return;
    void refresh();
    request<{ packages: CatalogItem[] }>('/v1/catalog').then(c => setCatalog(c.packages)).catch(e => notify(e.message, true));
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [authenticated, refresh]);
  useEffect(() => {
    setReportError('');
    if (!currentRoute.workflow || !authenticated) { setResponse(null); return; }
    let cancelled = false;
    void api.getOptimizationReport(currentRoute.workflow).then(data => { if (!cancelled) setResponse(data); }).catch(e => { if (!cancelled) { setReportError(e.message); if (e.status === 401) setAuthenticated(false); } });
    return () => { cancelled = true; };
  }, [currentRoute.workflow, workflows.find(w => w.workflow_id === currentRoute.workflow)?.updated_at, authenticated, reportRetry, online]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), notice.bad ? 12000 : 7000); return () => clearTimeout(timer); }, [notice]);
  async function login(e: React.FormEvent) { e.preventDefault(); setBusy(true); try { await request('/v1/session', 'POST', { token }); setToken(''); setAuthenticated(true); } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); } }
  async function startRun() {
    if (busy) return;
    runReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!project) { setModal('project'); return; }
    setCheck(''); setCheckError(false); setBusy(true);
    try {
      const [data, repository, latestCatalog, machines, setup] = await Promise.all([api.projectAction(project.project_id, 'config') as Promise<{ config: OptimizationConfig }>, api.inspectRepository(project.repository_root), request<{ packages: CatalogItem[] }>('/v1/catalog'), request<{ machines: ExecutionMachineSummary[] }>('/v1/machines'), request<ProjectSetup>(`/v1/projects/${project.project_id}/setup`)]);
      setCatalog(latestCatalog.packages);
      const p = latestCatalog.packages.find(p => p.package_id === data.config.validation.library_package?.package_id && p.version === data.config.validation.library_package?.package_version);
      const target = p?.targets.find(t => t.target_id === data.config.validation.library_package?.target_id);
      const validationFunctionName = setup.validation?.function_name ?? p?.functions.find(f => f.function_id === target?.function_id)?.api;
      const validationReady = !!data.config.validation.testpack.trim() && !!setup.validation
        || !!p && !!target && ['REVIEWED', 'QUALIFIED'].includes(p.qualification.state) && target.evaluator.qualification === 'QUALIFIED';
      const projectAssetPrefix = `/v1/projects/${encodeURIComponent(project.project_id)}/validation-assets/`;
      const hasUnsavedChanges = hasUnsavedProjectConfig() || [...validationDrafts.current.keys()].some(key => key.startsWith(projectAssetPrefix));
      setRunSetup({ config: data.config, repository, machines: machines.machines, functionName: project.default_function ?? validationFunctionName ?? '', validationFunctionName, validationReady, hasUnsavedChanges });
      setModal('run');
    } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  }
  function hasUnsavedProjectConfig() {
    const draft = project && drafts.current.get(project.project_id);
    return !!draft && (JSON.stringify(draft.config) !== draft.saved || draft.args !== JSON.stringify(draft.config.build.args)
      || draft.section === 'advanced' && draft.advanced !== JSON.stringify(draft.config, null, 2));
  }
  function contextSaved(result: SavedProjectContext) {
    if (!project) return;
    if (result.project) setProjects(current => current.map(item => item.project_id === project.project_id ? result.project! : item));
    const draft = drafts.current.get(project.project_id);
    if (draft && result.config && !hasUnsavedProjectConfig()) {
      const config = { ...draft.config, runner: result.config.runner };
      drafts.current.set(project.project_id, { ...draft, config, saved: JSON.stringify(config), advanced: JSON.stringify(config, null, 2) });
    }
    updateTaskDraftSelection(project.project_id, result.field === 'branch' ? { sourceBranch: result.value }
      : result.field === 'machine' ? { machineId: result.value } : { functionName: result.value });
    notify(({ branch: '默认分支已保存；已有任务不受影响。', machine: '默认执行机器已保存；已有任务不受影响。', function: '目标函数已保存；请确认测试方案与该函数匹配。' })[result.field]);
    void refresh();
  }
  async function logout() {
    const pendingConfig = [...drafts.current.values()].some(draft => JSON.stringify(draft.config) !== draft.saved
      || draft.args !== JSON.stringify(draft.config.build.args)
      || draft.section === 'advanced' && draft.advanced !== JSON.stringify(draft.config, null, 2));
    if ((pendingConfig || validationDrafts.current.size) && !window.confirm('还有未保存的项目配置或测试方案。退出后这些修改会丢失，确定退出吗？')) return;
    try {
      await request('/v1/session', 'DELETE');
      drafts.current.clear(); validationDrafts.current.clear(); setAuthenticated(false);
    } catch (error) { notify((error as Error).message, true); }
  }
  async function checkProject() {
    if (!project) return;
    setBusy(true); setCheck(''); setCheckError(false);
    try {
      const result = await api.projectAction(project.project_id, 'check', {}) as { message: string };
      setCheck(result.message);
    } catch (e) { setCheck((e as Error).message); setCheckError(true); } finally { setBusy(false); }
  }
  async function discover() { if (!project) return; setBusy(true); try { const result = await api.projectAction(project.project_id, 'discover', {}); setInspection(result); const c = await request<{ packages: CatalogItem[] }>('/v1/catalog'); setCatalog(c.packages); } catch (e) { notify((e as Error).message, true); } finally { setBusy(false); } }
  if (authenticated === null) return <div className="boot"><Brand /><p>{online ? '正在连接 CorePilot…' : '服务器连接失败，请确认服务已启动。'}</p>{!online && <button onClick={() => setBootRetry(n => n + 1)}>重新连接</button>}</div>;
  if (!authenticated) return <div className="login-page"><div className="login-story"><Brand /><span className="eyebrow">PERFORMANCE ENGINEERING</span><h1>把优化交给 Agent，<br />让真实硬件给出答案。</h1><p>从优化假设、候选实现，到测试、复验与报告。<br />每一步都有迹可循。</p><div className="login-orbit"><Icon name="code" size={34} /><span /><Icon name="server" size={34} /><span /><Icon name="chart" size={34} /></div></div><form className="login-card" onSubmit={e => void login(e)}><h2>欢迎回到 CorePilot</h2><p>登录你的性能工程工作台</p><Field label="管理员访问凭据"><input autoFocus type="password" required autoComplete="current-password" value={token} onChange={e => setToken(e.target.value)} placeholder="输入服务器配置的访问凭据" /></Field><button className="primary" disabled={busy}>{busy ? '连接中…' : '进入工作台'}<Icon name="arrow" size={16} /></button><small>CLI 使用同一服务器与访问凭据。</small>{notice && <p role="alert" className="error-text">{notice.text}</p>}</form></div>;
  const active = currentRoute.page === 'project-settings' ? 'settings' : currentRoute.page;
  const title = active === 'task-setup' || active === 'validation' ? '优化任务 / 构建与验证' : menus.find(m => m.id === active)?.title ?? '项目概览';
  return <div className="app-shell"><a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主内容</a><aside className="sidebar"><Brand /><div className="project-switcher"><label className="sr-only" htmlFor="project-select">当前项目</label><select id="project-select" value={project?.project_id ?? ''} onChange={e => { setProjectId(e.target.value); localStorage.setItem('corepilot-project', e.target.value); setResponse(null); navigate('overview'); }}><option value="" disabled>选择项目</option>{projects.map(p => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}</select><button className="icon-btn" aria-label="添加项目" title="添加项目" onClick={() => setModal('project')}><Icon name="plus" size={17} /></button></div><nav>{menus.map((m, i) => <React.Fragment key={m.id}>{[0, 2, 4, 5].includes(i) && <span className="nav-group-label">{i === 0 ? '工作区' : i === 2 ? '验证与结果' : i === 4 ? '项目设置' : '系统维护'}</span>}<button aria-current={active === m.id || active === 'task-setup' && m.id === 'tasks' ? 'page' : undefined} aria-label={m.title} title={m.title} className={active === m.id || active === 'task-setup' && m.id === 'tasks' ? 'active' : ''} onClick={() => navigate(m.id, ['analysis', 'reports'].includes(m.id) ? currentRoute.workflow : '')}><Icon name={m.icon} /><span>{m.title}</span></button></React.Fragment>)}</nav><div className="sidebar-bottom"><span className={`status-dot ${online ? '' : 'offline'}`} /><div><strong>{online ? '服务器在线' : '连接中断'}</strong><small>网页与 CLI 共用后端</small></div><button className="icon-btn" aria-label="退出登录" onClick={() => void logout()}><Icon name="logout" size={17} /></button></div></aside>
    <div className="app-content"><header className="topbar"><div><span>{project?.name ?? 'CorePilot'}</span><b>/</b>{title}{selected && <><b>/</b><span>{selected.function_name}</span></>}</div><div className="topbar-right"><span className="environment">自托管工作台</span><span className="avatar">CP</span></div></header>
      <main id="main-content" tabIndex={-1}>
        {!online && <div className="connection-banner" role="alert"><Icon name="server" size={18} /><span>与服务器的连接已中断，正在自动重连。下方保留上次同步的记录。</span><button onClick={() => void refresh()}>立即重连</button></div>}
        {!hasLoaded ? <div className="loading" role="status">{online ? '正在读取项目与任务…' : '未能读取工作台数据，请检查服务并重新连接。'}</div> : active === 'machines' ? <ExecutionMachines /> : ['settings', 'validation', 'task-setup'].includes(active) && !project ? <><PageHeading title="先添加一个源码项目" subtitle="模型、机器与验证方案按项目保存，可直接导入已有 CLI 配置。" /><Empty title={active === 'settings' ? '添加项目后即可配置模型与机器' : '添加项目后即可准备构建与验证'} description="选择服务器上的源码目录，然后配置模型、执行机器以及构建与验证方案。" action={<button className="primary" onClick={() => setModal('project')}><Icon name="plus" size={17} />添加项目</button>} /></> : active === 'settings' && project ? <><PageHeading title="模型与机器" subtitle="选择可替换的模型与已注册的执行机器。" /><Configuration key={`${project.project_id}-settings`} mode="settings" project={project} catalog={catalog} notify={notify} drafts={drafts.current} validationDrafts={validationDrafts.current} refresh={() => void refresh()} manageMachines={() => navigate('machines')} openValidation={() => openTaskPreparation({ projectId: project.project_id, functionName: project.default_function ?? '', sourceBranch: project.source_branch ?? '', machineId: '', returnTo: 'overview' })} /></> : active === 'task-setup' && project && currentRoute.preparation ? currentRoute.preparation.projectId && currentRoute.preparation.projectId !== project.project_id ? <Empty title="任务所属项目已改变" description="请回到项目概览，再继续准备该项目的优化任务。" action={<button onClick={() => navigate('overview')}>返回项目概览</button>} /> : <TaskPreparation key={`${project.project_id}:${currentRoute.preparation.functionName}`} project={project} context={currentRoute.preparation} catalog={catalog} drafts={drafts.current} validationDrafts={validationDrafts.current} notify={notify} refresh={() => void refresh()} manageMachines={() => navigate('machines')} returnToTask={() => { const returnTo = currentRoute.preparation?.returnTo; navigate('overview'); if (returnTo === 'task') void startRun(); }} /> : active === 'validation' && project ? <><PageHeading title="构建与验证" subtitle="为当前库准备构建命令、正确性测试、性能负载和比较基线。" /><Configuration key={`${project.project_id}-validation`} mode="validation" project={project} catalog={catalog} notify={notify} drafts={drafts.current} validationDrafts={validationDrafts.current} refresh={() => void refresh()} manageMachines={() => navigate('machines')} openValidation={() => navigate('validation')} /></> :
          currentRoute.workflow && !selected ? <Empty title={reportError ? '任务暂时无法打开' : '正在读取任务…'} description={reportError || '正在从服务器读取任务与实验记录。'} action={reportError ? <button onClick={() => setReportRetry(n => n + 1)}>重新读取任务</button> : undefined} /> :
          selected && currentRoute.workflow ? <>{reportError && <div className="report-retry"><Feedback text={`实验报告暂时无法读取：${reportError}`} bad /><button onClick={() => setReportRetry(n => n + 1)}>重新读取报告</button></div>}<Workbench key={selected.workflow_id} projectId={projects.find(item => item.config_path === selected.config_path)?.project_id} workflow={selected} response={matchingResponse} page={active} attached={activeIds === null ? undefined : activeIds.includes(selected.workflow_id)} notify={notify} refresh={() => void refresh()} navigatePage={page => navigate(page, selected.workflow_id, currentRoute.status)} backToList={() => navigate(active, '', currentRoute.status)} /></> :
          active === 'overview' ? project ? <ProjectOverview key={project.project_id} project={project} workflows={visible} activeIds={activeIds} navigate={navigate} create={() => void startRun()} check={() => void checkProject()} discover={() => void discover()} busy={busy} checkResult={check} checkError={checkError} catalog={catalog} hasUnsavedConfig={hasUnsavedProjectConfig} contextSaved={contextSaved} prepare={openTaskPreparation} /> : <Empty title="从一个项目开始" description="添加源码项目，选择模型和机器，再准备构建与测试方案。已有 CLI 配置可以直接复用。" action={<button className="primary" onClick={() => setModal('project')}><Icon name="plus" size={17} />添加第一个项目</button>} /> : <>
            <PageHeading title={title} subtitle={active === 'analysis' ? '按任务查看候选、正确性、性能和原始样本。' : active === 'reports' ? '打开任务报告，核对适用范围并下载 Markdown 或 JSON。' : '按状态、函数和分支筛选任务，查看每一步的真实记录。'} action={<button className="primary" onClick={() => void startRun()}><Icon name="plus" size={17} />创建优化任务</button>} />
            {active === 'analysis' && <div className="metrics section-metrics"><Metric title="已有首轮实验" value={visible.filter(w => !!w.experiment_id).length} /><Metric title="已有独立复验" value={visible.filter(w => !!w.revalidation_experiment_id).length} /><Metric title="验证受阻" value={visible.filter(w => w.status === 'VALIDATION_BLOCKED').length} /></div>}
            {active === 'reports' && <div className="metrics section-metrics"><Metric title="可查看任务报告" value={visible.length} /><Metric title="已生成报告文件" value={visible.filter(w => !!w.report_files).length} /><Metric title="待人工审阅" value={visible.filter(w => w.status === 'WAITING_APPROVAL').length} /></div>}
            <WorkflowList key={project?.project_id + active} workflows={visible} mode={active === 'analysis' ? 'analysis' : active === 'reports' ? 'reports' : 'tasks'} status={currentRoute.status} activeIds={activeIds} onStatusChange={status => navigate(active, '', status)} open={id => { setResponse(null); navigate(active, id, currentRoute.status); }} />
          </>}
      </main><footer>CorePilot · 真实硬件，可信结果。<span>{online ? '自动同步中' : '等待重新连接'}</span></footer>
    </div>
    {notice && <div className={`toast ${notice.bad ? 'bad' : ''}`} role="status"><Icon name={notice.bad ? 'report' : 'check'} size={18} /><span>{notice.text}</span><button aria-label="关闭提示" className="icon-btn" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></div>}
    {modal === 'project' && <AddProject projects={projects} close={() => setModal(null)} added={p => { setProjects(ps => [...ps.filter(x => x.project_id !== p.project_id), p]); setProjectId(p.project_id); localStorage.setItem('corepilot-project', p.project_id); setModal(null); navigate('overview'); notify('项目已添加。首页将引导你配置模型与机器，再准备测试方案。'); void refresh(); }} />}
    {modal === 'run' && runSetup && project && <TaskComposer project={project} context={runSetup} returnFocus={runReturnFocus.current} close={() => setModal(null)} configure={(page, preparation) => { if (page === 'validation') openTaskPreparation(preparation); else { setModal(null); navigate(page); } }} created={id => { setModal(null); setResponse(null); void refresh(); navigate('tasks', id); notify('优化任务已提交，关闭页面后后台继续执行。'); }} />}
    {inspection !== null && <Modal title="源码接入调查 · Draft" wide onClose={() => setInspection(null)}><p className="hint">只读调查结果。草稿仍需人工审阅和目标验证，不能作为已 Qualified 的正式 evaluator。</p><pre className="detail-code">{JSON.stringify(inspection, null, 2)}</pre></Modal>}
  </div>;
}

function PageHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
