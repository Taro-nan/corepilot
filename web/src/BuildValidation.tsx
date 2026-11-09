import React, { useEffect, useRef, useState } from 'react';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ProjectSetup, ProjectValidationPlan, ProjectValidationPlans } from '../../src/contracts/project-setup';
import type { FunctionCandidate } from '../../src/onboarding/repository-inspector';
import type { ProjectBuildOptions } from '../../src/contracts/build-planning';
import { commandBuild, displayBuildCommand } from '../../src/config/build-command';
import { isRegisteredRunner } from '../../src/config/runner-config';
import type { CatalogItem } from './Configuration';
import { request } from './api';
import { Field, Panel, Feedback, time, Disclosure } from './components';
import { ValidationAssetsEditor, type ValidationEditorDraft } from './ValidationAssetsEditor';
import type { TaskPreparationContext } from './TaskComposer';
import { BaselinePicker } from './BaselinePicker';
import './build-validation.css';

type Mode = 'new' | 'testpack' | 'package';
interface DraftResult { state: string; package_path: string; evaluator_path: string;
  targets: Array<{ symbol: string | null; target_id: string; evaluator_path: string }>;
  evidence: { generated: { package_id: string; version: string } } }
const planKey = (selection: ProjectValidationPlan['selection']) => `${selection.package_id}@${selection.package_version}:${selection.target_id}`;
const planState = (value: string) => ({ DRAFT: '待完善', REVIEWED: '已审阅', QUALIFIED: '已获资格', REJECTED: '已拒绝', SUPERSEDED: '已替代', LEGACY: '历史方案' } as Record<string, string>)[value] ?? value;

export function BuildValidation({ projectId, config, catalog, selectedSymbols, onSelectedSymbolsChange, onChange, onBuild, onSave, onBoundConfig, onCheck, busy, preparation, validationDrafts }: {
  projectId: string; config: OptimizationConfig; catalog: CatalogItem[]; onChange: (config: OptimizationConfig) => void;
  selectedSymbols: string[]; onSelectedSymbolsChange: (symbols: string[]) => void;
  onBuild: (build: OptimizationConfig['build']) => void; onSave: () => Promise<OptimizationConfig>; onBoundConfig: (config: OptimizationConfig) => void; onCheck: () => Promise<{ message: string }>; busy: boolean;
  preparation?: { task: TaskPreparationContext; plans: ProjectValidationPlans | null; setup: ProjectSetup };
  validationDrafts?: Map<string, ValidationEditorDraft>;
}) {
  const taskFunction = preparation?.task.functionName.trim() ?? '';
  const initialPlans = preparation?.plans;
  const initialSelection = config.validation.library_package;
  const initialMatch = !!initialSelection && !!initialPlans?.plans.some(plan => planKey(plan.selection) === planKey(initialSelection));
  const [mode, setMode] = useState<Mode>(() => taskFunction
    ? initialMatch ? 'package' : config.validation.testpack.trim() && !!initialPlans?.current_testpack ? 'testpack' : initialPlans?.plans.length ? 'package' : 'new'
    : config.validation.library_package ? 'package' : config.validation.testpack.trim() ? 'testpack' : 'new');
  const [setup, setSetup] = useState<ProjectSetup | null>(preparation?.setup ?? null);
  const [targetPlans, setTargetPlans] = useState<ProjectValidationPlans | null>(initialPlans ?? null);
  const [planChoice, setPlanChoice] = useState(initialMatch && initialSelection ? planKey(initialSelection)
    : initialPlans?.plans.length === 1 ? planKey(initialPlans.plans[0].selection) : '');
  const [targetImportTouched, setTargetImportTouched] = useState(false);
  const [packages, setPackages] = useState(catalog);
  const [packageKey, setPackageKey] = useState(config.validation.library_package ? `${config.validation.library_package.package_id}@${config.validation.library_package.package_version}` : '');
  const [working, setWorking] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  const [feedbackAction, setFeedbackAction] = useState('');
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checkGuidance, setCheckGuidance] = useState<'plan' | 'draft' | 'review' | null>(null);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [existingDraft, setExistingDraft] = useState('');
  const existingDraftsRef = useRef<HTMLDivElement>(null);
  const functionsRef = useRef<HTMLDivElement>(null);
  const packageRef = useRef<HTMLDivElement>(null);
  const scriptsRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [buildOptions, setBuildOptions] = useState<ProjectBuildOptions | null>(null);
  const [buildOptionsLoading, setBuildOptionsLoading] = useState(false);
  const [customBuild, setCustomBuild] = useState(false);
  const selected = packages.find(p => `${p.package_id}@${p.version}` === packageKey);
  const selectedPlan = config.validation.library_package && targetPlans?.plans.find(plan => planKey(plan.selection) === planKey(config.validation.library_package!));
  const targetSelectionMatches = !taskFunction || !!selectedPlan;
  const taskPlan = targetPlans?.plans.find(plan => planKey(plan.selection) === planChoice);
  const differentSavedFunction = !!taskFunction && !!setup?.validation && setup.validation.function_name !== taskFunction;
  const projectDrafts = packages.filter(p => p.package_id === `project-${projectId.slice(0, 8)}` && ['DRAFT', 'REVIEWED'].includes(p.qualification.state))
    .flatMap(p => p.targets.map(target => ({ package: p, target,
      key: `${p.package_id}@${p.version}:${target.target_id}`,
      name: p.functions.find(fn => fn.function_id === target.function_id)?.api ?? target.target_id })));
  const command = displayBuildCommand(config.build);
  const discovery = setup?.discovery;
  const machineId = isRegisteredRunner(config.runner) ? config.runner.machine_id : '';
  useEffect(() => { setPackages(catalog); }, [catalog]);
  useEffect(() => {
    let active = true;
    setDraft(null);
    request<ProjectSetup>(`/v1/projects/${projectId}/setup`).then(value => {
      if (!active) return;
      setSetup(value);
      if (value.discovery) {
        const available = new Set(value.discovery.functions.map(item => item.symbol));
        const retained = taskFunction ? (available.has(taskFunction) ? [taskFunction] : []) : selectedSymbols.filter(symbol => available.has(symbol));
        if (retained.join('\u0000') !== selectedSymbols.join('\u0000')) onSelectedSymbolsChange(retained);
      }
    }).catch(error => { if (active) setFeedback({ text: error.message, bad: true }); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    if (mode === 'package') return;
    const controller = new AbortController();
    setBuildOptionsLoading(true); setBuildOptions(null);
    const query = machineId ? `?machine_id=${encodeURIComponent(machineId)}` : '';
    request<ProjectBuildOptions>(`/v1/projects/${projectId}/build-options${query}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setBuildOptions(value); })
      .catch(error => { if (!controller.signal.aborted) setBuildOptions({ recent: null, recommended: null, message: error.message }); })
      .finally(() => { if (!controller.signal.aborted) setBuildOptionsLoading(false); });
    return () => controller.abort();
  }, [projectId, machineId, discovery?.inspected_at, mode]);
  async function action(name: string, work: () => Promise<void>) {
    setWorking(name); setFeedback(null); setFeedbackAction(name); setCheckGuidance(null); setCheckResult(null);
    try { await work(); } catch (error) { setFeedback({ text: (error as Error).message, bad: true }); } finally { setWorking(''); }
  }
  async function refreshFacts() {
    const [refreshed, plans] = await Promise.all([
      request<ProjectSetup>(`/v1/projects/${projectId}/setup`),
      taskFunction ? request<ProjectValidationPlans>(`/v1/projects/${projectId}/validation-plans?function_name=${encodeURIComponent(taskFunction)}`) : Promise.resolve(null),
    ]);
    setSetup(refreshed);
    if (taskFunction) setTargetPlans(plans);
    return refreshed;
  }
  function changeMode(next: Mode) {
    setMode(next); setFeedback(null); setCheckResult(null); setCheckGuidance(null);
    // Merely exploring another mode must not replace the project's existing plan.
    if (taskFunction) return;
    if (next === 'new') onChange({ ...config, validation: { testpack: '' } });
    if (next === 'testpack' && config.validation.library_package) onChange({ ...config, validation: { testpack: '' } });
    if (next === 'package' && !config.validation.library_package) { setPackageKey(''); onChange({ ...config, validation: { testpack: '' } }); }
  }
  async function inspect() {
    const refreshed = await request<ProjectSetup>(`/v1/projects/${projectId}/source-inspection`, 'POST', {});
    setSetup(refreshed);
    const available = new Set(refreshed.discovery?.functions.map(item => item.symbol) ?? []);
    onSelectedSymbolsChange(taskFunction ? (available.has(taskFunction) ? [taskFunction] : []) : selectedSymbols.filter(symbol => available.has(symbol)));
    setFeedback({ text: '已识别当前源码。构建推荐将结合所选机器的真实工具链生成；识别过程没有执行构建或测试。', bad: false });
  }
  async function createDraft() {
    if (taskFunction && !discovery?.functions.some(item => item.symbol === taskFunction)) throw new Error('当前检出源码未识别到任务目标函数，请核对源码和函数名后重新识别。');
    const symbols = taskFunction ? [taskFunction] : selectedSymbols;
    const result = await request<DraftResult>(`/v1/projects/${projectId}/discover`, 'POST', { symbols,
      ...(command.trim() ? { build_command: command, build_cwd: config.build.cwd } : {}) });
    const selectedTarget = taskFunction ? result.targets.find(target => target.symbol === taskFunction) : result.targets[0];
    if (!selectedTarget) throw new Error('生成结果不包含当前目标函数。已保留生成的草稿，请重新读取方案后核对。');
    setDraft(result);
    setPackages((await request<{ packages: CatalogItem[] }>('/v1/catalog')).packages);
    if (taskFunction) {
      const refreshedPlans = await request<ProjectValidationPlans>(`/v1/projects/${projectId}/validation-plans?function_name=${encodeURIComponent(taskFunction)}`);
      setTargetPlans(refreshedPlans);
      setPlanChoice(planKey({ package_id: result.evidence.generated.package_id, package_version: result.evidence.generated.version, target_id: selectedTarget.target_id }));
    }
    setMode('package');
    setPackageKey(`${result.evidence.generated.package_id}@${result.evidence.generated.version}`);
    onChange({ ...config, validation: { testpack: '', library_package: { package_id: result.evidence.generated.package_id,
      package_version: result.evidence.generated.version, target_id: selectedTarget.target_id }, baseline_artifact: '' } });
    setFeedback({ text: `已生成 ${symbols.length || 1} 个待审目标。下一步是分别补齐正确性、benchmark、基线与目标机验证。`, bad: false });
  }
  async function checkReadiness() {
    setCheckResult(null); setCheckGuidance(null);
    if (taskFunction && (mode === 'new' || (mode === 'package' && !selectedPlan) || (mode === 'testpack' && (!config.validation.testpack.trim() || (!targetImportTouched && !targetPlans?.current_testpack))))) {
      setCheckGuidance('plan'); return;
    }
    const saved = await onSave();
    const refreshed = await refreshFacts();
    if (!saved.validation.library_package && !saved.validation.testpack.trim()) {
      setCheckGuidance('plan');
      return;
    }
    if (taskFunction && refreshed.validation?.function_name !== taskFunction) {
      throw new Error(`当前方案的目标与任务函数 ${taskFunction} 不一致，或方案尚无法读取。请选择匹配的方案后重新检查。`);
    }
    if (refreshed.validation && refreshed.validation.evaluator_status !== 'QUALIFIED' && refreshed.validation.evaluator_status !== 'LEGACY') {
      if (refreshed.validation.review_error) throw new Error(refreshed.validation.review_error);
      setCheckGuidance(refreshed.validation.review?.state === 'READY_FOR_REVIEW' ? 'review' : 'draft');
      return;
    }
    const result = await onCheck();
    setCheckResult(result.message);
    setFeedback({ text: '运行前检查已完成。结果显示在按钮下方。', bad: false });
  }
  function continueDraft() {
    const choice = projectDrafts.find(item => item.key === existingDraft);
    if (!choice) return;
    setMode('package'); setPackageKey(`${choice.package.package_id}@${choice.package.version}`);
    setCheckGuidance(null); setFeedback(null);
    onChange({ ...config, validation: { testpack: '', library_package: { package_id: choice.package.package_id,
      package_version: choice.package.version, target_id: choice.target.target_id }, baseline_artifact: '' } });
  }
  function selectTaskPlan() {
    if (!taskPlan) return;
    setPackageKey(`${taskPlan.selection.package_id}@${taskPlan.selection.package_version}`);
    setCheckGuidance(null); setFeedback(null);
    onChange({ ...config, validation: { testpack: '', library_package: taskPlan.selection, baseline_artifact: taskPlan.baseline.artifact_path } });
    if (!packages.some(item => item.package_id === taskPlan.selection.package_id && item.version === taskPlan.selection.package_version)) {
      void request<{ packages: CatalogItem[] }>('/v1/catalog').then(value => setPackages(value.packages))
        .catch(error => setFeedback({ text: `方案已选择，但未能读取其详情：${(error as Error).message}`, bad: true }));
    }
  }
  return <div className="library-setup">
    {feedback && feedbackAction !== 'check' && <Feedback text={feedback.text} bad={feedback.bad} />}
    <fieldset disabled={busy || !!working} className="config-fields library-setup" onChange={() => { setFeedback(null); setCheckResult(null); setCheckGuidance(null); }}>
      {taskFunction ? <div className="validation-modes">
        <div><strong>测试方案</strong><span>按目标函数选择或创建</span></div>
        <div className="validation-mode-options" role="group" aria-label="测试方案方式">
          <button type="button" aria-pressed={mode === 'package'} onClick={() => changeMode('package')}>已有方案{targetPlans?.plans.length ? ` · ${targetPlans.plans.length}` : ''}</button>
          <button type="button" aria-pressed={mode === 'new'} onClick={() => changeMode('new')}>新建方案</button>
          <button type="button" aria-pressed={mode === 'testpack'} onClick={() => changeMode('testpack')}>导入文件</button>
        </div>
        {setup?.validation && setup.validation.function_name !== taskFunction && <p className="validation-mismatch" role="status">已保存方案属于 {setup.validation.function_name}，请为 {taskFunction} 选择方案。</p>}
        {!!targetPlans?.warnings?.length && <details><summary>部分方案读取失败</summary><ul>{targetPlans.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
      </div> : <Panel title="接入当前库"><Field label="验证模式" help="每个库使用自己的编译、测试和 benchmark；已有方案只是可选入口。"><select aria-label="验证模式" value={mode} onChange={e => changeMode(e.target.value as Mode)}>
        <option value="new">为当前库建立接入方案</option><option value="package">选择已有库接入方案</option><option value="testpack">导入测试方案文件（高级）</option>
      </select></Field><p className="hint">接入方案记录本库的构建、测试和性能负载。</p></Panel>}
      {mode === 'new' && !taskFunction && projectDrafts.length > 0 && <div ref={existingDraftsRef}><Panel title="本项目已有接入草稿">
        <p className="hint">这些方案已经为当前项目生成，但尚未绑定到本次配置。选择要继续完善的函数，即可编辑测试脚本和准备比较基线。</p>
        <div className="setup-existing-draft"><Field label="继续哪个函数的接入草稿"><select aria-label="继续哪个函数的接入草稿" value={existingDraft} onChange={event => setExistingDraft(event.target.value)}>
          <option value="" disabled>选择本项目的函数草稿</option>
          {projectDrafts.map(item => <option key={item.key} value={item.key}>{item.name} · {item.package.version}</option>)}
        </select></Field><button type="button" disabled={!existingDraft} onClick={continueDraft}>继续完善所选草稿</button></div>
      </Panel></div>}
      {mode === 'new' && <>
        <Panel title="1. 识别当前源码" aside={<button type="button" onClick={() => void action('inspect', inspect)}>{working === 'inspect' ? '正在识别…' : discovery ? '重新识别源码' : '识别源码与测试资产'}</button>}>
          <p className="hint">识别当前检出源码中的构建与测试线索，不执行构建或测试。</p>
          {discovery && <><p className="hint">任务选择其他分支时，请核对该分支的构建和测试资产。</p><Disclosure title="查看识别详情" summary={time(discovery.inspected_at)} className="setup-status-details"><dl className="definition"><dt>源码版本</dt><dd>{discovery.repository.git_commit?.slice(0, 12) ?? '非 Git 目录'}{discovery.repository.git_dirty ? ' · 工作区有未提交改动' : ''}</dd><dt>源码语言</dt><dd>{discovery.languages.join('、') || '尚未识别'} · {discovery.file_count} 个文件</dd><dt>构建线索</dt><dd>{discovery.build_requirements?.root_builds.map(item => item.path).join('、') || '未发现'}</dd></dl></Disclosure></>}
        </Panel>
      </>}
      {mode !== 'package' && <Panel title={mode === 'new' ? '2. 怎样编译这个库' : '构建命令'}>
        <p className="hint">选择历史命令、推荐命令或自定义。保存不会执行构建。</p>
        <div className="setup-builds">
          <div className="setup-build"><div><strong>最近使用的构建命令</strong>{buildOptions?.recent && <span className={`setup-state ${buildOptions.recent.status === 'SUCCEEDED' ? 'configured' : 'invalid'}`}>{({ SUCCEEDED: '执行成功', FAILED: '执行失败', TIMED_OUT: '执行超时', CANCELLED: '已取消' } as const)[buildOptions.recent.status]}</span>}</div>
            {buildOptions?.recent ? <><code>{buildOptions.recent.command}</code><small>{time(buildOptions.recent.executed_at)}{buildOptions.recent.machine_name ? ` · ${buildOptions.recent.machine_name}` : ''}{buildOptions.recent.source_commit ? ` · ${buildOptions.recent.source_commit.slice(0, 12)}` : ''}</small><button type="button" disabled={!buildOptions.recent.build} onClick={() => { if (buildOptions.recent?.build) { onBuild(buildOptions.recent.build as OptimizationConfig['build']); setCustomBuild(false); } }}>使用最近命令</button>{!buildOptions.recent.build && <small>这条历史记录缺少可安全复用的完整构建配置；可参考命令后自定义。</small>}</> : <p className="hint">这个库还没有实际构建执行记录。</p>}
          </div>
          <div className="setup-build"><div><strong>推荐构建命令</strong><span className="setup-state review">尚未构建验证</span></div>
            {buildOptions?.recommended ? <><code>{buildOptions.recommended.command}</code><small>目标机器：{buildOptions.recommended.machine_name} · {buildOptions.recommended.toolchain.architecture}</small><details><summary>查看推荐依据</summary><ul>{buildOptions.recommended.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>{buildOptions.recommended.evidence.length > 0 && <ul>{buildOptions.recommended.evidence.map(item => <li key={`${item.path}:${item.line}`}><code>{item.path}:{item.line} {item.text}</code></li>)}</ul>}</details><button type="button" onClick={() => { onBuild(buildOptions.recommended!.build); setCustomBuild(false); }}>使用推荐命令</button></> : <p className="hint">{buildOptionsLoading ? '正在读取构建记录与目标机工具链…' : buildOptions?.message ?? '正在准备推荐…'}</p>}
          </div>
        </div>
        <div className="setup-current-build"><strong>当前选择</strong><code>{command || '尚未选择构建命令'}</code><button type="button" onClick={() => setCustomBuild(value => !value)}>{customBuild ? '收起自定义构建' : '自定义构建'}</button></div>
        {customBuild && <div className="setup-custom-build"><Field label="构建命令" help="填写在 Linux 目标机源码工作区执行的完整命令，可分多行，包含首次配置和编译步骤。保存配置不会执行命令。"><textarea aria-label="构建命令" rows={4} value={command} onChange={e => onBuild(commandBuild(e.target.value, config.build))} placeholder="填写项目实际使用的编译命令" /></Field><div className="form-grid"><Field label="构建目录（相对源码根）" help="通常填 .，表示当前候选源码根目录；运行时会使用候选的独立工作区。"><input aria-label="构建目录（相对源码根）" value={config.build.cwd} onChange={e => onBuild({ ...config.build, cwd: e.target.value })} /></Field><Field label="构建超时（秒）"><input type="number" min="1" value={config.build.timeout_ms / 1000} onChange={e => onBuild({ ...config.build, timeout_ms: Number(e.target.value) * 1000 })} /></Field></div></div>}
      </Panel>}
      {mode === 'new' && <Panel title="3. 接入本库的测试与性能测量">
        <div className="setup-asset-grid"><AssetList title="正确性测试线索" files={discovery?.tests ?? []} empty="先识别源码，或准备项目自己的测试程序。" /><AssetList title="性能测试线索" files={discovery?.benchmarks ?? []} empty="准备本库的 benchmark 及输入负载。" /></div>
        <p className="hint">生成草稿后，仍需准备正确性和性能测试并试跑。</p>
        <div ref={functionsRef}>{taskFunction ? <div className="setup-function-heading"><div><strong>任务目标：{taskFunction}</strong><p className="hint">{!discovery ? '先识别当前检出源码，再为该函数建立方案。' : discovery.functions.some(item => item.symbol === taskFunction) ? '已在当前检出源码中识别，可为此函数建立方案。' : '当前检出源码未识别到此函数。请核对函数名、检出版本后重新识别，或返回任务修改目标。'}</p></div></div> : <FunctionPicker functions={discovery?.functions ?? []} selected={selectedSymbols} onChange={onSelectedSymbolsChange} />}</div>
        <div className="form-actions"><button type="button" className={taskFunction ? 'primary' : ''} disabled={!discovery || (!!taskFunction && !discovery.functions.some(item => item.symbol === taskFunction))} onClick={() => void action('draft', createDraft)}>{working === 'draft' ? '正在生成…' : '生成本库接入草稿'}</button></div>
        {draft && <div className="setup-draft"><strong>接入草稿已生成 · {draft.targets.length} 个目标待审阅</strong><p>构建命令、源码范围和发现证据已记录。每个目标有独立验证资产；测试与 benchmark 仍需补齐，草稿不能直接用于正式优化。</p><dl className="definition"><dt>方案 ID</dt><dd>{draft.evidence.generated.package_id}@{draft.evidence.generated.version}</dd><dt>接入包</dt><dd><code>{draft.package_path}</code></dd><dt>目标函数</dt><dd>{draft.targets.map(target => target.symbol ?? '待选函数').join('、')}</dd></dl><details><summary>查看各目标的验证资产</summary><ul>{draft.targets.map(target => <li key={target.target_id}><strong>{target.symbol ?? '待选函数'}</strong><code>{target.evaluator_path}</code></li>)}</ul></details><p className="hint">完成审阅和验证后，可在“选择已有库接入方案”中明确选择本库方案；每次优化任务再选定一个目标。</p></div>}
      </Panel>}
      {mode === 'package' && taskFunction && <div ref={packageRef}><Panel title="选择方案" aside={<button type="button" className="text-btn" onClick={() => void action('plans', async () => { await refreshFacts(); setPackages((await request<{ packages: CatalogItem[] }>('/v1/catalog')).packages); setFeedback({ text: '已重新读取当前函数的方案。', bad: false }); })}>{working === 'plans' ? '正在读取…' : '刷新'}</button>}>
        {targetPlans?.plans.length ? <><div className="setup-existing-draft plan-choice"><Field label="当前函数的测试方案"><select aria-label="当前函数的测试方案" value={planChoice} onChange={event => setPlanChoice(event.target.value)}>
          <option value="" disabled hidden>选择当前函数的方案</option>{targetPlans.plans.map(plan => <option key={planKey(plan.selection)} value={planKey(plan.selection)}>测试{planState(plan.evaluator_state)} · {plan.baseline.artifact_path ? `${plan.baseline.library} ${plan.baseline.version}` : '基线待准备'} · {plan.selection.package_version}</option>)}
        </select></Field><button type="button" className={selectedPlan && planKey(selectedPlan.selection) === planChoice ? '' : 'primary'} disabled={!taskPlan || (selectedPlan && planKey(selectedPlan.selection) === planChoice)} onClick={selectTaskPlan}>{selectedPlan && planKey(selectedPlan.selection) === planChoice ? '当前方案' : '使用所选方案'}</button></div>
        {taskPlan && <div className="plan-facts"><span>测试状态 <strong>{planState(taskPlan.evaluator_state)}</strong></span><span>比较基线 <strong>{taskPlan.baseline.artifact_path ? `${taskPlan.baseline.library} · ${taskPlan.baseline.version}` : '待准备'}</strong></span><span>接入方案 <strong>{planState(taskPlan.package_state)}</strong></span></div>}</> : <div className="plan-empty"><strong>还没有该函数的方案</strong><p>新建方案，或导入已有的测试文件。</p><button type="button" onClick={() => changeMode('new')}>新建方案</button></div>}
        <p className="hint plan-catalog">其他库接入方案：<a href="#/validation">从完整目录选择</a>。保存后可返回任务。</p>
        {selectedPlan && <details className="baseline-manual-path"><summary>高级：手动指定已准备的基线文件</summary><Field label="比较基线文件" help="填写与当前方案一致的固定产物路径。"><input aria-label="比较基线文件" value={config.validation.baseline_artifact ?? ''} onChange={e => onChange({ ...config, validation: { ...config.validation, baseline_artifact: e.target.value } })} /></Field></details>}
      </Panel></div>}
      {mode === 'package' && !taskFunction && <div ref={packageRef}><Panel title="选择已有库接入方案"><div className="form-grid"><Field label="库接入方案" help="请确认库、版本和函数匹配当前项目；不会自动选择目录里的第一个方案。"><select aria-label="库接入方案" value={packageKey} onChange={e => { setPackageKey(e.target.value); onChange({ ...config, validation: { testpack: '' } }); }}><option value="" disabled hidden>选择与当前库匹配的方案</option>{packages.map(p => <option key={`${p.package_id}@${p.version}`} value={`${p.package_id}@${p.version}`}>{p.library_name ?? p.package_id}@{p.version} · {({ DRAFT: '待完善', REVIEWED: '已审阅', QUALIFIED: '已获资格', REJECTED: '已拒绝', SUPERSEDED: '已替代' } as Record<string, string>)[p.qualification.state] ?? p.qualification.state}</option>)}</select></Field>
        <Field label="优化目标"><select aria-label="优化目标" disabled={!selected} value={config.validation.library_package?.target_id ?? ''} onChange={e => selected && onChange({ ...config, validation: { testpack: '', library_package: { package_id: selected.package_id, package_version: selected.version, target_id: e.target.value }, baseline_artifact: '' } })}><option value="" disabled hidden>选择本次要优化的函数</option>{selected?.targets.map(target => <option key={target.target_id} value={target.target_id}>{selected.functions.find(f => f.function_id === target.function_id)?.api ?? target.target_id}</option>)}</select></Field>
        {config.validation.library_package && <details className="baseline-manual-path"><summary>高级：手动指定已准备的基线文件</summary><Field label="比较基线文件" help="日常使用下方“准备比较基线”即可。此处供维护者填写已有固定产物路径，文件身份须与接入方案一致。"><input aria-label="比较基线文件" value={config.validation.baseline_artifact ?? ''} onChange={e => onChange({ ...config, validation: { ...config.validation, baseline_artifact: e.target.value } })} /></Field></details>}
      </div><p className="hint">构建方式、测试用例、负载与接受阈值由该接入方案提供。DRAFT 表示待完善，不会因被选择而自动获得资格。</p></Panel></div>}
      {mode === 'package' && draft && <div className="setup-draft"><strong>接入草稿已生成 · {draft.targets.length} 个目标待审阅</strong>
        <p>{taskFunction ? '已选择当前任务目标，继续补齐并试跑它的验证脚本。' : '已自动选择第一个目标。可以在上方切换目标，分别补齐并试跑其验证脚本。'}</p>
        <ul>{draft.targets.map(target => <li key={target.target_id}>{target.symbol ?? '待确认函数'} · {target.target_id}</li>)}</ul></div>}
      {mode === 'package' && targetSelectionMatches && selected && ['DRAFT', 'REVIEWED'].includes(selected.qualification.state) && selected.targets.find(target => target.target_id === config.validation.library_package?.target_id)?.evaluator.qualification !== 'QUALIFIED' && selected.package_id === `project-${projectId.slice(0, 8)}` &&
        config.validation.library_package?.target_id && <Panel title="准备比较基线"><BaselinePicker
          key={`${projectId}/${config.validation.library_package.package_id}/${config.validation.library_package.package_version}/${config.validation.library_package.target_id}`}
          projectId={projectId} packageId={selected.package_id} version={selected.version}
          targetId={config.validation.library_package.target_id} baselineArtifact={config.validation.baseline_artifact ?? ''}
          onBound={value => { onBoundConfig(value); void refreshFacts().catch(error => setFeedback({ text: `基线已绑定，但刷新方案状态失败：${(error as Error).message}`, bad: true })); }} /></Panel>}
      {mode === 'package' && targetSelectionMatches && selected && selected.package_id === `project-${projectId.slice(0, 8)}` &&
        config.validation.library_package?.target_id && <div ref={scriptsRef}><Panel title="测试条件与代码"><ValidationAssetsEditor
          key={`${projectId}/${selected.package_id}@${selected.version}:${config.validation.library_package.target_id}`}
          projectId={projectId} packageId={selected.package_id} version={selected.version}
          contextKey={`${machineId}/${config.validation.baseline_artifact ?? ''}`} onPrepare={onSave} reviewRequest={reviewRequest} validationDrafts={validationDrafts}
          onReviewed={async () => { setPackages((await request<{ packages: CatalogItem[] }>('/v1/catalog')).packages); await action('check', checkReadiness); }}
          targetId={config.validation.library_package.target_id} /></Panel></div>}
      {mode === 'testpack' && <Panel title="导入本库已有测试方案"><Field label="测试方案文件（testpack）" help="CorePilot 后端能够读取的 YAML / JSON 文件，须包含本次函数的正确性、性能、基线和采样定义。普通 ctest 配置或 benchmark 输出不能直接当作该文件。"><input value={!taskFunction || targetImportTouched || targetPlans?.current_testpack ? config.validation.testpack : ''} onChange={e => { setTargetImportTouched(true); onChange({ ...config, validation: { testpack: e.target.value } }); }} placeholder="填写实际测试方案路径" /></Field>{taskFunction && <p className="hint">保存并检查时会核对测试方案是否属于当前目标函数。</p>}</Panel>}
      <Panel title="运行前检查">{!differentSavedFunction && <div className="setup-status-line"><strong>{setup ? setup.checks.filter(item => item.state === 'CONFIGURED').length + ' / ' + setup.checks.length + ' 项已配置' : '正在读取接入状态…'}</strong><p>{setup?.checks.some(item => item.state !== 'CONFIGURED') ? '待完成：' + setup.checks.filter(item => item.state !== 'CONFIGURED').map(item => item.title).join('、') : '配置完成不代表测试通过。'}</p></div>}
        <Disclosure title={differentSavedFunction ? `查看已保存的 ${setup?.validation?.function_name} 方案检查` : '查看接入检查明细'} summary="构建、正确性、性能、基线和方案资格" className="setup-status-details"><div className="setup-checks">{setup?.checks.map(check => <div key={check.id} className="setup-check"><div><strong>{check.title}</strong><span className={`setup-state ${check.state === 'CONFIGURED' ? 'configured' : check.state === 'INVALID' ? 'invalid' : 'review'}`}>{{ MISSING: '待配置', CONFIGURED: '已配置', NEEDS_REVIEW: '待审阅与验证', INVALID: '需要修正' }[check.state]}</span></div><p>{check.message}</p></div>)}</div></Disclosure>
        <div className="form-actions"><button type="button" disabled={!!taskFunction && (mode === 'new' || (mode === 'package' && !selectedPlan) || (mode === 'testpack' && (!config.validation.testpack.trim() || (!targetImportTouched && !targetPlans?.current_testpack))))} onClick={() => void action('save', async () => { await onSave(); await refreshFacts(); setFeedback({ text: '配置已保存；请按接入状态补齐未完成项。', bad: false }); })}>{working === 'save' ? '正在保存…' : '保存配置'}</button><button type="button" className={taskFunction && (mode === 'new' || mode === 'package' && !selectedPlan) ? '' : 'primary'} onClick={() => void action('check', checkReadiness)}>{working === 'check' ? '正在检查配置与机器…' : '保存并运行前检查'}</button></div>
        {working === 'check' && <p className="setup-check-progress" role="status">正在核对已保存配置、验证资产、基线和执行机器…</p>}
        {feedback && feedbackAction === 'check' && <div className="setup-check-feedback"><Feedback text={feedback.text} bad={feedback.bad} /></div>}
        {checkGuidance && <div className="setup-check-pending" role="status"><strong>{checkGuidance === 'plan' ? (taskFunction ? '尚未选择与当前任务匹配的验证方案' : '配置已保存，尚未建立本次优化的验证方案') : checkGuidance === 'review' ? '试跑已通过，请确认测试方案用于正式优化' : '配置已保存，验证草稿还需完善'}</strong>
          <p>{checkGuidance === 'review' ? `正确性 ${setup?.validation?.review?.trial?.correctness_passed}/${setup?.validation?.review?.trial?.correctness_planned} 通过，性能样本 ${setup?.validation?.review?.trial?.performance_measured}/${setup?.validation?.review?.trial?.performance_planned} 齐全。无需重新生成脚本；查看这次试跑并确认测试方案后，系统继续运行前检查。`
            : checkGuidance === 'draft' ? setup?.validation?.review?.state === 'NEEDS_TRIAL'
              ? '在本页用 AI 起草、上传或编辑正确性与性能脚本，准备比较基线，再到 Runner 试跑。通过后即可审阅并启用这版测试方案。'
              : setup?.validation?.review?.blockers.join(' ') || '在本页准备正确性与性能代码、比较基线，并在 Runner 上试跑。通过后可审阅并启用测试方案。'
            : mode === 'package' ? '请在“选择已有库接入方案”中选定方案和优化目标。只选择方案名称还没有绑定函数。'
            : mode === 'testpack' ? '请填写你已有的测试方案文件；也可以切换到“为当前库建立接入方案”，通过页面准备测试脚本。'
            : taskFunction ? discovery && !discovery.functions.some(item => item.symbol === taskFunction) ? `当前检出源码未识别到 ${taskFunction}。请核对源码与函数名后重新识别。` : `为 ${taskFunction} 生成接入草稿；随后可以在本页起草或上传测试代码。`
            : '先选择要优化的函数，再生成本库接入草稿；之后就能在本页让 AI 起草或上传测试脚本，无需手写 testpack 文件。'}</p>
          <div className="form-actions">
            {checkGuidance === 'plan' && mode === 'new' && !taskFunction && projectDrafts.length > 0 && <button type="button" onClick={() => existingDraftsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>继续本项目已有草稿</button>}
            {checkGuidance === 'plan' && mode === 'new' && !!taskFunction && !!targetPlans?.plans.length && <button type="button" onClick={() => changeMode('package')}>查看当前函数已有方案</button>}
            {checkGuidance === 'plan' && mode === 'new' && !discovery && <button type="button" onClick={() => void action('inspect', inspect)}>开始识别本库源码</button>}
            {checkGuidance === 'plan' && mode === 'new' && discovery && !selectedSymbols.length && !taskFunction && <button type="button" onClick={() => { functionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); functionsRef.current?.querySelector('input')?.focus(); }}>选择要优化的函数</button>}
            {checkGuidance === 'plan' && mode === 'new' && discovery && (taskFunction ? discovery.functions.some(item => item.symbol === taskFunction) : selectedSymbols.length > 0) && <button type="button" onClick={() => void action('draft', createDraft)}>生成所选函数的接入草稿</button>}
            {checkGuidance === 'plan' && mode === 'package' && <button type="button" onClick={() => packageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>选择方案与优化目标</button>}
            {(checkGuidance === 'draft' || checkGuidance === 'review') && scriptsRef.current && <button type="button" onClick={() => { setReviewRequest(value => value + 1); scriptsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{checkGuidance === 'review' ? '查看试跑并确认测试方案' : '查看测试方案与试跑'}</button>}
          </div>
        </div>}
        {checkResult && <pre className="setup-check-output" aria-label="运行前检查结果">{checkResult}</pre>}
      </Panel>
    </fieldset>
    <Disclosure title="了解构建与验证" summary="构建、正确性、性能与基线的作用" className="setup-help"><div className="setup-explanation"><div className="setup-explanation-grid">
      <div><b>构建</b><p>将源码编译为待测试的库或程序。</p></div>
      <div><b>正确性</b><p>使用独立参考检查计算结果。</p></div>
      <div><b>性能</b><p>在指定负载和机器条件下测量。</p></div>
      <div><b>比较基线</b><p>在相同条件下与参考版本比较。</p></div>
    </div></div></Disclosure>
  </div>;
}
const MAX_SELECTED_FUNCTIONS = 50;
const FUNCTION_PAGE_SIZE = 20;

function FunctionPicker({ functions, selected, onChange }: {
  functions: FunctionCandidate[]; selected: string[]; onChange: (symbols: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'all' | 'selected'>('all');
  const [visibleCount, setVisibleCount] = useState(FUNCTION_PAGE_SIZE);
  const selectedSet = new Set(selected);
  const normalized = query.trim().toLocaleLowerCase();
  function matchRank(item: FunctionCandidate): number {
    if (!normalized) return 0;
    const name = item.symbol.toLocaleLowerCase();
    if (name === normalized) return 0;
    if (name.startsWith(normalized)) return 1;
    if (name.includes(normalized) || item.public_api.toLocaleLowerCase().includes(normalized)) return 2;
    if (item.header?.toLocaleLowerCase().includes(normalized)) return 3;
    return item.implementation_files.some(file => file.toLocaleLowerCase().includes(normalized)) ? 4 : -1;
  }
  const matching = functions.map((item, index) => ({ item, index, rank: matchRank(item) }))
    .filter(({ item, rank }) => rank >= 0 && (view === 'all' || selectedSet.has(item.symbol)))
    .sort((left, right) => left.rank - right.rank || left.index - right.index).map(({ item }) => item);
  const visible = matching.slice(0, visibleCount);
  const selectableVisible = visible.filter(item => !selectedSet.has(item.symbol)).slice(0, MAX_SELECTED_FUNCTIONS - selected.length);
  const unselected = matching.filter(item => !selectedSet.has(item.symbol));
  const canSelectMatching = unselected.length > 0 && selected.length + unselected.length <= MAX_SELECTED_FUNCTIONS;
  function toggle(symbol: string) {
    onChange(selectedSet.has(symbol) ? selected.filter(item => item !== symbol) : selected.length < MAX_SELECTED_FUNCTIONS ? [...selected, symbol] : selected);
  }
  function changeQuery(value: string) { setQuery(value); setVisibleCount(FUNCTION_PAGE_SIZE); }
  function changeView(value: 'all' | 'selected') { setView(value); setVisibleCount(FUNCTION_PAGE_SIZE); }
  return <div className="setup-function-picker" aria-label="要优化的函数">
    <div className="setup-function-heading"><div><strong>要优化的函数</strong><p className="hint">从当前源码识别出的公开 API 中选择。可批量建立接入草稿；后续每次优化任务选择一个目标。留空会生成待选目标。</p></div><span className="setup-function-count" aria-live="polite">已选 {selected.length} / {MAX_SELECTED_FUNCTIONS}</span></div>
    <div className="setup-function-search"><label htmlFor="setup-function-query">搜索函数、头文件或实现文件</label><input id="setup-function-query" type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder="输入名称或文件路径筛选" disabled={!functions.length} /></div>
    <div className="setup-function-controls"><div className="setup-function-tabs" role="group" aria-label="函数列表"><button type="button" aria-pressed={view === 'all'} onClick={() => changeView('all')}>全部函数 · {functions.length}</button><button type="button" aria-pressed={view === 'selected'} onClick={() => changeView('selected')}>已选函数 · {selected.length}</button></div><div className="setup-function-actions"><button type="button" disabled={!selectableVisible.length} onClick={() => onChange([...selected, ...selectableVisible.map(item => item.symbol)])}>选中显示的 {selectableVisible.length} 项</button><button type="button" disabled={!canSelectMatching} onClick={() => onChange([...selected, ...unselected.map(item => item.symbol)])}>选中筛选结果</button><button type="button" disabled={!selected.length} onClick={() => onChange([])}>清空已选</button></div></div>
    {unselected.length > 0 && !canSelectMatching && <p className="setup-function-limit">当前筛选匹配 {unselected.length} 个未选函数，超过剩余名额。可先选中当前显示的函数，或缩小搜索范围。</p>}
    <div className="setup-function-list">
      {!functions.length ? <p className="setup-function-empty">{view === 'selected' ? '尚未选择函数。' : '还没有发现公开函数。先识别源码；如果当前语言暂不支持 API 识别，可生成待选草稿。'}</p> : !matching.length ? <p className="setup-function-empty">{view === 'selected' ? '已选函数中没有匹配结果。' : '没有匹配的公开函数，请调整搜索词。'}</p> : visible.map(item => <label className="setup-function-row" key={item.symbol}>
        <input type="checkbox" aria-label={`选择函数 ${item.symbol}`} checked={selectedSet.has(item.symbol)} disabled={!selectedSet.has(item.symbol) && selected.length >= MAX_SELECTED_FUNCTIONS} onChange={() => toggle(item.symbol)} />
        <span className="setup-function-info"><strong>{item.symbol}</strong><small>{item.header ?? '头文件待确认'}{item.implementation_files.length ? ` · ${item.implementation_files.length} 个实现文件` : ' · 实现文件待确认'}</small></span><span className={`setup-function-confidence ${item.confidence.toLowerCase()}`}>{{ HIGH: '高可信', MEDIUM: '待核对', LOW: '低可信' }[item.confidence]}</span>
      </label>)}
    </div>
    <div className="setup-function-footer"><span>显示 {Math.min(visibleCount, matching.length)} / {matching.length} 个匹配函数</span>{matching.length > visibleCount && <button type="button" onClick={() => setVisibleCount(count => count + FUNCTION_PAGE_SIZE)}>显示更多</button>}</div>
  </div>;
}
function AssetList({ title, files, empty }: { title: string; files: string[]; empty: string }) {
  return <div><strong>{title} · {files.length}</strong>{files.length ? <details><summary>查看发现的资产</summary><ul>{files.slice(0, 30).map(file => <li key={file}><code>{file}</code></li>)}</ul>{files.length > 30 && <p className="hint">仅展示前 30 项，完整证据保存在接入调查中。</p>}</details> : <p className="hint">{empty}</p>}</div>;
}
