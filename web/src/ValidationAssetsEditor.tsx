import React, { useEffect, useRef, useState } from 'react';
import type { ValidationAssetDraft, ValidationAssetEdit, ValidationGenerationScope, ValidationGenerationRecord, ValidationPreparationContext, ValidationSourceFile, ValidationCorrectnessInput, ValidationPerformanceInput } from '../../src/contracts/validation-assets';
import type { FormalWorkloadDefinition } from '../../src/contracts/formal-evaluator';
import { downloadProjectTestPackage, request } from './api';
import { Feedback, Field, Modal, Disclosure, CopyValue, label } from './components';
import { TestConditionsSummary } from './TestConditionsSummary';
import { ValidationInventoryEditor, type ValidationInventoryScratch } from './ValidationInventoryEditor';
import { ValidationPlanEditor } from './ValidationPlanEditor';
import { CorrectnessPlanReview } from './CorrectnessPlanReview';
import { ValidationTestCode, testProgramFile } from './ValidationTestCode';
import { ValidationTrialProgress, TRIAL_TERMINAL_STATUSES, type TrialProgressState, type TrialSubmission } from './ValidationTrialProgress';
import { ValidationReviewPanel } from './ValidationReviewPanel';
import { ValidationQualityEditor, ValidationQualitySummary } from './ValidationQualityEditor';
import { useTrialRequest } from './useTrialRequest';
import { TrialRequestRecovery } from './TrialRequestRecovery';
import type { ValidationQualityResult } from '../../src/contracts/validation-quality';
import type { PerformanceCalibration } from '../../src/contracts/performance-statistics';
import { parseValidationInputs } from '../../src/evaluator/validation-inputs';

type Editable = ValidationAssetEdit & Pick<ValidationAssetDraft, 'test_plan' | 'setup_script' | 'supporting_files'>;
type GenerationPrompts = { correctness: string; performance: string };
type EditorScratch = { cases?: ValidationInventoryScratch; workloads?: ValidationInventoryScratch; threadInput?: string };
const hasScratch = (scratch: EditorScratch) => scratch.threadInput !== undefined
  || [scratch.cases, scratch.workloads].some(item => !!item?.parameter || !!item?.parameterType && item.parameterType !== 'number' || item?.advanced !== undefined);
export interface ValidationEditorDraft {
  form: Editable;
  formDirty: boolean;
  prompts: GenerationPrompts;
  scratch: EditorScratch;
  owner: symbol;
}
interface TrialResult extends TrialProgressState {
  trial: TrialProgressState['trial'] & { evaluator_digest: string; test_plan?: ValidationAssetDraft['test_plan']; mode?: string };
  status: TrialProgressState['status'] & { failure?: { message: string } | null };
  commands: Array<{ step: string; command: string; args: string[]; exit_code: number | null; stdout: string; stderr: string; resource_context?: unknown }>;
  measurements?: Array<{ kind: string }>;
  summary: { quality?: ValidationQualityResult; calibration?: PerformanceCalibration; correctness: { planned: number; passed: number; failed: number; missing: string[] };
    performance: { planned: number; measured: number; missing: string[] };
    issues?: string[];
    comparisons?: Array<{ workload_id: string; input_id?: string; profile_name?: string; threads?: number; cpu_set?: string; numa_node?: number; omp_proc_bind?: string; baseline_median: number | null; candidate_median: number | null; speedup: number | null; baseline_samples: number[]; candidate_samples: number[] }> };
  passed: boolean;
}
const formOf = (draft: ValidationAssetDraft): Editable => ({ ...draft, expected_digest: draft.evaluator_digest, source: draft.source === 'placeholder' ? 'edited' : draft.source });
function download(body: BlobPart, filename: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ValidationAssetsEditor({ projectId, packageId, version, targetId, contextKey = '', onPrepare, reviewRequest = 0, onReviewed, validationDrafts }: {
  projectId: string; packageId: string; version: string; targetId: string; contextKey?: string; onPrepare?: () => Promise<unknown>; reviewRequest?: number; onReviewed?: () => Promise<void>;
  validationDrafts?: Map<string, ValidationEditorDraft>;
}) {
  const action = `validation-assets/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/${encodeURIComponent(targetId)}`;
  const url = `/v1/projects/${encodeURIComponent(projectId)}/${action}`;
  const [draft, setDraft] = useState<ValidationAssetDraft | null>(null);
  const [form, setForm] = useState<Editable | null>(null);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [context, setContext] = useState<ValidationPreparationContext | null>(null);
  const [working, setWorking] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [step, setStep] = useState<'conditions' | 'code' | 'run'>('conditions');
  const [trialId, setTrialId] = useState('');
  const [trial, setTrial] = useState<TrialResult | null>(null);
  const [trialRefresh, setTrialRefresh] = useState(0);
  const [trialSubmission, setTrialSubmission] = useState<TrialSubmission | null>(null);
  const trialRequest = useTrialRequest(projectId, packageId, version, targetId, 'VALIDATION_DRAFT');
  const [showFiles, setShowFiles] = useState(false);
  const [expandedCode, setExpandedCode] = useState<'correctness' | 'performance' | null>(null);
  const [trialFiles, setTrialFiles] = useState<ValidationSourceFile[] | null>(null);
  const [generation, setGeneration] = useState<ValidationGenerationRecord | null>(null);
  const [generationId, setGenerationId] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [generationPrompts, setGenerationPrompts] = useState<GenerationPrompts>({ correctness: '', performance: '' });
  const [scratch, setScratch] = useState<EditorScratch>({});
  const revision = useRef(0), generationRevision = useRef<number | null>(null), appliedGeneration = useRef('');
  const owner = useRef(Symbol('validation editor'));
  const editing = useRef({ form, dirty, prompts: generationPrompts, scratch }); editing.current = { form, dirty, prompts: generationPrompts, scratch };
  const generationActive = generation?.status === 'RUNNING' || generation?.status === 'CANCELLING';
  const trialActive = !!trialId && (!trial || !TRIAL_TERMINAL_STATUSES.includes(trial.status.status));
  const hasPendingPrompts = !!generationPrompts.correctness || !!generationPrompts.performance;
  const hasPendingScratch = hasScratch(scratch);
  const conflict = !!draft && !!form && (((dirty || hasPendingScratch) && form.expected_digest !== draft.evaluator_digest) || ((dirty || hasPendingPrompts || hasPendingScratch) && draft.qualification !== 'DRAFT'));
  function cache(nextForm: Editable | null, nextDirty: boolean, prompts: GenerationPrompts) {
    if (!validationDrafts) return;
    const pendingScratch = editing.current.scratch;
    if (nextForm && (nextDirty || prompts.correctness || prompts.performance || hasScratch(pendingScratch))) validationDrafts.set(url, { form: nextForm, formDirty: nextDirty, prompts, scratch: pendingScratch, owner: owner.current });
    else validationDrafts.delete(url);
  }
  function edit(nextForm: Editable) {
    editing.current = { ...editing.current, form: nextForm, dirty: true };
    cache(nextForm, true, editing.current.prompts);
    setForm(nextForm); setDirty(true);
  }
  function changePrompts(prompts: GenerationPrompts) {
    editing.current = { ...editing.current, prompts };
    cache(editing.current.form, editing.current.dirty, prompts);
    setGenerationPrompts(prompts);
  }
  function changeScratch(next: EditorScratch) {
    editing.current = { ...editing.current, scratch: next };
    cache(editing.current.form, editing.current.dirty, editing.current.prompts);
    setScratch(next);
  }
  useEffect(() => {
    if (!dirty && !generationPrompts.correctness && !generationPrompts.performance && !hasPendingScratch) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, generationPrompts, hasPendingScratch]);
  useEffect(() => { if (reviewRequest) setStep('run'); }, [reviewRequest]);
  useEffect(() => {
    let active = true;
    setLoadedUrl(''); setDraft(null); setForm(null); setFeedback(null); setDirty(false); setTrialId(''); setTrial(null); setStep('conditions');
    setGeneration(null); setGenerationId(''); setExpandedCode(null); revision.current = 0; generationRevision.current = null; appliedGeneration.current = '';
    const emptyPrompts = { correctness: '', performance: '' };
    editing.current = { form: null, dirty: false, prompts: emptyPrompts, scratch: {} }; setGenerationPrompts(emptyPrompts); setScratch({});
    request<ValidationAssetDraft>(url).then(value => {
      if (!active) return;
      const cached = validationDrafts?.get(url);
      const pendingScratch = cached?.scratch ?? {};
      const restored = cached && (cached.formDirty || hasScratch(pendingScratch)) ? cached.form : formOf(value);
      const prompts = cached?.prompts ?? emptyPrompts;
      if (cached) validationDrafts?.set(url, { ...cached, form: restored, owner: owner.current });
      editing.current = { form: restored, dirty: cached?.formDirty ?? false, prompts, scratch: pendingScratch };
      setDraft(value); setForm(restored); setDirty(cached?.formDirty ?? false); setGenerationPrompts(prompts); setScratch(pendingScratch); setLoadedUrl(url);
      if (cached) setFeedback({ text: '已恢复本页面尚未保存的测试修改或生成提示词。', bad: false });
    })
      .catch(error => { if (active) setFeedback({ text: error.message, bad: true }); });
    request<{ trials: Array<{ trial_id: string; package_id: string; package_version: string; target_id: string; purpose: string }> }>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials`).then(result => {
      const recent = result.trials.find(item => item.package_id === packageId && item.package_version === version && item.target_id === targetId && item.purpose === 'VALIDATION_DRAFT');
      if (active && recent) setTrialId(recent.trial_id);
    }).catch(() => {});
    request<{ generations: ValidationGenerationRecord[] }>(`${url}/generations`).then(result => {
      if (active && result.generations[0]) setGenerationId(result.generations[0].generation_id);
    }).catch(() => {});
    return () => { active = false; };
  }, [url, validationDrafts]);
  useEffect(() => {
    let active = true; setContext(null);
    request<ValidationPreparationContext>(`${url}/context`).then(value => { if (active) setContext(value); }).catch(error => { if (active) setFeedback({ text: error.message, bad: true }); });
    return () => { active = false; };
  }, [url, contextKey]);
  useEffect(() => {
    if (!generationId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const record = await request<ValidationGenerationRecord>(`${url}/generations/${generationId}`);
        if (!active) return;
        setGeneration(record);
        if (record.status === 'RUNNING' || record.status === 'CANCELLING') timer = setTimeout(() => void poll(), 1000);
        else if (record.status === 'SUCCEEDED' && record.result && appliedGeneration.current !== record.generation_id) {
          const current = editing.current;
          if (current.form?.expected_digest === record.evaluator_digest && !hasScratch(current.scratch) && (!current.dirty || revision.current === generationRevision.current)) {
            edit(record.result as Editable); setShowFiles(true); appliedGeneration.current = record.generation_id;
            setFeedback({ text: 'AI 测试代码已生成，尚未保存。请查看代码后保存并试运行。', bad: false });
          }
        }
      } catch (error) { if (active) { setFeedback({ text: `读取生成进度失败，正在重连：${(error as Error).message}`, bad: true }); timer = setTimeout(() => void poll(), 3000); } }
    }
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [url, generationId, !!form]);
  useEffect(() => {
    if (!generation) return;
    const update = () => setElapsed(Math.max(0, Math.floor(((generation.ended_at ? Date.parse(generation.ended_at) : Date.now()) - Date.parse(generation.created_at)) / 1000)));
    update(); if (!generationActive) return;
    const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [generation?.created_at, generation?.ended_at, generationActive]);
  useEffect(() => {
    if (!trialId) return;
    let active = true; let timeout: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await request<TrialResult>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials/${encodeURIComponent(trialId)}`);
        if (!active) return;
        setTrial(result);
        if (!TRIAL_TERMINAL_STATUSES.includes(result.status.status)) timeout = setTimeout(() => void poll(), 2000);
      } catch (error) { if (active) { setFeedback({ text: `读取试跑结果失败，将自动重试：${(error as Error).message}`, bad: true }); timeout = setTimeout(() => void poll(), 5000); } }
    }
    void poll(); return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [projectId, trialId, trialRefresh]);
  async function run(label: string, work: () => Promise<void>) { setWorking(label); setFeedback(null); try { await work(); } catch (error) { setFeedback({ text: (error as Error).message, bad: true }); } finally { setWorking(''); } }
  function change(patch: Partial<Editable>) {
    const current = editing.current.form;
    if (!current) return;
    revision.current++;
    edit({ ...current, ...patch, source: patch.source ?? 'edited' });
  }
  async function save() {
    const submitted = editing.current.form;
    if (!submitted) throw new Error('测试方案尚未读取');
    if (hasScratch(editing.current.scratch)) throw new Error('还有未应用的输入参数、JSON 或线程数，请先应用或放弃后再保存。');
    let updated: ValidationAssetDraft;
    try {
      updated = await request<ValidationAssetDraft>(url, 'PUT', { ...submitted,
        cases: parseValidationInputs(submitted.cases, 'cases', draft?.cases),
        workloads: parseValidationInputs(submitted.workloads, 'workloads', draft?.workloads) });
    } catch (error) {
      if (/validation draft changed|only an unqualified project draft/i.test((error as Error).message)) {
        try { setDraft(await request<ValidationAssetDraft>(url)); } catch { /* Keep the original input and save failure. */ }
        throw new Error('服务器上的测试方案已变化或已启用。未保存的内容仍在，请先查看并记录，再选择放弃测试修改并重新读取。');
      }
      throw error;
    }
    // Only clear the version just submitted. A newer edit may already exist after navigation.
    const pending = validationDrafts?.get(url);
    if (pending?.owner === owner.current && pending.form === submitted) {
      if (pending.prompts.correctness || pending.prompts.performance || hasScratch(pending.scratch)) validationDrafts!.set(url, { form: formOf(updated), formDirty: false, prompts: pending.prompts, scratch: pending.scratch, owner: owner.current });
      else validationDrafts!.delete(url);
    }
    if (editing.current.form === submitted) {
      const nextForm = formOf(updated);
      editing.current = { ...editing.current, form: nextForm, dirty: false };
      setDraft(updated); setForm(nextForm); setDirty(false);
    }
    setFeedback({ text: '测试方案草稿已保存，版本已留存。可继续准备测试代码或到执行机器试运行。', bad: false });
    return updated;
  }
  async function prepare() { await onPrepare?.(); const latest = await request<ValidationPreparationContext>(`${url}/context`); setContext(latest); return latest; }
  async function startGeneration(scope: ValidationGenerationScope, purpose: 'TEST_CODE' | 'CORRECTNESS_PLAN') {
    const promptScope = scope === 'performance' ? 'performance' : 'correctness';
    const instructions = editing.current.prompts[promptScope];
    const pending = validationDrafts?.get(url);
    const started = await request<ValidationGenerationRecord>(`${url}/generate`, 'POST', { scope, purpose, background: true,
      instructions });
    if ((!validationDrafts || validationDrafts.get(url) === pending) && editing.current.prompts[promptScope] === instructions) {
      changePrompts({ ...editing.current.prompts, [promptScope]: '' });
    }
    generationRevision.current = revision.current; setGeneration(started); setGenerationId(started.generation_id); setStep('code');
  }
  async function generate(scope: ValidationGenerationScope, purpose?: 'TEST_CODE' | 'CORRECTNESS_PLAN') {
    if (hasScratch(editing.current.scratch)) throw new Error('还有未应用的测试输入，请先应用或放弃后再生成。');
    await onPrepare?.(); if (dirty) await save();
    await startGeneration(scope, purpose ?? 'TEST_CODE');
  }
  async function adoptPlan() {
    if (!generation?.proposal || dirty || hasScratch(editing.current.scratch) || !draft) throw new Error('请先应用并保存当前修改，再重新起草方案');
    const pending = validationDrafts?.get(url);
    const updated = await request<ValidationAssetDraft>(`${url}/generations/${generation.generation_id}/adopt`, 'POST', { expected_digest: draft.evaluator_digest });
    if (!validationDrafts || validationDrafts.get(url) === pending) {
      const nextForm = formOf(updated);
      editing.current = { ...editing.current, form: nextForm, dirty: false };
      cache(nextForm, false, editing.current.prompts);
      setDraft(updated); setForm(nextForm); setDirty(false); revision.current++;
    }
    setFeedback({ text: '已采用正确性方案，正在生成代码。', bad: false });
    await startGeneration('correctness', 'TEST_CODE');
  }
  async function importScript(key: 'correctness_script' | 'performance_script' | 'setup_script', file?: File) {
    if (!file) return; if (file.size > 96_000) throw new Error('脚本不能超过 96 KB');
    change({ [key]: await file.text(), source: 'uploaded' });
    setShowFiles(true); setFeedback({ text: `已读取 ${file.name}，保存后接入测试。`, bad: false });
  }
  async function importSupport(files: FileList | null) {
    if (!files || !form) return;
    const merged = new Map(form.supporting_files.map(file => [file.path, file]));
    for (const file of Array.from(files)) {
      if (file.size > 200_000) throw new Error('单份支持文件不能超过 200 KB');
      const relative = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
      merged.set(`support/${relative}`, { path: `support/${relative}`, content: await file.text() });
    }
    change({ supporting_files: [...merged.values()], source: 'uploaded' }); setShowFiles(true);
  }
  async function runTrial(mode: 'correctness' | 'comparison' | 'calibration') {
    if (hasScratch(editing.current.scratch)) throw new Error('还有未应用的测试输入，请先应用或放弃后再试运行。');
    setTrialSubmission({ mode, created_at: new Date().toISOString(), message: '正在保存项目配置并检查执行机器…' });
    try {
      await prepare();
      setTrialSubmission(current => current && ({ ...current, message: '正在创建试运行，固定源码、测试条件与比较基线…' }));
      const requestId = trialRequest.begin();
      const result = await request<{ trial_id: string }>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials`, 'POST', {
        package_id: packageId, package_version: version, target_id: targetId, mode, expected_digest: draft?.evaluator_digest }, undefined, { 'idempotency-key': requestId });
      setTrial(null); setTrialId(result.trial_id); setStep('run');
      trialRequest.clear(requestId);
      setFeedback({ text: `已提交${mode === 'calibration' ? 'A/A 同产物校准' : mode === 'comparison' ? '两库对比' : '正确性'}试运行。下方持续更新编译、资源执行与测试结果。`, bad: false });
    } finally { setTrialSubmission(null); }
  }
  async function downloadPackage(trialVersion = false) {
    await downloadProjectTestPackage(projectId, trialVersion ? `validation-trials/${encodeURIComponent(trialId)}/download` : `${action}/download`,
      trialVersion ? 'corepilot-trial-tests.tar.gz' : 'corepilot-test-package.tar.gz');
  }
  async function reviewed() {
    const pending = validationDrafts?.get(url);
    const updated = await request<ValidationAssetDraft>(url);
    if (!validationDrafts || validationDrafts.get(url) === pending) {
      const nextForm = formOf(updated);
      editing.current = { ...editing.current, form: nextForm, dirty: false };
      cache(nextForm, false, editing.current.prompts);
      setDraft(updated); setForm(nextForm); setDirty(false);
    }
    await onReviewed?.();
  }
  async function discardChanges() {
    const pending = validationDrafts?.get(url);
    const latest = await request<ValidationAssetDraft>(url);
    if (validationDrafts && validationDrafts.get(url) !== pending) throw new Error('测试内容在重新读取期间发生变化，未放弃新修改，请再次操作。');
    const nextForm = formOf(latest);
    const prompts = { correctness: '', performance: '' };
    editing.current = { form: nextForm, dirty: false, prompts, scratch: {} };
    validationDrafts?.delete(url);
    setDraft(latest); setForm(nextForm); setDirty(false); setGenerationPrompts(prompts); setScratch({}); revision.current++;
    setFeedback({ text: '已放弃本页面未保存的内容，并恢复服务器上的测试方案。', bad: false });
  }
  if (loadedUrl !== url) return <div className="validation-editor">{feedback ? <Feedback text={feedback.text} bad /> : <p className="hint" role="status">正在读取测试方案…</p>}</div>;
  if (draft && draft.qualification !== 'DRAFT' && !dirty && !hasPendingPrompts && !hasPendingScratch) return <div className="validation-editor"><strong>当前测试方案 · {label(draft.qualification)}</strong><p className="hint">当前版本只读。测试条件、代码与审阅情况可在下方核对。</p><div className="qualified-conditions"><TestConditionsSummary draft={draft} /></div><ValidationReviewPanel url={url} draft={draft} dirty={false} refreshKey={draft.evaluator_digest} onApproved={reviewed} /><button type="button" onClick={() => void run('download', () => downloadPackage())}>下载完整测试包</button>{feedback && <Feedback text={feedback.text} bad={feedback.bad} />}
    <Disclosure title="查看测试代码与完整方案" summary={'4 个入口与配置文件 · ' + draft.supporting_files.length + ' 份支持文件'} className="qualified-files">
      {[{ path: 'test-plan.json', content: JSON.stringify(draft.test_plan, null, 2) }, { path: 'scripts/run-correctness.sh', content: draft.correctness_script }, { path: 'scripts/run-performance.sh', content: draft.performance_script }, { path: 'scripts/build-evaluator.sh', content: draft.setup_script }, ...draft.supporting_files].map(file => <details key={file.path}><summary>{file.path}</summary><pre className="detail-code">{file.content}</pre></details>)}
      <p className="validation-identity">测试版本 <CopyValue value={draft.evaluator_digest} label="测试版本" /></p>
    </Disclosure></div>;
  const scripts = [['correctness_script', '正确性测试脚本', 'correctness'], ['performance_script', '性能测试脚本', 'performance']] as const;
  const primaryPaths = new Set(form ? scripts.map(([, , scope]) => testProgramFile(form, scope).path) : []);
  const otherSupportFiles = form?.supporting_files.filter(file => !primaryPaths.has(file.path)) ?? [];
  const expandedFile = form && expandedCode ? testProgramFile(form, expandedCode) : null;
  return <div className="validation-editor">
    <div className="validation-editor-heading"><div><strong>准备当前函数的测试方案</strong><p className="hint">当前目标：{draft?.function_name ?? targetId}。先确定条件，再接入测试代码，最后试运行。</p></div>{draft && <div className="validation-editor-identity"><span className="setup-state review">待完善</span><details><summary>测试版本</summary><CopyValue value={draft.evaluator_digest} label="测试版本" /></details></div>}</div>
    {(dirty || hasPendingPrompts || hasPendingScratch) && <div className="config-state" role="status"><span>有未保存的测试修改或生成提示词{hasPendingScratch ? '；部分输入尚未应用' : ''}</span><button type="button" className="text-btn" disabled={!!working} onClick={() => void run('discard', discardChanges)}>放弃测试修改并重新读取</button></div>}
    {conflict && <div role="alert"><Feedback bad text="服务器上的测试方案已更新或已启用，未保存的内容仍在。保存时会检查原版本，避免覆盖他人的修改；请先查看并记录内容，之后选择放弃测试修改并重新读取。" /></div>}
    <div className="test-preparation-tabs" role="tablist" aria-label="测试准备步骤">{[['conditions', '1 测试条件'], ['code', '2 测试代码'], ['run', '3 试运行与对比']].map(([id, title]) => <button key={id} type="button" role="tab" aria-selected={step === id} onClick={() => setStep(id as typeof step)}>{title}</button>)}</div>
    <TrialRequestRecovery requestState={trialRequest} label="试跑" sending={!!trialSubmission} onFound={id => { setTrial(null); setTrialId(id); setStep('run'); }} onMessage={(text, bad = false) => setFeedback({ text, bad })} />
    {feedback && <Feedback text={feedback.text} bad={feedback.bad} />}
    {generation && <div className={`validation-generation ${generation.status === 'NEEDS_INPUT' || generation.status === 'FAILED' ? 'needs-input' : ''}`} aria-live="polite">
      <div className="test-section-heading"><strong>{generationActive ? generation.purpose === 'CORRECTNESS_PLAN' ? 'AI 正在起草正确性方案' : 'AI 正在生成测试代码' : { SUCCEEDED: generation.proposal ? '方案已起草 · 待你采用' : '生成完成 · 待试运行', NEEDS_INPUT: '需要补充测试条件', FAILED: '生成失败', CANCELLED: '生成已取消', INTERRUPTED: '生成已中断', RUNNING: '正在生成', CANCELLING: '正在取消' }[generation.status]}</strong><span>{elapsed} 秒</span></div>
      {!generation.blockers?.length && <p>{generation.message}</p>}<p>请求模型：<strong>{generation.model.requested_model}</strong> · 已发送 {generation.model.request_count} 次请求{generation.model.response_model && <> · 服务端返回：<strong>{generation.model.response_model}</strong></>}</p>
      {generationActive && <div className="form-actions"><span className="hint">可继续查看页面；刷新或返回后仍可读取进度。</span><button type="button" disabled={generation.status === 'CANCELLING'} onClick={() => void run('cancel-generation', async () => { setGeneration(await request<ValidationGenerationRecord>(`${url}/generations/${generationId}/cancel`, 'POST', {})); })}>取消生成</button></div>}
      {!!generation.blockers?.length && <><ul>{generation.blockers.map((item, i) => <li key={i}>{item}</li>)}</ul><p className="hint">可在测试代码中补充提示词后重新生成，也可以留空，让模型根据当前源码和配置生成。</p><button type="button" onClick={() => setStep('code')}>返回测试代码</button></>}
      {generation.status === 'SUCCEEDED' && generation.proposal && <CorrectnessPlanReview proposal={generation.proposal} stale={dirty || hasPendingScratch || draft?.evaluator_digest !== generation.evaluator_digest} busy={!!working} onAdopt={() => void run('adopt-plan', adoptPlan)} onEdit={() => {
        const proposal = generation.proposal!;
        change({ cases: proposal.cases, oracle_description: proposal.oracle_description, tolerance_rule: proposal.tolerance_rule,
          tolerance_absolute: proposal.tolerance_absolute, tolerance_relative: proposal.tolerance_relative, source: 'ai' });
        setStep('conditions'); setTimeout(() => document.querySelector<HTMLDetailsElement>('.correctness-conditions')?.setAttribute('open', ''), 0);
      }} />}
      {generation.status === 'SUCCEEDED' && generation.result && appliedGeneration.current !== generation.generation_id && <div className="form-actions"><p className="hint">编辑内容或测试版本已变化，生成结果已保留。应用代码会保留当前测试条件；已保存的条件版本改变时请重新生成。</p><button type="button" disabled={form?.expected_digest !== generation.evaluator_digest} onClick={() => {
        const result = generation.result!;
        const support = new Map(form?.supporting_files.map(file => [file.path, file]));
        for (const file of result.supporting_files ?? []) support.set(file.path, file);
        change({ ...(generation.scope !== 'performance' ? { correctness_script: result.correctness_script } : {}),
          ...(generation.scope !== 'performance' && !form?.quality && result.quality ? { quality: result.quality } : {}),
          ...(generation.scope !== 'correctness' ? { performance_script: result.performance_script } : {}),
          ...(result.setup_script ? { setup_script: result.setup_script } : {}), supporting_files: [...support.values()], source: 'ai' });
        appliedGeneration.current = generation.generation_id; setShowFiles(true);
      }}>应用生成草稿</button></div>}
      {generation.result && <details className="generated-code-preview"><summary>查看本次生成的代码草稿</summary>{(['correctness', 'performance'] as const).filter(scope => generation.scope === 'both' || generation.scope === scope).map(scope => { const file = testProgramFile(generation.result!, scope); return <div key={scope}><p><code>{file.path}</code></p><pre className="detail-code">{file.content}</pre><button type="button" onClick={() => download(file.content, file.path.split('/').at(-1)!)}>下载本次生成的{scope === 'correctness' ? '正确性' : '性能'}代码</button></div>; })}</details>}
      {generation.result?.generation_notes && <p className="generation-notes">生成说明：{generation.result.generation_notes}</p>}
      {generation.result && generation.scope !== 'performance' && <details><summary>查看生成草稿的输入与正确性参考</summary><p>{generation.result.oracle_description}</p><p>误差规则：{generation.result.tolerance_rule} · 绝对误差 {generation.result.tolerance_absolute} · 相对误差 {generation.result.tolerance_relative}</p>{generation.result.cases.map(item => <p key={item.case_id}><strong>{item.case_id}</strong>：{item.input_generation || '见测试程序中的输入构造'}</p>)}</details>}
      {generation.result && generation.scope !== 'correctness' && <details className="generated-performance-conditions"><summary>查看生成草稿的性能负载与计时方式</summary><p>{generation.result.benchmark_description}</p>{generation.result.workloads.map(item => <div key={item.workload_id}><p><strong>{item.workload_id}</strong>：{Object.entries(item.parameters).map(([key, value]) => `${key}=${value}`).join(' · ') || '无输入参数'}</p><p>{item.input_generation || '见测试程序中的输入构造'}</p></div>)}<p className="hint">补全的尺寸和数据构造是待保存草稿；线程、CPU、NUMA、采样次数与 seed 沿用已有设置。</p></details>}
      <details><summary>查看模型调用记录</summary><p>接口：{generation.model.endpoint}</p><p>实际请求模型：{generation.model.sent_model ?? '尚未发送'}</p><p>请求 ID：{generation.model.request_id ?? '服务端未提供'}</p><p>最近一次响应 Token：{generation.model.usage?.total_tokens ?? '服务端未提供'}</p><p>生成提示词：{generation.instructions || '未填写，由模型根据当前源码和配置生成'}</p><p>生成记录：{generation.generation_id}</p></details>
    </div>}
    {expandedFile && <Modal title={`${expandedCode === 'correctness' ? '正确性' : '性能'}测试代码`} wide onClose={() => setExpandedCode(null)}><p className="test-code-file"><code>{expandedFile.path}</code></p><pre className="detail-code test-code-expanded">{expandedFile.content}</pre><button type="button" onClick={() => download(expandedFile.content, expandedFile.path.split('/').at(-1)!)}>下载代码文件</button></Modal>}
    {trialFiles && <Modal title="本次试运行实际使用的测试代码" wide onClose={() => setTrialFiles(null)}>{[...trialFiles].sort((a, b) => Number(/^support\/test-(?:correctness|performance)\.py$/.test(b.path)) - Number(/^support\/test-(?:correctness|performance)\.py$/.test(a.path))).map(file => <details key={file.path} open={/^support\/test-(?:correctness|performance)\.py$/.test(file.path)}><summary>{file.path}</summary><pre className="detail-code">{file.content}</pre></details>)}</Modal>}
    {!form ? <p className="hint">正在读取测试方案…</p> : <fieldset disabled={!!working}>
      <div className="test-context"><span>执行机器：{context?.machine?.name ?? '未连接或尚未保存'}</span><span>比较基线：{context?.baseline.configured ? `${context.baseline.library} · ${context.baseline.version}` : '待准备，可先完成正确性测试'}</span><button type="button" onClick={() => void run('context', async () => { await prepare(); })}>刷新准备信息</button></div>
      {step === 'conditions' && <>
        <div className="test-condition-intro"><strong>输入与运行条件</strong><p>每个输入都会在所选线程和绑核条件下测试。</p></div>
        <ValidationInventoryEditor title="性能负载" kind="workloads" entries={form.workloads} matrixMode={!!form.test_plan.execution_matrix} scratch={scratch.workloads ?? {}} onScratchChange={workloads => changeScratch({ ...editing.current.scratch, workloads })} onChange={workloads => change({ workloads: workloads as ValidationPerformanceInput[] })} />
        {form.workloads.some(item => item.input_generation) && <details><summary>性能输入数据生成规则</summary>{form.workloads.map((item, index) => <Field key={item.workload_id} label={`${item.workload_id} · 性能数据生成规则`}><textarea rows={3} value={item.input_generation ?? ''} onChange={e => change({ workloads: form.workloads.map((entry, i) => i === index ? { ...entry, input_generation: e.target.value || undefined } : entry) })} /></Field>)}</details>}
        <ValidationPlanEditor plan={form.test_plan} context={context} caseCount={form.cases.length} workloadCount={form.workloads.length} threadInput={scratch.threadInput} onThreadInputChange={threadInput => changeScratch({ ...editing.current.scratch, threadInput })} onChange={test_plan => change({ test_plan })} />
        <details className="test-secondary-section correctness-conditions"><summary>正确性测试与误差规则 · {form.cases.length} 个输入</summary><p className="hint">性能对比前先检查结果是否正确。这里定义独立参考、边界输入和允许误差；比较库本身不会自动成为正确性标准。</p>
          <button type="button" disabled={generationActive} onClick={() => void run('plan', () => generate('correctness', 'CORRECTNESS_PLAN'))}>用 AI 起草正确性方案</button>
          {form.workloads.some(item => Object.keys(item.parameters).length > 0) && <button type="button" onClick={() => change({ cases: form.workloads.map(item => ({ case_id: `check-${item.workload_id}`, parameters: { ...item.parameters }, threads: item.threads })) })}>使用性能输入作为正确性输入</button>}
          <ValidationInventoryEditor title="正确性用例" kind="cases" entries={form.cases} matrixMode={!!form.test_plan.execution_matrix} scratch={scratch.cases ?? {}} onScratchChange={cases => changeScratch({ ...editing.current.scratch, cases })} onChange={cases => change({ cases: cases as ValidationCorrectnessInput[] })} />
          <details><summary>输入数据生成规则</summary><p className="hint">AI 生成时会补全缺少的规则。每个输入按同一规则覆盖已选线程与绑核组合。</p>{form.cases.map((item, index) => <Field key={item.case_id} label={`${item.case_id} · 数据生成规则`}><textarea rows={3} value={item.input_generation ?? ''} onChange={e => change({ cases: form.cases.map((entry, i) => i === index ? { ...entry, input_generation: e.target.value || undefined } : entry) })} /></Field>)}</details>
          <div className="validation-script-grid"><Field label="独立正确性参考与失败判断"><textarea aria-label="独立正确性参考与失败判断" rows={3} value={form.oracle_description} onChange={e => change({ oracle_description: e.target.value })} /></Field><Field label="允许误差规则"><input value={form.tolerance_rule} onChange={e => change({ tolerance_rule: e.target.value })} /></Field><Field label="绝对误差"><input type="number" min="0" step="any" value={form.tolerance_absolute} onChange={e => change({ tolerance_absolute: Number(e.target.value) })} /></Field><Field label="相对误差"><input type="number" min="0" step="any" value={form.tolerance_relative} onChange={e => change({ tolerance_relative: Number(e.target.value) })} /></Field></div>
        </details>
        <ValidationQualityEditor value={form.quality} inputIds={form.cases.map(row => row.case_id)} onChange={quality => change({ quality })} />
        <details className="test-secondary-section"><summary>测试程序接入 · API、产物与计时约定</summary><p className="hint">已有脚本或 AI 生成的测试程序按这些约定调用两端库。切换为不同 API 的比较库时，请确认 API 映射和输入转换。</p><div className="validation-script-grid">
          <Field label="当前库 API"><input value={form.test_plan.candidate_api} onChange={e => change({ test_plan: { ...form.test_plan, candidate_api: e.target.value } })} /></Field><Field label="比较库 API"><input value={form.test_plan.baseline_api} onChange={e => change({ test_plan: { ...form.test_plan, baseline_api: e.target.value } })} /></Field>
          <Field label="候选产物路径（相对源码根）"><input value={form.candidate_artifact} onChange={e => change({ candidate_artifact: e.target.value })} /></Field><Field label="计时方式与负载说明"><textarea aria-label="计时方式与负载说明" rows={3} value={form.benchmark_description} onChange={e => change({ benchmark_description: e.target.value })} /></Field></div>
        </details>
        <div className="form-actions"><button type="button" className="primary" onClick={() => void run('save', async () => { await save(); setStep('code'); })}>保存条件并准备测试代码</button><button type="button" onClick={() => setStep('code')}>继续编辑已有测试代码</button></div>
      </>}
      {step === 'code' && <>
        <p className="hint">已有测试可以直接上传入口脚本及支持文件；缺少哪部分，就让 AI 补哪部分。CPU、NUMA、线程、输入和采样条件沿用第 1 步。</p>
        <div className="validation-script-grid">{scripts.map(([key, title, scope]) => <div className="test-code-card" key={key}>
          <strong>{title}</strong>
          {generation?.scope === scope && <p className="hint" role="status">{generationActive ? '模型正在生成，请查看页面中的进度。' : generation.status === 'SUCCEEDED' ? '本次生成已完成，可查看实际代码并保存草稿。' : generation.status === 'NEEDS_INPUT' ? '本次生成未完成，具体原因显示在生成记录中。' : generation.status === 'FAILED' ? '本次生成失败，具体原因显示在生成记录中。' : '本次生成已停止，可重新生成。'}</p>}
          <Field label={scope === 'correctness' ? '生成提示词（可选）' : '性能代码生成提示词（可选）'} help="留空则根据当前源码和配置生成；提示词可补充测试重点。线程、绑核和采样按已保存条件执行。">
            <textarea aria-label={scope === 'correctness' ? '生成提示词（可选）' : '性能代码生成提示词（可选）'} rows={3} maxLength={12000} value={generationPrompts[scope]} placeholder={scope === 'correctness' ? '例如：使用独立数学参考，重点覆盖边界尺寸、非连续步长和浮点误差。' : '例如：分别测量两端库的函数耗时，排除内存分配。'} onChange={e => changePrompts({ ...editing.current.prompts, [scope]: e.target.value })} />
          </Field>
          <div className="form-actions"><button type="button" disabled={generationActive} onClick={() => void run(scope, () => generate(scope))}>{generationActive && generation?.scope === scope ? '正在生成…' : `用 AI 生成${scope === 'correctness' ? '正确性' : '两库性能'}代码`}</button><label className="validation-upload">上传已有脚本<input aria-label={`上传${title}`} type="file" accept=".sh,.txt,text/plain" onChange={e => void run('upload', () => importScript(key, e.target.files?.[0]))} /></label></div>
          <ValidationTestCode assets={form} scope={scope} open={showFiles} onChange={file => file.path.startsWith('scripts/') ? change({ [key]: file.content }) : change({ supporting_files: form.supporting_files.map(item => item.path === file.path ? file : item) })} onDownload={file => download(file.content, file.path.split('/').at(-1)!)} onExpand={() => setExpandedCode(scope)} />
        </div>)}</div>
        <details open={showFiles}><summary>构建测试程序与其他支持文件 · {otherSupportFiles.length} 份</summary><p className="hint">主测试程序在上方查看。这里管理构建入口、C/C++、头文件和其它依赖；运行约定见完整测试包中的说明。</p><Field label="测试程序构建脚本"><textarea rows={8} value={form.setup_script} onChange={e => change({ setup_script: e.target.value })} /></Field><label className="validation-upload">上传构建脚本<input aria-label="上传测试程序构建脚本" type="file" accept=".sh,.txt" onChange={e => void run('upload', () => importScript('setup_script', e.target.files?.[0]))} /></label><label className="validation-upload">添加支持文件<input aria-label="添加测试支持文件" type="file" multiple accept=".c,.cc,.cpp,.cxx,.h,.hpp,.py,.sh,.json,.txt,.csv" onChange={e => void run('upload', () => importSupport(e.target.files))} /></label><label className="validation-upload">添加支持文件夹<input aria-label="添加测试支持文件夹" type="file" {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={e => void run('upload', () => importSupport(e.target.files))} /></label>
          {otherSupportFiles.map(file => <details key={file.path}><summary>{file.path}</summary><textarea aria-label={file.path} rows={10} value={file.content} spellCheck={false} onChange={e => change({ supporting_files: form.supporting_files.map(item => item.path === file.path ? { ...item, content: e.target.value } : item) })} /><div className="form-actions"><button type="button" onClick={() => download(file.content, file.path.split('/').at(-1)!)}>下载文件</button><button type="button" onClick={() => change({ supporting_files: form.supporting_files.filter(item => item.path !== file.path) })}>移除文件</button></div></details>)}</details>
        <div className="form-actions"><button type="button" className="primary" onClick={() => void run('save', async () => { await save(); })}>保存测试方案草稿</button><button type="button" onClick={() => setShowFiles(value => !value)}>{showFiles ? '收起代码' : '查看测试代码'}</button><button type="button" disabled={dirty} onClick={() => void run('download', () => downloadPackage())}>下载完整测试包</button><button type="button" onClick={() => setStep('run')}>进入试运行</button></div>
      </>}
      {step === 'run' && <><div className="test-run-summary"><strong>本次执行条件</strong><p>{form.test_plan.execution_matrix ? `${form.test_plan.execution_matrix.thread_counts.join(' / ')} 线程 · ${form.test_plan.execution_matrix.profiles.length} 组绑核方案` : `CPU ${form.test_plan.resources.cpu_set || '待设置'} · NUMA ${form.test_plan.resources.numa_node}`} · {form.test_plan.sampling.warmup_count} 次预热 · 每端 {form.test_plan.sampling.sample_count} 次采样 · 随机种子 {form.test_plan.seed}</p><p>{form.cases.length} 个正确性用例，{form.workloads.length} 个性能输入；线程与绑核条件按第 1 步逐组执行。</p></div>
        <div className="form-actions">
          <button type="button" disabled={dirty || hasPendingScratch || trialActive || !!trialSubmission || !!trialRequest.pending || !!trialRequest.storageError} onClick={() => void run('trial', () => runTrial('correctness'))}>{trialSubmission?.mode === 'correctness' ? '正在提交正确性试运行…' : '仅试运行正确性测试'}</button>
          <button type="button" className="primary" disabled={dirty || hasPendingScratch || trialActive || !!trialSubmission || !!trialRequest.pending || !!trialRequest.storageError} onClick={() => void run('trial', () => runTrial('comparison'))}>{trialSubmission?.mode === 'comparison' ? '正在提交两库对比…' : '在 Runner 上试运行两库对比'}</button>
          <button type="button" disabled={dirty || hasPendingScratch || trialActive || !!trialSubmission || !!trialRequest.pending || !!trialRequest.storageError} onClick={() => void run('trial', () => runTrial('calibration'))}>运行 A/A 测量校准</button>
          <button type="button" disabled={dirty} onClick={() => void run('download', () => downloadPackage())}>下载完整测试包</button>
        </div>
        <p className="hint">A/A 校准用当前构建的同一个产物作为两端，检查测量偏差与区间宽度。先在测试条件选择「重复测量」并保存；校准不替代两库对比试跑。</p>
        {trialSubmission && <div className="validation-trial" role="status"><ValidationTrialProgress submission={trialSubmission} /></div>}
        {(dirty || hasPendingScratch) && <div className="form-actions"><p className="hint">有未保存的测试条件或代码，请先应用并保存。</p><button type="button" onClick={() => void run('save', async () => { await save(); })}>保存测试方案草稿</button></div>}
        {trialId && !trialSubmission && <div className="validation-trial" role="status"><ValidationTrialProgress trial={trial} /><p className="hint">试跑 ID：{trialId}。结果对应测试版本 {trial?.trial.evaluator_digest.slice(0, 12) ?? '读取中'}；开发试运行不授予正式实验资格。</p>{trial?.trial.evaluator_digest !== draft?.evaluator_digest && trial && <p className="hint">当前编辑版本已变化，下方仍保留原版本的结果。</p>}<button type="button" onClick={() => void run('view', async () => { const data = await request<{ files: ValidationSourceFile[] }>(`/v1/projects/${projectId}/validation-trials/${encodeURIComponent(trialId)}/files`); setTrialFiles(data.files); })}>查看本次测试代码</button><button type="button" onClick={() => void run('download', () => downloadPackage(true))}>下载本次实际使用的测试包</button>{trial?.status.failure && <Feedback text={trial.status.failure.message} bad />}
          {trial?.status.status === 'UNKNOWN' && <><p className="hint">原试跑可能仍在占用机器，请先核对原作业，再决定是否发起新的试跑。</p><button type="button" onClick={() => { setTrial(null); setTrialRefresh(value => value + 1); }}>核对原试跑状态</button></>}
          {trial && <><p>正确性：{trial.summary.correctness.passed}/{trial.summary.correctness.planned} 通过；性能：{trial.summary.performance.measured}/{trial.summary.performance.planned} 个有效样本。</p>{!!trial.summary.comparisons?.length && <div className="test-table-scroll"><table><thead><tr><th>输入</th><th>运行条件</th><th>基线中位耗时（秒）</th><th>当前库中位耗时（秒）</th><th>加速比</th></tr></thead><tbody>{trial.summary.comparisons.map(item => <tr key={item.workload_id}><td>{item.input_id ?? item.workload_id}</td><td>{item.threads ? <><strong>{item.profile_name} · {item.threads} 线程</strong><small className="comparison-resources">CPU {item.cpu_set} · NUMA {item.numa_node}{item.omp_proc_bind ? ` · ${item.omp_proc_bind}` : ''}</small></> : '见本次执行记录'}</td><td>{item.baseline_median?.toPrecision(6) ?? '样本未齐'}</td><td>{item.candidate_median?.toPrecision(6) ?? '样本未齐'}</td><td>{item.speedup?.toFixed(3) ?? '—'}{item.speedup !== null ? '×' : ''}</td></tr>)}</tbody></table><details><summary>查看原始性能样本</summary><pre>{JSON.stringify(trial.measurements?.filter(item => item.kind === 'PERFORMANCE_SAMPLE') ?? [], null, 2)}</pre></details></div>}{(trial.summary.correctness.missing.length > 0 || trial.summary.performance.missing.length > 0) && <p className="hint">缺失测量：{[...trial.summary.correctness.missing, ...trial.summary.performance.missing].join('、')}</p>}{trial.commands.map((item, index) => <details key={index} open={item.exit_code !== 0}><summary>{item.step} · 退出码 {item.exit_code ?? '未知'}</summary><pre>{item.command} {item.args.join(' ')}{'\n'}{item.stdout}{item.stderr ? `\n[stderr]\n${item.stderr}` : ''}</pre>{item.resource_context !== undefined && <details><summary>实际资源执行记录</summary><pre>{JSON.stringify(item.resource_context, null, 2)}</pre></details>}</details>)}{trial.passed && <p className="hint">{trial.trial.mode === 'comparison' ? '试运行通过。请在下方审阅并启用这版测试方案，随后即可运行前检查。' : trial.trial.mode === 'calibration' ? '同产物校准已执行，偏差与区间见校准分析。下一步仍需两库对比试跑。' : '正确性试运行通过。接下来试运行两库对比，确认性能代码与基线可用。'}</p>}</>}
          {!!trial?.summary.issues?.length && <div role="alert" className="notice compact"><strong>试运行测量不能用于审阅</strong><p>{trial.summary.issues.join('；')}。请检查原始测量和执行记录，修复后重新试跑。</p></div>}
        </div>}
        {trial && <ValidationQualitySummary quality={trial.summary.quality} />}
        {trial?.summary.calibration && <div className="calibration-summary"><strong>A/A 同产物校准：{trial.summary.calibration.status === 'COMPATIBLE_WITH_EQUALITY' ? '区间兼容 1×' : trial.summary.calibration.status === 'BIAS_DETECTED' ? '检测到测量偏差，请调查计时与运行环境' : trial.summary.calibration.status === 'INVALID' ? '样本无效或不完整，请检查原始测量' : '有效样本不足'}</strong>
          <p>{trial.summary.calibration.note}</p>{trial.summary.calibration.statistics.overall_interval && <p>总体区间：{trial.summary.calibration.statistics.overall_interval.lower.toFixed(4)}× ～ {trial.summary.calibration.statistics.overall_interval.upper.toFixed(4)}×</p>}
          <details><summary>查看 A/A 校准原始分析</summary><pre>{JSON.stringify(trial.summary.calibration, null, 2)}</pre></details></div>}
        <ValidationReviewPanel url={url} draft={draft!} dirty={dirty || hasPendingScratch} refreshKey={`${trialId}/${trial?.status.status}/${draft?.evaluator_digest}/${reviewRequest}`} onApproved={reviewed} />
      </>}
    </fieldset>}
  </div>;
}
