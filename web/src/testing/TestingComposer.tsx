import React, { useEffect, useRef, useState } from 'react';
import type { ProjectRecord } from '../../../src/contracts/project';
import type { ExecutionMachineSummary } from '../../../src/contracts/execution-machine';
import type { TestingAsset, TestingMode, TestingPlanPreview, TestingPlanRef } from '../../../src/contracts/testing';
import type { CatalogItem } from '../Configuration';
import type { CandidateTestingContext } from '../SourceOptimizationWorkbench';
import { api } from '../api';
import { Disclosure, Feedback, Field, Icon, Modal } from '../components';
import { TestingSubjectPicker } from './TestingSubjectPicker';
import { TestingAssetUpload } from './TestingAssetUpload';
import { TestingConditions } from './TestingConditions';
import { emptySubject, testingSubject, type SubjectDraft } from './testing-draft';
import { newRequestId } from '../request-id';

interface TestingDraft { name: string; machineId: string; planKey: string; mode: TestingMode; correctnessBaseline: boolean; candidate: SubjectDraft; baseline: SubjectDraft }
const planKey = (ref: TestingPlanRef) => JSON.stringify(ref);

export function TestingComposer({ projects, catalog, machines, assets, projectId = '', candidateContext, close, created, assetAdded, prepare }: {
  projects: ProjectRecord[]; catalog: CatalogItem[]; machines: ExecutionMachineSummary[]; assets: TestingAsset[]; projectId?: string;
  candidateContext?: CandidateTestingContext; close: () => void; created: (id: string) => void;
  assetAdded: (asset: TestingAsset) => void; prepare: (projectId: string, functionName: string) => void;
}) {
  const storageKey = 'corepilot-testing-draft:' + ((candidateContext?.commit ?? projectId) || 'standalone');
  const [form, setForm] = useState<TestingDraft>(() => {
    const defaults: TestingDraft = { name: '', machineId: '', planKey: '', mode: 'both', correctnessBaseline: false, candidate: emptySubject(projectId), baseline: emptySubject() };
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
      if (saved?.version === 1 && saved.form) Object.assign(defaults, saved.form);
    } catch { /* Optional browser draft. */ }
    if (candidateContext) defaults.candidate = { ...defaults.candidate, kind: 'source', projectId: candidateContext.projectId, branch: candidateContext.branch, commit: candidateContext.commit };
    return defaults;
  });
  const [plan, setPlan] = useState<TestingPlanPreview | null>(null);
  const [planError, setPlanError] = useState('');
  const [planRetry, setPlanRetry] = useState(0);
  const [uploadFor, setUploadFor] = useState<'candidate' | 'baseline' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  const formId = React.useId();
  const options = catalog.flatMap(item => item.targets.map(target => ({ ref: { package_id: item.package_id, package_version: item.version, target_id: target.target_id },
    label: `${item.functions.find(fn => fn.function_id === target.function_id)?.api ?? target.function_id} · ${item.library_name ?? item.package_id} · ${item.version}` })));
  const machine = machines.find(item => item.machine_id === form.machineId);
  const compare = form.mode !== 'correctness' || form.correctnessBaseline;
  const missingCode = !!plan && (!plan.code.setup || form.mode !== 'performance' && !plan.code.correctness || form.mode !== 'correctness' && !plan.code.performance);
  const planProject = projects.find(item => plan?.ref.package_id === 'project-' + item.project_id.slice(0, 8)) ?? projects.find(item => item.project_id === form.candidate.projectId);
  function change(patch: Partial<TestingDraft>) { setForm(current => ({ ...current, ...patch })); setError(''); requestId.current = null; }
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 1, form })); } catch { /* Optional browser draft. */ } }, [storageKey, form]);
  useEffect(() => {
    let active = true; setPlan(null); setPlanError('');
    if (form.planKey) api.testing.preview(JSON.parse(form.planKey) as TestingPlanRef).then(result => { if (active) setPlan(result.plan); }).catch(failure => { if (active) setPlanError(failure.message); });
    return () => { active = false; };
  }, [form.planKey, planRetry]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      if (!plan || missingCode) throw new Error('请选择已有可执行测试方案，或先准备对应测试代码。');
      requestId.current ??= newRequestId();
      const result = await api.testing.start({ name: form.name.trim() || `${plan.function_name} 测试`, machine_id: form.machineId, plan: plan.ref,
        expected_evaluator_digest: plan.evaluator.digest, expected_package_digest: plan.package_digest,
        candidate: testingSubject(form.candidate), ...(compare ? { baseline: testingSubject(form.baseline) } : {}), mode: form.mode }, requestId.current);
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional browser draft. */ }
      created(result.task.task_id);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <Modal title="创建测试任务" wide className="testing-dialog" onClose={() => { if (!busy) close(); }} footer={<div className="composer-actions"><span className="hint">{form.mode === 'correctness' ? '不测性能' : '在同一机器比较两个固定版本'} · 不修改源码</span><button className="primary" type="submit" form={formId} disabled={busy || !plan || missingCode || !machine}>{busy ? '正在提交…' : '开始测试'}<Icon name="arrow" size={15} /></button></div>}>
      <form id={formId} onSubmit={event => void submit(event)}>
        <fieldset disabled={busy} className="config-fields">
          <div className="field-grid"><Field label="测试内容"><select value={form.mode} onChange={event => change({ mode: event.target.value as TestingMode })}><option value="both">正确性与性能</option><option value="correctness">仅正确性</option><option value="performance">仅性能</option></select></Field>
            <Field label="执行机器"><select required value={form.machineId} onChange={event => change({ machineId: event.target.value })}><option value="" disabled>选择执行机器</option>{machines.map(item => <option value={item.machine_id} key={item.machine_id} disabled={!item.enabled}>{item.name} · {item.status === 'ONLINE' ? '在线' : item.status === 'OFFLINE' ? '离线' : '状态待检测'}</option>)}</select></Field></div>
          {!machines.length && <p className="hint">还没有执行机器。<a href="#/machines">先注册执行机器</a>，返回后会保留本次配置。</p>}
          {form.mode === 'correctness' && <label className="checkbox"><input type="checkbox" checked={form.correctnessBaseline} onChange={event => change({ correctnessBaseline: event.target.checked })} />向正确性脚本提供比较库</label>}
          {form.mode === 'correctness' && form.correctnessBaseline && <p className="hint">比较库的参考用途与通过标准由测试方案声明，此选择不会自动将它认定为可信参考。</p>}
          <div className="testing-subjects">
            <TestingSubjectPicker title={form.mode === 'correctness' ? '待测对象' : '待测对象 B'} value={form.candidate} change={candidate => change({ candidate })} projects={projects} assets={assets} plan={plan} upload={() => setUploadFor('candidate')} />
            {compare && <TestingSubjectPicker title="比较对象 A" value={form.baseline} change={baseline => change({ baseline })} projects={projects} assets={assets} plan={plan} upload={() => setUploadFor('baseline')} />}
          </div>
          <Field label="测试方案" help="复用正确性与负载规则；提交时固定本次版本。"><select required value={form.planKey} onChange={event => change({ planKey: event.target.value })}><option value="" disabled>选择适用于这两个对象的函数测试方案</option>{options.map(item => <option key={planKey(item.ref)} value={planKey(item.ref)}>{item.label}</option>)}</select></Field>
          {!options.length && <div className="notice compact">还没有可复用的测试方案。{projects.length ? <button type="button" className="text-btn" onClick={() => prepare(form.candidate.projectId || projectId || projects[0].project_id, candidateContext?.functionName ?? '')}>准备测试代码与条件</button> : '请先导入库接入方案，再创建测试任务。'}</div>}
          {form.planKey && !plan && !planError && <p role="status" className="hint">正在读取测试条件…</p>}
          {planError && <><Feedback text={planError} bad /><button type="button" onClick={() => setPlanRetry(value => value + 1)}>重新读取测试方案</button></>}
          {missingCode && <div className="notice compact"><strong>测试代码尚未准备好</strong><p>{plan?.code.issues.join('；')}</p>{planProject && <button className="text-btn" type="button" onClick={() => prepare(planProject.project_id, plan?.function_name ?? '')}>用 AI 起草或上传测试脚本</button>}</div>}
          {plan && <TestingConditions plan={plan} mode={form.mode} />}
          {form.mode === 'performance' && <div className="notice compact">本次只测量性能，不建立正确性结论。比较对象 A 不自动作为正确性参考。</div>}
          {machine && machine.status !== 'ONLINE' && <p className="hint">所选机器最近未确认在线，提交时会检测连接。</p>}
          <Disclosure title="任务名称" summary={form.name || '根据函数命名'} modified={!!form.name}><Field label="测试任务名称"><input maxLength={160} value={form.name} onChange={event => change({ name: event.target.value })} placeholder="例如：新旧版本 · 8 线程对比" /></Field></Disclosure>
        </fieldset>
        {error && <Feedback text={error} bad />}
      </form>
    </Modal>
    {uploadFor && <TestingAssetUpload close={() => setUploadFor(null)} added={asset => { assetAdded(asset); change({ [uploadFor]: { ...form[uploadFor], kind: 'binary', assetId: asset.asset_id } }); setUploadFor(null); }} />}
  </>;
}
