import React, { useEffect, useState } from 'react';
import type { ProjectRecord, RepositoryInspection } from '../../src/contracts/project';
import type { OptimizationConfig } from '../../src/config/optimization-config';
import { request } from './api';
import { Feedback, Field } from './components';
import { displayBuildCommand, isolatedWorkspaceBuild, isolateCmakeBuildCommand } from '../../src/config/build-command';
import type { ValidationCommand } from '../../src/contracts/validation-testpack';
import type { RunnerExecutionOutput } from '../../src/contracts/runner-rpc';
import type { ValidationPreparationContext } from '../../src/contracts/validation-assets';
import { ExternalBaselineImport } from './ExternalBaselineImport';

interface BuildRecord { trial_id: string; package_id: string; package_version: string; target_id: string; purpose: string;
  source_branch: string | null; source_commit: string; created_at: string; machine_name?: string;
  build?: ValidationCommand; build_definition?: ValidationCommand; remote_workspace?: { run_root: string; source_root: string; build_root: string; logs_root: string; artifacts_root: string; metadata_path: string };
  preparation?: { state: string; phase?: string; message: string | null }; source_archive?: { bytes: number; sha256: string } }
interface TrialStatus { trial?: BuildRecord; status: { status: string; current_step?: string | null; failure?: { message: string } | null };
  output?: RunnerExecutionOutput | null;
  commands: Array<{ step: string; exit_code: number | null; stdout: string; stderr: string }> }

export function BaselinePicker({ projectId, packageId, version, targetId, baselineArtifact, onBound }: {
  projectId: string; packageId: string; version: string; targetId: string; baselineArtifact: string;
  onBound: (config: OptimizationConfig) => void;
}) {
  const [repository, setRepository] = useState<RepositoryInspection | null>(null);
  const [branch, setBranch] = useState('');
  const [trialId, setTrialId] = useState('');
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const [history, setHistory] = useState<BuildRecord[]>([]);
  const [artifact, setArtifact] = useState('');
  const [buildSettings, setBuildSettings] = useState<ValidationPreparationContext | null>(null);
  const [source, setSource] = useState<'branch' | 'external'>('branch');
  const [changing, setChanging] = useState(false);
  const [buildCommand, setBuildCommand] = useState('');
  const [buildCwd, setBuildCwd] = useState('.');
  const assetsUrl = `/v1/projects/${encodeURIComponent(projectId)}/validation-assets/${encodeURIComponent(packageId)}/${encodeURIComponent(version)}/${encodeURIComponent(targetId)}`;
  const [working, setWorking] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; bad: boolean } | null>(null);
  function applyBuildDefinition(definition: ValidationCommand) {
    const build = isolatedWorkspaceBuild(definition);
    setBuildCommand(displayBuildCommand(build)); setBuildCwd(build.cwd);
  }
  useEffect(() => {
    let active = true;
    setBuildSettings(null); setTrialId(''); setTrial(null); setHistory([]); setArtifact('');
    Promise.all([
      request<ValidationPreparationContext>(`${assetsUrl}/context`),
      request<{ trials: BuildRecord[] }>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials`),
      request<{ project: ProjectRecord }>(`/v1/projects/${encodeURIComponent(projectId)}`).then(async ({ project }) => ({ project,
        repository: await request<RepositoryInspection>(`/v1/repository?path=${encodeURIComponent(project.repository_root)}`) })),
    ]).then(([context, result, source]) => {
      if (!active) return;
      const builds = result.trials.filter(item => item.package_id === packageId && item.package_version === version &&
        item.target_id === targetId && item.purpose === 'BASELINE_BUILD');
      const selectedBranch = source.repository.branches.find(item => item.name === builds[0]?.source_branch)?.name
        ?? source.repository.branches.find(item => item.name === source.project.source_branch)?.name ?? source.repository.branches[0]?.name ?? '';
      const latest = builds.find(item => item.source_branch === selectedBranch);
      const previous = latest?.build_definition ?? context.build;
      setBuildSettings(context); applyBuildDefinition(previous);
      setSource(context.baseline.source_kind === 'upload' ? 'external' : 'branch');
      setRepository(source.repository); setBranch(selectedBranch); setHistory(builds);
      if (latest) setTrialId(latest.trial_id);
    })
      .catch(error => { if (active) setFeedback({ text: error.message, bad: true }); });
    return () => { active = false; };
  }, [projectId, packageId, version, targetId]);
  useEffect(() => {
    if (!trialId) return;
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await request<TrialStatus>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials/${encodeURIComponent(trialId)}`);
        if (!active) return;
        setTrial(result);
        if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'].includes(result.status.status)) timeout = setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (active) {
          setFeedback({ text: `读取分支构建失败，将自动重试：${(error as Error).message}`, bad: true });
          timeout = setTimeout(() => void poll(), 5000);
        }
      }
    }
    void poll();
    return () => { active = false; if (timeout) clearTimeout(timeout); };
  }, [projectId, trialId]);
  useEffect(() => {
    const artifacts = trial?.output?.artifacts ?? [];
    if (!artifact || !artifacts.some(item => item.relative_path === artifact)) setArtifact(artifacts.length === 1 ? artifacts[0].relative_path : '');
  }, [trial?.output?.artifacts]);
  async function run(name: string, work: () => Promise<void>) {
    setWorking(name); setFeedback(null);
    try { await work(); } catch (error) { setFeedback({ text: (error as Error).message, bad: true }); }
    finally { setWorking(''); }
  }
  async function buildBranch() {
    if (!buildSettings) throw new Error('请等待构建设置读取完成');
    const command = isolateCmakeBuildCommand(buildCommand, buildCwd);
    setBuildCommand(command);
    const result = await request<{ trial_id: string }>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials`, 'POST',
      { package_id: packageId, package_version: version, target_id: targetId, source_branch: branch, purpose: 'BASELINE_BUILD',
        build: { command, cwd: buildCwd }, expected_package_digest: buildSettings.package_digest });
    setTrialId(result.trial_id); setTrial(null);
    setArtifact('');
    setHistory((await request<{ trials: BuildRecord[] }>(`/v1/projects/${encodeURIComponent(projectId)}/validation-trials`)).trials
      .filter(item => item.package_id === packageId && item.package_version === version && item.target_id === targetId && item.purpose === 'BASELINE_BUILD'));
    setFeedback({ text: `已在执行机器上提交分支 ${branch} 的构建，任务 ID：${result.trial_id}`, bad: false });
  }
  function chooseBranch(value: string) {
    setBranch(value); setTrialId(''); setTrial(null); setArtifact('');
    const latest = history.find(item => item.source_branch === value);
    const definition = latest?.build_definition ?? buildSettings?.build;
    if (definition) applyBuildDefinition(definition);
    if (latest) setTrialId(latest.trial_id);
  }
  async function freeze() {
    const result = await request<{ baseline: { sha256: string }; source_commit: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/validation-trials/${encodeURIComponent(trialId)}/freeze-baseline`, 'POST', artifact ? { artifact_relative_path: artifact } : {});
    await bound();
    setFeedback({ text: `已固定分支 ${trial?.trial?.source_branch ?? branch} 的产物，commit ${result.source_commit.slice(0, 12)}，SHA-256 ${result.baseline.sha256.slice(0, 12)}。`, bad: false });
  }
  async function bound() {
    onBound((await request<{ config: OptimizationConfig }>(`/v1/projects/${encodeURIComponent(projectId)}/config`)).config);
    setBuildSettings(await request<ValidationPreparationContext>(`${assetsUrl}/context`)); setChanging(false);
  }
  const baseline = buildSettings?.baseline;
  const configured = !!baselineArtifact && baseline?.configured === true;
  return <div className="baseline-picker">
    <p className="hint">为当前函数选择一个比较对象。固定后，后续两库性能测试使用这份版本。</p>
    {feedback && <Feedback text={feedback.text} bad={feedback.bad} />}
    {configured && <div className="current-baseline" role="status"><div className="test-section-heading"><strong>当前比较基线 · 已固定</strong><button type="button" className="text-btn" onClick={() => setChanging(value => !value)}>{changing ? '保留当前基线' : '更换比较基线'}</button></div>
      <div><b>{baseline.library}</b><span>{baseline.version}</span><span>{baseline.source_kind === 'branch' ? '来自 Git 分支' : baseline.source_kind === 'upload' ? '来自外部库导入' : '来自已有接入方案'}</span></div>
      {baseline.source_kind === 'branch' && <p>{baseline.source_detail} · {baseline.source_commit?.slice(0, 12)}</p>}
      {baseline.entry_path && <p>入口库：<code>{baseline.entry_path}</code> · {baseline.library_count} 个库 · {baseline.headers.length} 个头文件</p>}
      <p>SHA-256 <code>{baseline.sha256.slice(0, 16)}…</code>{baseline.checked_at ? ` · 依赖检查通过于 ${new Date(baseline.checked_at).toLocaleString()}` : ''}</p>
      <p className="hint">可继续配置测试条件，生成或上传测试代码。更换基线后需核对两端 API 和已有测试代码。</p>
      <details><summary>查看固定身份与文件位置</summary><code>{baseline.sha256}</code><p><code>{baseline.artifact_path ?? baselineArtifact}</code></p></details>
    </div>}
    {(!configured || changing) && <><fieldset className="baseline-source-options"><legend>{configured ? '选择新的基线来源' : '比较基线从哪里来？'}</legend>
      {[{ value: 'branch', title: '从 Git 分支构建', detail: '与自己库的历史版本或优化前版本比较' }, { value: 'external', title: '导入外部库', detail: '与已编译的第三方库比较，支持文件或文件夹' }].map(item => <label key={item.value} className={source === item.value ? 'selected' : ''}><input type="radio" name={`baseline-source-${targetId}`} value={item.value} checked={source === item.value} onChange={() => { setSource(item.value as typeof source); setFeedback(null); }} /><span><strong>{item.title}</strong><small>{item.detail}</small></span></label>)}
    </fieldset>
    {configured && <p className="hint">准备和检查新来源期间继续使用当前基线，点击固定后才替换。</p>}
    <div hidden={source !== 'branch'} className="baseline-branch-panel">
    <p className="hint">选定分支后，通过 Runner RPC 在执行机器上构建。每次构建保留独立源码、输出和日志目录。</p>
    <details className="baseline-build-settings"><summary>本次基线构建设置</summary><p className="hint">默认复用该分支最近一次构建命令，首次使用接入方案命令。标准 CMake 命令自动使用本次运行的独立构建目录，切换分支和重试时同样生效。自定义脚本可使用 COREPILOT_SOURCE_ROOT、COREPILOT_BUILD_ROOT、COREPILOT_ARTIFACT_ROOT。编译选项与修改随本次构建保存。</p>
      <Field label="基线构建命令"><textarea aria-label="基线构建命令" rows={6} spellCheck={false} disabled={!buildSettings || !!working} value={buildCommand} onChange={event => setBuildCommand(event.target.value)} onBlur={() => setBuildCommand(current => isolateCmakeBuildCommand(current, buildCwd))} /></Field><Field label="基线构建工作目录"><input aria-label="基线构建工作目录" disabled={!buildSettings || !!working} value={buildCwd} onChange={event => setBuildCwd(event.target.value)} /></Field>
      <div className="form-actions"><button type="button" disabled={!buildSettings || !!working} onClick={() => applyBuildDefinition(buildSettings!.build)}>使用接入方案的构建命令</button></div></details>
    <div className="baseline-controls"><Field label="用作基线的本地 Git 分支"><select aria-label="用作基线的本地 Git 分支" value={branch} onChange={event => chooseBranch(event.target.value)} disabled={!!working}>
      <option value="" disabled hidden>选择分支</option>{repository?.branches.map(item => <option key={item.name} value={item.name}>{item.name} · {item.commit.slice(0, 8)}</option>)}
    </select></Field><button type="button" disabled={!branch || !buildSettings || !buildCommand.trim() || !!working} onClick={() => void run('build', buildBranch)}>{working === 'build' ? '正在提交构建…' : '在执行机器上构建这个分支'}</button></div>
    {!!history.length && <Field label="查看构建记录"><select aria-label="查看构建记录" value={trialId} onChange={event => { setTrial(null); setTrialId(event.target.value); setArtifact(''); }}><option value="" disabled hidden>选择构建记录</option>{history.map(item => <option key={item.trial_id} value={item.trial_id}>{new Date(item.created_at).toLocaleString()} · {item.source_branch ?? 'HEAD'} · {item.source_commit.slice(0, 8)}</option>)}</select></Field>}
    {trialId && <div className="validation-trial" role="status"><strong>分支构建 · {({ PREPARING: '准备源码', PENDING: '等待 Runner 执行', RUNNING: '正在构建', SUCCEEDED: '构建完成', FAILED: '构建失败', UNKNOWN: '状态待核对', CANCELLED: '已取消' } as Record<string, string>)[trial?.status.status ?? ''] ?? '正在读取'}</strong><small>{trialId}</small>
      {trial?.status.status === 'PREPARING' && <p>{trial.trial?.preparation?.message}</p>}
      {trial?.trial && <div className="build-location"><dl className="definition"><dt>执行机器</dt><dd>{trial.trial.machine_name ?? '已注册机器'}</dd><dt>源码版本</dt><dd>{trial.trial.source_branch ?? 'HEAD'} · {trial.trial.source_commit}</dd>
        {trial.trial.remote_workspace && <><dt>本次运行目录</dt><dd><code>{trial.trial.remote_workspace.run_root}</code><button type="button" className="text-btn" onClick={() => void navigator.clipboard.writeText(trial.trial!.remote_workspace!.run_root).then(() => setFeedback({ text: '运行目录已复制', bad: false })).catch(() => setFeedback({ text: '复制失败，可直接选择上方路径复制。', bad: true }))}>复制目录</button></dd><dt>源码目录</dt><dd><code>{trial.trial.remote_workspace.source_root}</code></dd><dt>编译输出目录</dt><dd><code>{trial.trial.remote_workspace.build_root}</code></dd><dt>构建产物目录</dt><dd><code>{trial.trial.remote_workspace.artifacts_root}</code></dd><dt>日志目录</dt><dd><code>{trial.trial.remote_workspace.logs_root}</code></dd><dt>运行说明</dt><dd><code>{trial.trial.remote_workspace.metadata_path}</code></dd></>}
        {trial.trial.build && <><dt>构建工作目录</dt><dd><code>{trial.trial.build.cwd}</code></dd><dt>实际构建命令</dt><dd><pre>{displayBuildCommand(trial.trial.build)}</pre></dd></>}
      </dl></div>}
      {trial?.status.failure && <Feedback text={trial.status.failure.message} bad />}
      {trial?.output && <details open={trial.status.status === 'RUNNING' || trial.status.status === 'FAILED'}><summary>实时构建日志{trial.output.truncated ? '（最近部分，完整日志保存在服务器）' : ''}</summary><pre>{trial.output.stdout}{trial.output.stderr ? `\n[stderr]\n${trial.output.stderr}` : ''}</pre></details>}
      {trial?.commands.map((item, index) => <details key={index} open={item.exit_code !== 0}><summary>{item.step} · 退出码 {item.exit_code ?? '未知'}</summary><pre>{item.stdout}{item.stderr ? `\n[stderr]\n${item.stderr}` : ''}</pre></details>)}
      {!!trial?.output?.artifacts?.length && <Field label="本次构建产物"><select aria-label="本次构建产物" value={artifact} onChange={event => setArtifact(event.target.value)}><option value="" hidden disabled>选择比较用的库文件</option>{trial.output.artifacts.map(item => <option key={item.relative_path} value={item.relative_path}>{item.relative_path} · {(item.bytes / 1024 ** 2).toFixed(2)} MB · {item.sha256.slice(0, 12)}</option>)}</select></Field>}
      {trial?.status.status === 'SUCCEEDED' && <button type="button" disabled={!!working || (!!trial.output?.artifacts?.length && !artifact)} onClick={() => void run('freeze', freeze)}>{working === 'freeze' ? '正在读取并核验产物…' : '固定这次构建为比较基线'}</button>}
    </div>}
    </div>
    <div hidden={source !== 'external'}><ExternalBaselineImport projectId={projectId} packageId={packageId} version={version} targetId={targetId}
      hasBaseline={configured} machineName={buildSettings?.machine?.name ?? '执行机器'} onBound={bound} /></div>
    </>}
  </div>;
}
