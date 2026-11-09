import React, { useEffect, useState } from 'react';
import type { ProjectRecord, RepositoryInspection } from '../../src/contracts/project';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ExecutionMachineSummary } from '../../src/contracts/execution-machine';
import type { ValidationAssetDraft } from '../../src/contracts/validation-assets';
import { isRegisteredRunner } from '../../src/config/runner-config';
import { api, request } from './api';
import { CopyValue, Disclosure, Feedback, Field, Icon, Modal } from './components';
import { SourceBranchSelect } from './SourceProject';
import { TaskTestReview, VerificationChoice, type VerificationMode } from './TaskVerification';
import { SourceScopeField, sourceScopeFromText } from './SourceScopeField';
import { newRequestId } from './request-id';
import { forgetOptimizationRequest, pendingOptimizationRequests, rememberOptimizationRequest } from './optimizationIntake';

export interface TaskComposerContext { config: OptimizationConfig; repository: RepositoryInspection; machines: ExecutionMachineSummary[]; functionName: string; validationFunctionName?: string; validationReady: boolean; validationBlocker?: string; validationWasQualified?: boolean; hasUnsavedChanges?: boolean; selection?: { functionName: string; sourceBranch: string } }
export interface TaskPreparationContext { projectId: string; functionName: string; sourceBranch: string; machineId: string; returnTo: 'task' | 'overview' | 'testing'; returnPath?: string }
interface TaskDraft { functionName: string; sourceBranch: string; machineId: string; minutes: number; candidates: number; entryFile: string; sourceInclude: string; sourceExclude: string; performance: boolean; verificationMode: VerificationMode }

/** An overview change updates only that field in an existing task draft. */
export function updateTaskDraftSelection(projectId: string, patch: Partial<Pick<TaskDraft, 'functionName' | 'sourceBranch' | 'machineId'>>) {
  const key = 'corepilot-task-draft:' + projectId;
  try {
    // Keep the submitted draft intact until its request is reconciled.
    if (pendingOptimizationRequests(projectId).length) return;
    const draft = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (draft?.version === 1 && draft.form && typeof draft.form === 'object') sessionStorage.setItem(key, JSON.stringify({ ...draft, form: { ...draft.form, ...patch } }));
  } catch { /* The saved project default remains authoritative when browser storage is unavailable. */ }
}

export function TaskComposer({ project, context, close, created, configure, returnFocus }: {
  project: ProjectRecord; context: TaskComposerContext; close: () => void; created: (id: string, recovered?: boolean) => void; configure: (page: string, preparation: TaskPreparationContext) => void; returnFocus?: HTMLElement | null;
}) {
  const storageKey = 'corepilot-task-draft:' + project.project_id;
  const formId = React.useId();
  const readPending = () => {
    try { return { ids: pendingOptimizationRequests(project.project_id), error: '' }; }
    catch { return { ids: [] as ReturnType<typeof pendingOptimizationRequests>, error: '无法读取浏览器本地存储。请启用本地存储后重新打开，以便安全核对任务请求。' }; }
  };
  const [pending, setPending] = useState(readPending);
  const [form, setForm] = useState<TaskDraft>(() => {
    const defaults: TaskDraft = { functionName: context.functionName, sourceBranch: project.source_branch ?? context.repository.current_branch ?? context.repository.branches[0]?.name ?? '',
      machineId: isRegisteredRunner(context.config.runner) ? context.config.runner.machine_id : '', minutes: 60, candidates: 8, entryFile: '', sourceInclude: '', sourceExclude: '', performance: true,
      verificationMode: context.validationReady || context.validationWasQualified && context.validationBlocker ? 'verified' : 'source_only' };
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (!saved || saved.version !== 1) return { ...defaults, ...(pending.ids.length || pending.error ? {} : context.selection) };
      const draft = saved.form;
      return { ...defaults, ...Object.fromEntries(Object.entries(defaults).filter(([key, value]) => typeof draft?.[key] === typeof value).map(([key]) => [key, draft[key]])), ...(pending.ids.length || pending.error ? {} : context.selection) };
    } catch { return defaults; }
  });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [intakeMessage, setIntakeMessage] = useState('');
  const [check, setCheck] = useState('');
  const [plan, setPlan] = useState<ValidationAssetDraft | null>(null);
  const [planError, setPlanError] = useState('');
  const [planRetry, setPlanRetry] = useState(0);
  const awaitingIntake = !!pending.error || pending.ids.length > 0;
  const selection = context.config.validation.library_package;
  const owned = selection?.package_id === 'project-' + project.project_id.slice(0, 8);
  const machine = context.machines.find(item => item.machine_id === form.machineId);
  const mismatchedFunction = !!form.functionName.trim() && !!context.validationFunctionName && form.functionName.trim() !== context.validationFunctionName;
  const sourceOnly = form.verificationMode === 'source_only';
  const needsValidation = !sourceOnly && (!context.validationReady || mismatchedFunction);
  const preparation = (): TaskPreparationContext => ({ projectId: project.project_id, functionName: form.functionName.trim(),
    sourceBranch: form.sourceBranch, machineId: form.machineId, returnTo: 'task' });
  const advancedModified = form.minutes !== 60 || !!form.entryFile || !sourceOnly && (form.candidates !== 8 || !form.performance);
  useEffect(() => { if (!awaitingIntake) try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, form })); } catch { /* Storage can be disabled by the browser. */ } }, [form, storageKey, awaitingIntake]);
  useEffect(() => {
    const refresh = () => setPending(readPending());
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, [project.project_id]);
  useEffect(() => {
    if (sourceOnly || !owned || !selection) return;
    let active = true; setPlan(null); setPlanError('');
    request<ValidationAssetDraft>('/v1/projects/' + project.project_id + '/validation-assets/' + encodeURIComponent(selection.package_id) + '/' + encodeURIComponent(selection.package_version) + '/' + encodeURIComponent(selection.target_id))
      .then(value => { if (active) setPlan(value); }).catch(failure => { if (active) setPlanError(failure.message); });
    return () => { active = false; };
  }, [project.project_id, selection?.package_id, selection?.package_version, selection?.target_id, planRetry, sourceOnly]);
  function change(patch: Partial<TaskDraft>) { setForm(current => ({ ...current, ...patch })); setError(''); setCheck(''); setIntakeMessage(''); }
  async function submit(event: React.FormEvent) {
    if (needsValidation) { event.preventDefault(); setError(context.validationBlocker ?? '请先为所选函数准备并确认匹配的测试方案。'); return; }
    event.preventDefault();
    const current = readPending();
    if (current.error || current.ids.length) { setPending(current); return; }
    setBusy('submit'); setError(''); setIntakeMessage('');
    let requestId: string | undefined;
    try {
      const payload = { project_id: project.project_id, function_name: form.functionName.trim() || undefined,
        source_branch: form.sourceBranch || undefined, ...(form.machineId ? { machine_id: form.machineId } : {}),
        entry_file: form.entryFile.trim() || null, verification_mode: form.verificationMode, enable_performance: !sourceOnly && form.performance,
        ...(sourceOnly ? { candidate_scope: sourceScopeFromText(form.sourceInclude, form.sourceExclude) } : {}),
        budget: { time_limit_ms: form.minutes * 60_000, max_candidates: sourceOnly ? 1 : form.candidates } };
      try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, form })); }
      catch { throw new Error('无法保存本次表单，请启用浏览器会话存储后重试。'); }
      let identity: Awaited<ReturnType<typeof api.getControlIdentity>>;
      try { identity = await api.getControlIdentity(); }
      catch (failure) { throw new Error('无法核对控制端身份，请检查服务版本和数据目录。' + (failure as Error).message); }
      requestId = newRequestId();
      try { rememberOptimizationRequest(project.project_id, requestId, identity); }
      catch { throw new Error('无法保存任务请求标识，请启用浏览器本地存储后重试。'); }
      setPending(readPending());
      const result = await api.submitOptimizationWorkflow(payload, { requestId, controlIdentity: identity }) as { workflow_id: string };
      try { forgetOptimizationRequest(project.project_id, requestId); } catch { /* A later check can still recover the created task. */ }
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional local draft. */ }
      created(result.workflow_id);
    } catch (failure) {
      const currentPending = readPending();
      setPending(currentPending);
      setError(requestId && (currentPending.error || currentPending.ids.some(item => item.requestId === requestId))
        ? '任务提交结果尚未确认。请先查询原任务，或关闭未创建的请求后再修改。' + (failure as Error).message : (failure as Error).message);
    } finally { setBusy(''); }
  }

  async function resolveIntake(action: 'check' | 'close') {
    const saved = pending.ids[0];
    if (!saved?.identity) return;
    const { requestId, identity } = saved;
    setBusy(action); setError(''); setIntakeMessage('');
    try {
      const result = action === 'check' ? await api.getOptimizationIntake(requestId, identity) : await api.closeOptimizationIntake(requestId, identity);
      if (result.status === 'NOT_FOUND') {
        setIntakeMessage('暂未查到任务，原请求仍可能到达。请再次查询，或关闭未创建的请求后再修改。');
        return;
      }
      if (result.status === 'CREATED') {
        try { forgetOptimizationRequest(project.project_id, requestId); } catch { /* The task can still be opened with its returned identity. */ }
        created(result.workflow_id, true); return;
      }
      forgetOptimizationRequest(project.project_id, requestId);
      setPending(readPending());
      setIntakeMessage('该请求已关闭且没有创建任务。现在可以修改后重新提交。');
    } catch (failure) { setError('暂时无法确认原请求，请稍后重试。' + (failure as Error).message); }
    finally { setBusy(''); }
  }
  async function preflight() {
    setBusy('check'); setError(''); setCheck('');
    try {
      const result = await api.projectAction(project.project_id, 'check', { function_name: form.functionName.trim() || undefined,
        source_branch: form.sourceBranch || undefined, machine_id: form.machineId || undefined, verification_mode: form.verificationMode,
        ...(sourceOnly ? { candidate_scope: sourceScopeFromText(form.sourceInclude, form.sourceExclude) } : {}) }) as { message: string };
      setCheck(result.message);
    } catch (failure) {
      const message = (failure as Error).message;
      setError(mismatchedFunction && message.includes('differs from testpack function')
        ? `所选函数 ${form.functionName.trim()} 与当前测试方案 ${context.validationFunctionName} 不匹配，请先配置对应的测试方案。` : message);
    } finally { setBusy(''); }
  }
  return <Modal title="创建优化任务" returnFocus={returnFocus} onClose={() => { if (busy !== 'submit') close(); }} wide className="task-dialog" footer={<div className="composer-actions"><span className="hint">预算：{form.minutes} 分钟 · {sourceOnly ? '生成一个候选' : form.candidates + ' 个候选'}</span><div className="actions"><button type="button" disabled={!!busy || awaitingIntake} onClick={() => void preflight()}>{busy === 'check' ? '正在检查…' : '运行前检查'}</button><button className="primary" type="submit" form={formId} disabled={!!busy || awaitingIntake || needsValidation || !sourceOnly && (!!form.machineId && !machine || owned && !plan)}>{busy === 'submit' ? '正在提交…' : '开始优化'}<Icon name="arrow" size={15} /></button></div></div>}>
    <form id={formId} className="task-composer" onSubmit={event => void submit(event)}>
      <p className="composer-intro">项目 <strong>{project.name}</strong> · 以下选择仅用于本次任务。</p>
      {context.hasUnsavedChanges && <div className="notice compact" role="status">该项目还有未保存的配置或测试修改。本次任务使用服务器上已保存的版本；需要使用这些修改时，请先返回相应页面保存。 <button type="button" className="text-btn" disabled={awaitingIntake} onClick={() => configure('validation', preparation())}>返回构建与验证</button></div>}
      {pending.error && <Feedback text={pending.error} bad />}
      {pending.ids.length > 0 && <section className="notice compact" aria-label="待核对的任务请求">
        <strong>上次任务请求需要核对{pending.ids.length > 1 ? `（还有 ${pending.ids.length} 项）` : ''}</strong>
        {pending.ids[0].identity ? <><p>连接中断或页面关闭时，任务可能已经创建。请先查询；关闭只作用于尚未创建的请求，不会停止已有任务。其他标签页可能无法恢复原表单，请以查到的任务详情为准。</p>
          <div className="actions"><button type="button" disabled={!!busy} onClick={() => void resolveIntake('check')}>查询原任务</button><button type="button" disabled={!!busy} onClick={() => void resolveIntake('close')}>关闭未创建的请求</button></div></>
          : <><p>此请求没有记录原控制端身份，无法安全判断是否已创建。请维护者核对原控制端数据库、数据目录及任务；系统不会自动查询、关闭或清除此请求。</p>
            <p>请求标识：<CopyValue value={pending.ids[0].requestId} label="请求标识" /></p></>}
      </section>}
      {intakeMessage && <p role="status">{intakeMessage}</p>}
      <fieldset disabled={!!busy || awaitingIntake} className="config-fields">
        <VerificationChoice value={form.verificationMode} onChange={verificationMode => change({ verificationMode })} />
        <div className="composer-fields">
          <Field label="优化函数"><input required autoFocus value={form.functionName} onChange={event => change({ functionName: event.target.value })} placeholder="输入目标函数名" /></Field>
          <Field label="执行机器" help={sourceOnly ? '可选：提供目标硬件背景，本次不启动硬件测试。' : undefined}><select required={!sourceOnly && context.machines.length > 0} value={form.machineId} onChange={event => change({ machineId: event.target.value })}>
            <option value="" disabled={!sourceOnly && context.machines.length > 0}>{sourceOnly ? '沿用项目硬件背景' : context.machines.length ? '选择已注册机器' : '沿用项目的现有执行配置'}</option>
            {form.machineId && !machine && <option value={form.machineId} disabled>原执行机器不可用，请重新选择</option>}
            {context.machines.map(item => <option key={item.machine_id} value={item.machine_id} disabled={!item.enabled}>{item.name} · {item.status === 'ONLINE' ? '在线' : item.status === 'OFFLINE' ? '离线' : '状态待检测'}{item.hardware ? ' · ' + item.hardware.architecture + ' / ' + item.hardware.cpu_count + ' CPU' : ''}</option>)}
          </select></Field>
        </div>
        {needsValidation && <div className="notice compact" role="status">{mismatchedFunction ? `当前测试方案用于 ${context.validationFunctionName}，与所选函数 ${form.functionName.trim()} 不同。请为目标函数准备匹配的测试方案。` : context.validationBlocker ?? '当前测试方案尚未准备完成或未获资格。请为目标函数准备匹配的测试方案。'} <button type="button" className="text-btn" onClick={() => configure('validation', preparation())}>准备构建与验证</button></div>}
        <SourceBranchSelect repository={context.repository} value={form.sourceBranch} compact onChange={sourceBranch => change({ sourceBranch })} />
        {sourceOnly && <SourceScopeField include={form.sourceInclude} exclude={form.sourceExclude} onChange={value => change({ ...(value.include === undefined ? {} : { sourceInclude: value.include }), ...(value.exclude === undefined ? {} : { sourceExclude: value.exclude }) })} />}
        {!sourceOnly && machine && machine.status !== 'ONLINE' && <p className="notice compact">所选机器最近未确认在线。运行前检查会检测本次所选机器，不会创建实验。</p>}
        <dl className="review-facts"><div><dt>模型</dt><dd>{context.config.model.model_id || '尚未配置'}</dd></div></dl>
        {sourceOnly ? <div className="notice compact" role="status"><strong>本次产出：待验证的源码候选</strong><p>正确性未验证 · 性能未测量。可查看和下载补丁，之后创建测试任务。</p></div>
          : <TaskTestReview plan={plan} error={planError} retry={() => setPlanRetry(value => value + 1)} mismatched={mismatchedFunction} owned={owned}
            baseline={context.config.validation.baseline_artifact} hasSelection={!!selection} hasTestpack={!!context.config.validation.testpack.trim()}
            ready={!needsValidation} performance={form.performance} prepare={() => configure('validation', preparation())} />}
        <Disclosure title="高级设置" summary={advancedModified ? form.minutes + ' 分钟' + (!sourceOnly ? ' · ' + form.candidates + ' 个候选' : '') + (form.entryFile ? ' · 已指定调查文件' : '') + (!sourceOnly && !form.performance ? ' · 仅正确性' : '') : '预算与调查范围'} modified={advancedModified}>
          <div className="field-grid"><Field label="运行时间（分钟）"><input type="number" min={1} max={1440} required value={form.minutes} onChange={event => change({ minutes: Number(event.target.value) })} /></Field>{!sourceOnly && <Field label="最多评估候选数"><input type="number" min={1} max={1000} required value={form.candidates} onChange={event => change({ candidates: Number(event.target.value) })} /></Field>}</div>
          {sourceOnly && <p className="hint">每次生成一个完整候选，之后可继续原会话改进或单独测试。</p>}
          <Field label="优先调查文件（可选）" help="指定调查入口，不扩大允许修改的源码范围。"><input value={form.entryFile} onChange={event => change({ entryFile: event.target.value })} placeholder="src/kernel.c" /></Field>
          {!sourceOnly && <label className="checkbox"><input type="checkbox" checked={form.performance} onChange={event => change({ performance: event.target.checked })} />执行性能优化与复验</label>}
          <p className="hint">预算用尽会保留现场，可在任务详情增加预算并继续。</p>
        </Disclosure>
        <Disclosure title="项目与测试方案标识" summary="源码路径、配置与接入版本"><dl className="definition"><dt>源码目录</dt><dd><CopyValue value={project.repository_root} label="源码目录" /></dd><dt>配置文件</dt><dd><CopyValue value={project.config_path} label="配置路径" /></dd>{selection && <><dt>接入方案</dt><dd><CopyValue value={selection.package_id + '@' + selection.package_version + ' / ' + selection.target_id} label="接入方案" /></dd></>}</dl></Disclosure>
      </fieldset>
      {error && <><Feedback text={error} bad />{!awaitingIntake && <div className="run-next-steps"><button type="button" className="text-btn" disabled={!!busy} onClick={() => configure('validation', preparation())}>准备构建与验证<Icon name="arrow" size={14} /></button><button type="button" className="text-btn" disabled={!!busy} onClick={() => configure('settings', preparation())}>前往模型与机器<Icon name="arrow" size={14} /></button></div>}</>}
      {check && <div className="preflight-result"><Feedback text="运行前检查通过。尚未启动构建或实验。" /><Disclosure title="查看检查详情"><pre className="check-output">{check}</pre></Disclosure></div>}
    </form>
  </Modal>;
}
