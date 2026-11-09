import React, { useEffect, useState } from 'react';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import type { ProjectRecord } from '../../src/contracts/project';
import { MODEL_SOURCES } from '../../src/model/model-sources';
import { request } from './api';
import { Field, Panel, Badge, Feedback, Disclosure, CopyValue } from './components';
import { useModelDiscovery } from './useModelDiscovery';
import { MachinePicker } from './MachinePicker';
import { BuildValidation } from './BuildValidation';
import type { TaskPreparationContext } from './TaskComposer';
import type { ProjectSetup, ProjectValidationPlans } from '../../src/contracts/project-setup';
import type { ValidationEditorDraft } from './ValidationAssetsEditor';

export interface CatalogItem { package_id: string; version: string; library_name?: string; qualification: { state: string }; functions: Array<{ function_id: string; api: string }>; targets: Array<{ target_id: string; function_id: string; evaluator: { evaluator_id: string; evaluator_version: string; qualification?: string } }> }
export interface ConfigDraft { config: OptimizationConfig; args: string; advanced: string; section: string; saved: string; selectedSymbols?: string[] }

function readDraft(config: OptimizationConfig, args: string, advanced: string, section: string): OptimizationConfig {
  let next: OptimizationConfig;
  try { next = section === 'advanced' ? JSON.parse(advanced) : { ...config, build: { ...config.build, args: JSON.parse(args) } }; }
  catch { throw new Error(section === 'advanced' ? '高级配置 JSON 格式错误，请修正后重试' : '构建参数必须是 JSON 字符串数组，例如 ["--build", "build"]'); }
  if (!next?.model || !next.target || !next.build || !next.validation) throw new Error('配置必须包含 model、target、build 和 validation');
  if (next.validation.testpack !== undefined && typeof next.validation.testpack !== 'string') throw new Error('测试方案文件路径必须是字符串');
  next.validation.testpack ??= '';
  if (!Array.isArray(next.build.args) || !next.build.args.every((item: unknown) => typeof item === 'string')) throw new Error('构建参数必须是 JSON 字符串数组');
  return next;
}

export function Configuration({ project, catalog, refresh, drafts, validationDrafts, manageMachines, openValidation, mode, preparation }: { project: ProjectRecord; catalog: CatalogItem[]; notify: (text: string, bad?: boolean) => void; refresh: () => void; drafts: Map<string, ConfigDraft>; validationDrafts?: Map<string, ValidationEditorDraft>; manageMachines: () => void; openValidation: () => void; mode: 'settings' | 'validation'; preparation?: { task: TaskPreparationContext; plans: ProjectValidationPlans | null; setup: ProjectSetup } }) {
  const [{ initial, initialError }] = useState(() => {
    const draft = drafts.get(project.project_id);
    if (mode !== 'validation' || draft?.section !== 'advanced') return { initial: draft, initialError: '' };
    try {
      const config = readDraft(draft.config, draft.args, draft.advanced, 'advanced');
      return { initial: { ...draft, config, args: JSON.stringify(config.build.args) }, initialError: '' };
    } catch (error) { return { initial: draft, initialError: (error as Error).message }; }
  });
  const [config, setConfig] = useState<OptimizationConfig | null>(initial?.config ?? null);
  const [busy, setBusy] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const [section, setSection] = useState(mode === 'validation' ? initialError ? 'advanced' : 'validation' : initial?.section === 'validation' ? 'model' : initial?.section ?? 'model');
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(initial?.selectedSymbols ?? []);
  const [args, setArgs] = useState(initial?.args ?? '[]');
  const [advanced, setAdvanced] = useState(initial?.advanced ?? '');
  const [saved, setSaved] = useState(initial?.saved ?? '');
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(initialError ? { text: initialError, bad: true } : null);
  const [action, setAction] = useState('');
  const discovery = useModelDiscovery(project.project_id, config ? { endpoint: config.model.endpoint, api_key: config.model.api_key ?? '', proxy: config.model.proxy ?? '' } : null, section === 'model');
  const dirty = !!config && (JSON.stringify(config) !== saved || args !== JSON.stringify(config.build.args) || (section === 'advanced' && advanced !== JSON.stringify(config, null, 2)));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => {
    if (initial && reload === 0) return;
    setConfig(null); setLoadError(''); let cancelled = false;
    request<{ config: OptimizationConfig }>(`/v1/projects/${project.project_id}/config`).then(data => {
      if (!cancelled) { setConfig(data.config); setSaved(JSON.stringify(data.config)); setArgs(JSON.stringify(data.config.build.args)); setAdvanced(JSON.stringify(data.config, null, 2)); }
    }).catch(e => { if (!cancelled) setLoadError(e.message); });
    return () => { cancelled = true; };
  }, [project.project_id, reload]);
  useEffect(() => {
    if (config && (dirty || selectedSymbols.length)) drafts.set(project.project_id, { config, args, advanced, section, saved, selectedSymbols });
    else if (config) drafts.delete(project.project_id);
  }, [config, args, advanced, section, saved, dirty, selectedSymbols, drafts, project.project_id]);
  function currentConfig(): OptimizationConfig {
    if (!config) throw new Error('配置未加载');
    return readDraft(config, args, advanced, section);
  }
  function changeSection(next: string) {
    if (next === section) return;
    try {
      const current = currentConfig();
      setConfig(current); setArgs(JSON.stringify(current.build.args)); setAdvanced(JSON.stringify(current, null, 2)); setSection(next); setFeedback(null);
    } catch (e) { setFeedback({ text: (e as Error).message, bad: true }); }
  }
  async function save() {
    const next = currentConfig();
    const data = await request<{ config: OptimizationConfig }>(`/v1/projects/${project.project_id}/config`, 'PUT', { config: next });
    setConfig(data.config); setSaved(JSON.stringify(data.config)); setArgs(JSON.stringify(data.config.build.args)); setAdvanced(JSON.stringify(data.config, null, 2)); drafts.delete(project.project_id); refresh(); return data.config;
  }
  function boundConfig(persisted: OptimizationConfig) {
    // Binding a baseline saves the validation selection on the server. Keep
    // unrelated model, machine and build edits as unsaved local input.
    setConfig(current => current && ({ ...current, validation: persisted.validation }));
    setSaved(JSON.stringify(persisted));
    refresh();
  }
  async function run(action: string) {
    setBusy(true); setAction(action); setFeedback(null);
    try {
      await save();
      if (action === 'save') { setFeedback({ text: '配置已保存；新配置用于后续任务。', bad: false }); return; }
      const result = await request<Record<string, unknown>>(`/v1/projects/${project.project_id}/${action}`, 'POST', {});
      setFeedback({ text: String(result.error ?? result.message ?? (action === 'model-test' ? '模型工具调用验证通过' : '检查通过')), bad: result.ok === false });
    } catch (e) { setFeedback({ text: (e as Error).message, bad: true }); } finally { setBusy(false); setAction(''); }
  }
  if (loadError) return <Panel title="配置暂时无法读取"><Feedback text={loadError} bad /><div className="form-actions"><button onClick={() => setReload(n => n + 1)}>重新读取配置</button></div></Panel>;
  if (!config) return <div className="loading" role="status">正在读取项目配置…</div>;
  const model = (key: string, value: unknown) => setConfig(c => c && ({ ...c, model: { ...c.model, [key]: value } }));
  const customEndpoint = !MODEL_SOURCES.some(source => source.id !== 'custom' && source.endpoint === config.model.endpoint);
  const modelAdvancedSummary = [config.model.proxy ? '代理已配置' : '直连', '推理强度：' + (config.model.reasoning_effort || '默认')].join(' · ');
  return <div className={`config-layout ${mode === 'validation' ? 'validation-layout' : ''}`}>{mode === 'settings' && <div className="section-nav" aria-label="项目设置分类">{[['model', '模型连接'], ['machine', '目标机器'], ['project', '项目信息'], ['advanced', '高级配置']].map(([id, title]) => <button key={id} disabled={busy} aria-pressed={section === id} className={section === id ? 'active' : ''} onClick={() => changeSection(id)}>{title}</button>)}<p>保存后供网页和 CLI 共用，仅影响后续任务。</p></div>}<div>
    {(dirty || busy) && <div className="config-state" role="status"><span>{busy ? (action === 'save' ? '正在保存配置…' : '正在保存配置并检查连接与结果…') : '有未保存的更改'}</span>{dirty && !busy && <button className="text-btn" onClick={() => { drafts.delete(project.project_id); setSelectedSymbols([]); setFeedback(null); if (mode === 'validation') setSection('validation'); setReload(n => n + 1); }}>放弃更改并重新读取</button>}</div>}
    {feedback && <Feedback text={feedback.text} bad={feedback.bad} />}
    <fieldset disabled={busy} className="config-fields" onChange={() => setFeedback(null)}>
    {section === 'model' && <Panel title="模型连接" aside={<span className="muted">支持自定义兼容接口</span>}><div className="form-grid">
      <Field label="模型来源"><select value={MODEL_SOURCES.find(s => s.endpoint === config.model.endpoint)?.id ?? 'custom'} onChange={e => {
        const source = MODEL_SOURCES.find(s => s.id === e.target.value);
        const endpoint = source?.endpoint ?? '';
        const stored = saved ? (JSON.parse(saved) as OptimizationConfig).model : undefined;
        setManualModelId(false);
        setConfig(c => c && ({ ...c, model: { ...c.model, endpoint, model_id: '', api_key: stored?.endpoint === endpoint ? stored.api_key : undefined } }));
      }}>{MODEL_SOURCES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
      {customEndpoint && <Field label="Endpoint"><input value={config.model.endpoint} onChange={e => model('endpoint', e.target.value)} placeholder="https://example.com/v1" /></Field>}
      <Field label="API Key" help="保留掩码表示不修改；也支持 ${ENV_VAR} 引用。"><input type="password" autoComplete="off" value={config.model.api_key ?? ''} onChange={e => model('api_key', e.target.value)} placeholder="输入新 Key 或环境变量引用" /></Field>
      <div><Field label={<>模型 ID{discovery.models.length > 0 && !manualModelId && <span className="field-label-hint" aria-hidden="true">请选择模型 ID</span>}</>}>{discovery.models.length > 0 && !manualModelId
        ? <select value={config.model.model_id} onChange={e => model('model_id', e.target.value)}>
          <option value="" disabled hidden />
          {config.model.model_id && !discovery.models.some(m => m.id === config.model.model_id) && <option value={config.model.model_id}>{config.model.model_id}（当前填写）</option>}
          {discovery.models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
        : <input value={config.model.model_id} onChange={e => model('model_id', e.target.value)} placeholder={discovery.loading ? '正在加载可用模型…' : '输入模型 ID'} />}</Field>
        {discovery.models.length > 0 && <button type="button" className="text-btn" onClick={() => setManualModelId(value => !value)}>{manualModelId ? '从模型列表选择' : '手动输入模型 ID'}</button>}
      </div>
    </div><div className="model-list-status"><p className="hint model-discovery" aria-live="polite">{discovery.loading ? '正在加载模型…' : discovery.error ? `模型列表未加载：${discovery.error} 可手动输入模型 ID。` : `已加载 ${discovery.models.length} 个模型`}</p><button className="text-btn" disabled={busy || discovery.loading} onClick={discovery.refresh}>{discovery.loading ? '正在加载…' : '刷新列表'}</button></div>
      <Disclosure title="高级连接与诊断" summary={modelAdvancedSummary} modified={!!config.model.proxy || !!config.model.reasoning_effort} className="model-advanced">
        <div className="form-grid">{!customEndpoint && <Field label="Endpoint"><input value={config.model.endpoint} onChange={e => model('endpoint', e.target.value)} placeholder="https://example.com/v1" /></Field>}
          <Field label="模型代理（可选）"><input value={config.model.proxy ?? ''} onChange={e => model('proxy', e.target.value || undefined)} placeholder="http://127.0.0.1:7890" /></Field>
          <Field label="推理强度"><select value={config.model.reasoning_effort ?? ''} onChange={e => model('reasoning_effort', e.target.value || undefined)}>{['', 'minimal', 'low', 'medium', 'high'].map(v => <option key={v} value={v}>{v || '默认'}</option>)}</select></Field></div>
        <p className="hint">验证工具调用会保存当前配置并向所选模型发送一次验证请求。模型列表可用不代表工具调用已经验证。</p><button disabled={busy} onClick={() => void run('model-test')}>验证工具调用</button>
      </Disclosure><div className="form-actions"><span className="hint">{dirty ? '保存以用于后续任务。正在执行的任务沿用原配置。' : '当前使用已保存的模型配置。'}</span><button className="primary" disabled={busy} onClick={() => void run('save')}>保存配置</button></div></Panel>}
    {section === 'machine' && <MachinePicker runner={config.runner} onChange={runner => setConfig(c => c && ({ ...c, runner }))} onSave={() => void run('save')} busy={busy} manage={manageMachines} />}
    {section === 'project' && <Panel title="项目信息"><dl className="definition"><dt>项目名称</dt><dd>{project.name}</dd><dt>默认分支</dt><dd>{project.source_branch ?? '当前检出版本'}</dd><dt>源码目录</dt><dd><CopyValue value={project.repository_root} label="源码目录" /></dd><dt>配置文件</dt><dd><CopyValue value={project.config_path} label="配置路径" /></dd></dl><p className="hint">任务可以选择其他分支和机器。构建命令、基线和测试条件统一在「构建与验证」维护。</p><button type="button" onClick={openValidation}>前往构建与验证</button></Panel>}
    {section === 'validation' && <BuildValidation projectId={project.project_id} config={config} catalog={catalog} selectedSymbols={selectedSymbols} onSelectedSymbolsChange={setSelectedSymbols} validationDrafts={validationDrafts} preparation={preparation} busy={busy} onChange={setConfig} onBuild={build => { setConfig(c => c && ({ ...c, build })); setArgs(JSON.stringify(build.args)); }} onBoundConfig={boundConfig} onSave={async () => { setBusy(true); setAction('save'); setFeedback(null); try { return await save(); } finally { setBusy(false); setAction(''); } }} onCheck={async () => { setBusy(true); setAction('check'); setFeedback(null); try { return await request<{ message: string }>(`/v1/projects/${project.project_id}/check`, 'POST', {}); } finally { setBusy(false); setAction(''); } }} />}
    {section === 'advanced' && <Panel title="开发者高级配置"><p className="hint">{mode === 'validation' ? '高级配置草稿尚未应用。请修正后继续构建与验证，或放弃更改并重新读取服务器配置。' : '供维护者管理底层运行环境，与 CLI 共用同一份配置。日常模型与 Runner 连接请使用对应页面；修改仅影响后续任务，掩码保留原凭据。'}</p><textarea aria-label="高级配置 JSON" className="json-editor" value={advanced} onChange={e => setAdvanced(e.target.value)} /><div className="form-actions"><Badge value="DRAFT">项目配置</Badge>{mode === 'validation' ? <button className="primary" disabled={busy} onClick={() => changeSection('validation')}>应用并继续构建与验证</button> : <button className="primary" disabled={busy} onClick={() => void run('save')}>保存配置</button>}</div></Panel>}
    </fieldset>
  </div></div>;
}
