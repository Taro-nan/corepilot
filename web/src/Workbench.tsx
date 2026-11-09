import React, { useEffect, useState } from 'react';
import { AgentSessionPanel } from './AgentSessionPanel';
import { CustomerReportPanel } from './CustomerReportPanel';
import type { OptimizationReportResponse } from '../../src/contracts/optimization-report';
import type { Experiment } from '../../src/contracts/optimization-domain';
import type { OptimizationWorkflowRecord } from '../../src/contracts/workflow';
import type { WorkflowEvidenceSnapshot } from '../../src/contracts/optimization-approval';
import { isWorkflowValidationBlocked } from '../../src/contracts/workflow';
import { api, request, downloadProjectTestPackage } from './api';
import { Badge, Empty, Icon, Modal, Panel, Feedback, Field, Disclosure, CopyValue, download, label, time } from './components';
import { SourceOptimizationWorkbench, type CandidateTestingContext } from './SourceOptimizationWorkbench';

export type WorkflowStatusFilter = 'all' | 'running' | 'review' | 'success' | 'delivered' | 'failed' | 'blocked' | 'cancelled' | 'unverified';
export type WorkflowListMode = 'tasks' | 'analysis' | 'reports';

function evaluationLabel(experiment: Experiment | undefined, field: 'correctness' | 'performance') {
  return experiment?.status === 'UNKNOWN' ? '待核对' : label(experiment?.evaluation?.[field]);
}

export function matchesWorkflowStatus(workflow: OptimizationWorkflowRecord, filter: WorkflowStatusFilter, activeIds?: string[] | null) {
  const status = workflow.status;
  if (filter === 'running') return ['CREATED', 'GENERATING'].includes(status) && (activeIds == null || activeIds.includes(workflow.workflow_id));
  if (filter === 'review') return status === 'WAITING_APPROVAL';
  if (filter === 'success') return ['WAITING_APPROVAL', 'DELIVERABLE'].includes(status);
  if (filter === 'delivered') return status === 'DELIVERABLE';
  if (filter === 'failed') return !isWorkflowValidationBlocked(workflow) && ['FAILED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'NO_CANDIDATE'].includes(status);
  if (filter === 'blocked') return isWorkflowValidationBlocked(workflow) || ['VALIDATION_BLOCKED', 'BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(status);
  if (filter === 'cancelled') return status === 'CANCELLED';
  if (filter === 'unverified') return ['CANDIDATE_READY'].includes(status);
  return true;
}

export function WorkflowList({ workflows, open, mode = 'tasks', status = 'all', onStatusChange, activeIds, compact = false }: {
  workflows: OptimizationWorkflowRecord[]; open: (id: string) => void; mode?: WorkflowListMode;
  status?: WorkflowStatusFilter; onStatusChange?: (filter: WorkflowStatusFilter) => void; activeIds?: string[] | null; compact?: boolean;
}) {
  const readFilters = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
  const [search, setSearch] = useState(() => compact ? '' : readFilters().get('search') ?? '');
  const [branch, setBranch] = useState(() => compact ? '' : readFilters().get('branch') ?? '');
  useEffect(() => {
    if (compact) return;
    const sync = () => { setSearch(readFilters().get('search') ?? ''); setBranch(readFilters().get('branch') ?? ''); };
    window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync);
  }, [compact]);
  function filterUrl(name: string, value: string) {
    const params = readFilters(); if (value) params.set(name, value); else params.delete(name);
    const pathname = location.hash.split('?')[0];
    history.replaceState(null, '', pathname + (params.size ? '?' + params.toString() : ''));
  }
  const branches = [...new Set(workflows.map(w => w.source_branch ?? ''))].filter(Boolean).sort();
  const filtered = workflows.filter(w => matchesWorkflowStatus(w, mode === 'tasks' ? status : 'all', activeIds)
    && (!branch || (branch === '__current__' ? !w.source_branch : w.source_branch === branch))
    && `${w.function_name} ${w.workflow_id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const title = compact ? '最近任务' : mode === 'reports' ? '优化报告' : mode === 'analysis' ? '可分析任务' : '优化任务';
  return <Panel title={title} className="workflow-list" aside={compact ? undefined : <div className="workflow-filters">
    <label className="search"><Icon name="search" size={16} /><input aria-label="搜索任务" placeholder="搜索函数或任务 ID" value={search} onChange={e => { setSearch(e.target.value); filterUrl('search', e.target.value); }} /></label>
    <select aria-label="筛选分支" value={branch} onChange={e => { setBranch(e.target.value); filterUrl('branch', e.target.value); }}><option value="">所有分支</option>{workflows.some(w => !w.source_branch) && <option value="__current__">未指定分支</option>}{branches.map(name => <option key={name} value={name}>{name}</option>)}</select>
    {mode === 'tasks' && <select aria-label="筛选状态" value={status} onChange={e => onStatusChange?.(e.target.value as WorkflowStatusFilter)}><option value="all">全部状态</option><option value="running">正在运行</option><option value="unverified">代码待验证</option><option value="review">待人工审阅</option><option value="success">可审阅或已交付</option><option value="delivered">已交付</option><option value="failed">失败或未达标</option><option value="blocked">待处理</option><option value="cancelled">已取消</option></select>}
  </div>}>
    {!compact && workflows.length > 0 && <div className="list-summary"><span>{filtered.length} / {workflows.length} 个近期任务</span>{(search || branch || status !== 'all') && <button type="button" className="text-btn" onClick={() => { setSearch(''); setBranch(''); filterUrl('search', ''); filterUrl('branch', ''); onStatusChange?.('all'); }}>清除筛选</button>}</div>}
    {!workflows.length ? <Empty title={mode === 'tasks' ? '还没有优化任务' : mode === 'analysis' ? '还没有实验可分析' : '还没有优化报告'} description={mode === 'tasks' ? '配置项目后，创建第一个优化任务。实验与报告会自动出现在这里。' : '创建优化任务后，可在这里选择任务查看真实实验和报告。'} /> : <div className="table-scroll"><table><thead><tr><th>优化目标</th><th>状态</th><th>当前阶段</th><th>{mode === 'analysis' ? '实验' : mode === 'reports' ? '报告' : '分支'}</th><th>更新时间</th><th /></tr></thead><tbody>{filtered.map(w => <tr key={w.workflow_id} onClick={() => open(w.workflow_id)} className="clickable"><td><strong>{w.function_name}</strong><details className="row-identity" onClick={event => event.stopPropagation()}><summary>任务标识</summary><CopyValue value={w.workflow_id} label="任务标识" /></details></td><td><Badge value={isWorkflowValidationBlocked(w) ? 'VALIDATION_BLOCKED' : w.status} /></td><td>{phaseLabel(w.progress?.phase)}</td><td>{mode === 'analysis' ? w.revalidation_experiment_id ? '首轮与复验' : w.experiment_id ? '首轮已记录' : '等待实验' : mode === 'reports' ? w.report_files ? '文件已生成' : w.report_error ? '生成失败，可查看记录' : '实时记录可查看' : w.source_branch ?? '当前检出版本'}</td><td>{time(w.updated_at)}</td><td><button className="text-btn" onClick={e => { e.stopPropagation(); open(w.workflow_id); }}>{mode === 'reports' ? '查看报告' : mode === 'analysis' ? '查看分析' : '查看任务'} <Icon name="arrow" size={15} /></button></td></tr>)}</tbody></table>{filtered.length === 0 && <p className="center muted">没有匹配的任务，请调整筛选条件。</p>}</div>}
  </Panel>;
}

export function phaseLabel(phase?: string) {
  if (phase === 'CANDIDATE_READY') return '代码已生成，等待测试';
  if (phase === 'VALIDATION_BLOCKED') return '验证环境异常，候选已保留';
  if (phase === 'RETRYING_VALIDATION') return '重新验证当前候选';
  const labels: Record<string, string> = { PUBLIC_INTAKE_VALIDATED: '输入已检查', EDITING_WORKSPACE_READY: '工作区已准备', AGENT_EDITING: 'Agent 调查与实现', AGENT_WORKSPACE_STARTING: '准备工作区', HYPOTHESIS_PROPOSED: '优化假设已记录', CHECKPOINT_READY: '候选已冻结', CORRECTNESS_PASSED: '正确性验证完成', PERFORMANCE_PASSED: '首轮性能测试完成', REVALIDATION_PASSED: '独立复验完成', WAITING_APPROVAL: '等待人工审阅', DELIVERABLE: '已交付', FAILED: '执行失败', CANCEL_REQUESTED: '取消请求已提交', CANCELLED: '已取消', PERFORMANCE_THRESHOLD_NOT_MET: '未达到性能目标', DEVELOPMENT_FINDINGS_RECORDED: '开发调查完成', DEVELOPMENT_GATE_PASSED: '开发验证通过', DEVELOPMENT_GATE_REJECTED: '开发验证发现退化', VALIDATION_FAILED: '测试未通过', REVALIDATION_FAILED: '复验未通过' };
  Object.assign(labels, { NO_CANDIDATE: '调查结束，未提交候选', BUDGET_EXHAUSTED: '探索预算已用完', INTERRUPTED: '会话已中断', FORMAL_EVALUATION: '正式测试与测量', REVALIDATION: '独立复验' });
  return phase ? labels[phase] ?? (/^[A-Z_]+$/.test(phase) ? '查看任务进展' : phase) : '等待执行';
}

interface WorkbenchProps {
  workflow: OptimizationWorkflowRecord; response: OptimizationReportResponse | null; page: string;
  attached?: boolean;
  notify: (text: string, bad?: boolean) => void; refresh: () => void;
  projectId?: string;
  navigatePage: (page: string) => void; backToList: () => void;
  testCandidate?: (context: CandidateTestingContext) => void;
}

export function Workbench(props: WorkbenchProps) {
  return props.workflow.verification_mode === 'source_only'
    ? <SourceOptimizationWorkbench {...props} /> : <VerifiedWorkbench {...props} />;
}

function VerifiedWorkbench({ workflow, response, page, attached, notify, refresh, projectId, navigatePage, backToList }: WorkbenchProps) {
  const [candidateId, setCandidateId] = useState('');
  const [detail, setDetail] = useState<{ title: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [preparedEvidence, setPreparedEvidence] = useState<WorkflowEvidenceSnapshot | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [authorizationReference, setAuthorizationReference] = useState('');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [filter, setFilter] = useState('');
  const [expandedStage, setExpandedStage] = useState(-1);
  const report = response?.report;
  const packageReference = report?.task?.library_package;
  const evaluatorDigest = report?.task?.evaluator?.digest;
  const testPackageAction = projectId && packageReference?.package_id === `project-${projectId.slice(0, 8)}` && evaluatorDigest
    ? `validation-assets/${encodeURIComponent(packageReference.package_id)}/${encodeURIComponent(packageReference.package_version)}/${encodeURIComponent(packageReference.target_id)}` : null;
  async function testPackage(view: boolean) {
    if (!projectId || !testPackageAction) return;
    setBusy(true);
    try {
      if (view) {
        const data = await api.projectAction(projectId, `${testPackageAction}/files?digest=${evaluatorDigest}`) as { files: Array<{ path: string; content: string }> };
        setDetail({ title: '本次优化使用的测试方案', content: data.files.map(file => `// ${file.path}\n${file.content}`).join('\n\n') });
      } else await downloadProjectTestPackage(projectId, `${testPackageAction}/download?digest=${evaluatorDigest}`);
    } catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  const selectedId = report?.candidates.some(c => c.candidate.candidate_id === candidateId) ? candidateId : workflow.candidate_id ?? report?.candidates.at(-1)?.candidate.candidate_id;
  const selected = report?.candidates.find(c => c.candidate.candidate_id === selectedId);
  const experiments = report?.experiments.filter(e => e.experiment.candidate_id === selectedId) ?? [];
  const formalIndex = experiments.map(e => e.experiment.type).lastIndexOf('FORMAL_EVALUATION');
  const formal = experiments[formalIndex];
  const revalidation = experiments.slice(formalIndex + 1).filter(e => e.experiment.type === 'REVALIDATION').at(-1);
  const currentExperiments = [formal, revalidation].filter(e => e !== undefined);
  const currentIds = new Set(currentExperiments.map(e => e.experiment.experiment_id));
  const workloadData = formal?.experiment.evaluation?.performance_workloads ?? [];
  const historicalCandidate = !!report && selectedId !== report.summary?.candidate_id && !!report.summary?.candidate_id;
  const verification = report?.summary?.verification;
  const deliveryOperation = !historicalCandidate ? workflow.delivery_operation : undefined;
  const pendingDelivery = !!deliveryOperation && deliveryOperation.status !== 'COMPLETED';
  const approvalCurrent = !!selected?.approval && verification?.ready === true
    && selected.approval.first_formal_experiment_id === verification.formal_experiment_id
    && selected.approval.revalidation_experiment_id === verification.revalidation_experiment_id
    && selected.approval.candidate_commit === selected.candidate.source.commit;
  const canReview = workflow.status === 'WAITING_APPROVAL' && !historicalCandidate && !pendingDelivery
    && verification?.ready === true && (approvalCurrent ? report?.summary?.state === 'READY_FOR_DELIVERY'
      : !selected?.approval && report?.summary?.state === 'READY_FOR_REVIEW');
  const approvalBlocked = verification?.ready === true && report?.summary?.state === 'BLOCKED';
  const elapsed = (() => {
    const end = ['CREATED', 'GENERATING'].includes(workflow.status) ? Date.now() : Date.parse(workflow.updated_at);
    const seconds = Math.max(0, Math.round((end - Date.parse(workflow.created_at)) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  })();
  const known = formal?.experiment.validity === 'VALID';
  const invalid = currentExperiments.some(({ experiment: e }) => e.validity === 'INVALID'
    || e.evaluation?.correctness === 'INCOMPLETE' || e.evaluation?.correctness === 'INVALID'
    || e.evaluation?.correctness_coverage?.complete === false);
  const historicalIssues = experiments.filter(({ experiment: e }) => !currentIds.has(e.experiment_id)
    && (e.validity === 'INVALID' || e.status === 'FAILED' || e.status === 'CANCELLED'
      || e.evaluation?.correctness === 'INCOMPLETE' || e.evaluation?.correctness === 'INVALID'
      || e.evaluation?.correctness === 'FAILED' || e.evaluation?.performance === 'FAILED')).length;
  const coverage = formal?.experiment.evaluation?.correctness_coverage;
  const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(4) + '×' : '—';
  async function diff() {
    if (!selectedId) return;
    setBusy(true);
    try { const data = await request<{ diff: string }>(`/v1/workflows/${encodeURIComponent(workflow.workflow_id)}/candidates/${encodeURIComponent(selectedId)}/diff`); setDetail({ title: '候选源码差异', content: data.diff || '没有源码差异' }); }
    catch (e) { notify((e as Error).message, true); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm('取消此优化任务？系统会请求停止活动执行，最终状态以后台确认结果为准。')) return;
    try { const result = await api.cancelOptimizationWorkflow(workflow.workflow_id) as { ok: boolean; message: string }; notify(result.ok ? '已提交取消请求' : result.message, !result.ok); refresh(); } catch (e) { notify((e as Error).message, true); }
  }
  async function prepareEvidence() {
    setBusy(true); setApprovalError('');
    try { const result = await api.prepareWorkflowEvidence(workflow.workflow_id); setPreparedEvidence(result.snapshot); refresh(); }
    catch (error) { setApprovalError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function showEvidence() {
    setBusy(true); setApprovalError('');
    try { const result = await api.getWorkflowEvidence(workflow.workflow_id); setDetail({ title: '冻结证据摘要', content: JSON.stringify(result.evidence, null, 2) }); }
    catch (error) { setApprovalError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function downloadEvidence() {
    setBusy(true); setApprovalError('');
    try {
      const bytes = await api.downloadWorkflowEvidence(workflow.workflow_id);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/gzip' }));
      const link = document.createElement('a'); link.href = url; link.download = 'corepilot-evidence.json.gz'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setApprovalError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function approve(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setApprovalError('');
    if (!selected?.approval) {
      try {
        if (!preparedEvidence || !reviewConfirmed) throw new Error('请先准备并审阅冻结证据。');
        await api.approveWorkflowEvidence(workflow.workflow_id, { expected_evidence_digest: preparedEvidence.artifact.digest,
          reviewer, authorization_reference: authorizationReference });
        setApproval(false); setPreparedEvidence(null); setReviewConfirmed(false); notify('已记录人工批准；源码尚未交付。'); refresh();
      } catch (error) { setApprovalError((error as Error).message); }
      finally { setBusy(false); }
      return;
    }
    try { const result = await api.requestWorkflowApprove(workflow.workflow_id, { commit_message: commitMessage, expected_baseline_commit: workflow.baseline_commit }) as { cleanup_warning?: string }; setApproval(false); notify(result.cleanup_warning ?? '源码已按交付请求合并', !!result.cleanup_warning); refresh(); }
    catch (error) {
      // A lost/error response can follow a completed delivery. Reconcile before
      // showing a retry action; a confirmed delivery must not be submitted again.
      try {
        const latest = await api.getOptimizationWorkflow(workflow.workflow_id) as { workflow: OptimizationWorkflowRecord };
        if (latest.workflow.status === 'DELIVERABLE') {
          setApproval(false); setApprovalError(''); notify('已核对后台：源码交付已完成'); refresh(); return;
        }
        if (latest.workflow.delivery_operation) {
          setApproval(false); setApprovalError(''); notify('交付请求已保存，请核对当前状态后继续。', true); refresh(); return;
        }
      } catch { /* Keep the original failure visible when state cannot be read. */ }
      setApprovalError((error as Error).message);
    } finally { setBusy(false); }
  }
  async function deliveryAction(action: 'reconcile' | 'resume' | 'withdraw' | 'cleanup') {
    const confirmStopped = (action === 'resume' || action === 'withdraw') && deliveryOperation?.stop_confirmation_required === true;
    if (action === 'withdraw' && !window.confirm((confirmStopped ? '请先确认原 Git 交付进程已经停止。' : '') + '撤回未完成的交付请求？原记录会保留，现有 Git 提交不会回退。')) return;
    if (action === 'resume' && confirmStopped && !window.confirm('请先确认原 Git 交付进程已经停止。确认后继续同一次交付，不会创建新的交付请求。')) return;
    setBusy(true);
    try {
      if (action === 'resume') {
        const result = await api.resumeWorkflowDelivery(workflow.workflow_id, confirmStopped);
        notify(result.cleanup_warning ?? '原交付已完成。', !!result.cleanup_warning);
      } else if (action === 'withdraw') {
        if (!deliveryOperation) throw new Error('交付请求已变化，请刷新后重新核对。');
        await api.withdrawWorkflowDelivery(workflow.workflow_id, deliveryOperation.operation_id, confirmStopped);
        notify('交付请求已撤回，原记录已保留。');
      } else {
        const result = action === 'cleanup' ? await api.cleanupWorkflowDelivery(workflow.workflow_id) : await api.reconcileWorkflowDelivery(workflow.workflow_id);
        const operation = result.workflow.delivery_operation;
        notify(operation?.cleanup_message ?? operation?.message ?? '已核对交付状态。', operation?.status === 'NEEDS_ATTENTION' || operation?.cleanup === 'NEEDS_ATTENTION');
      }
    } catch (error) { notify((error as Error).message, true); }
    finally { setBusy(false); refresh(); }
  }
  const tasks = [
    { title: '源码调查与优化假设', done: !!report?.hypotheses.length, note: report?.hypotheses.at(-1)?.description ?? (workflow.progress?.phase === 'AGENT_EDITING' ? 'Agent 正在调查源码' : '等待调查结论'), evidence: report?.hypotheses.length ? <ul className="stage-facts">{report.hypotheses.slice(-5).map(h => <li key={h.hypothesis_id}><strong>{h.description}</strong><span>{h.motivation}</span><small>状态：{label(h.status)} · {time(h.created_at)}</small></li>)}</ul> : <p>尚无持久化优化假设；上方「Agent 工作过程」可查看实时搜索与调查工具记录。</p> },
    { title: '候选实现与源码冻结', done: !!selected, note: selected ? `${selected.candidate.source.changed_files.length} 个文件 · ${selected.candidate.source.commit.slice(0, 12)}` : '等待候选', evidence: selected ? <div className="stage-facts"><p>候选 C{String(selected.candidate.sequence).padStart(3, '0')} · 源码提交 <code>{selected.candidate.source.commit.slice(0, 12)}</code> · tree <code>{selected.candidate.source.tree.slice(0, 12)}</code></p><ul>{selected.candidate.source.changed_files.map(file => <li key={file.path}>{file.path}</li>)}</ul><button className="text-btn" disabled={busy} onClick={() => void diff()}>查看候选源码差异 <Icon name="arrow" size={14} /></button></div> : <p>Agent 提交候选后，这里会显示源码身份、改动文件与差异。</p> },
    { title: '正确性测试', done: known && formal?.experiment.status === 'SUCCEEDED' && formal.experiment.evaluation?.correctness === 'PASSED' && coverage?.complete === true && coverage.planned > 0 && coverage.executed === coverage.planned && coverage.passed === coverage.planned && coverage.failed === 0, note: coverage ? `计划 ${coverage.planned} · 执行 ${coverage.executed} · 通过 ${coverage.passed} · 失败 ${coverage.failed}` : '等待测试数据', evidence: formal ? <div className="stage-facts"><p>正式实验 <code>{formal.experiment.experiment_id}</code></p><p>执行：{label(formal.experiment.status)} · 有效性：{label(formal.experiment.validity)} · 正确性：{evaluationLabel(formal.experiment, 'correctness')}</p>{coverage && <p>覆盖：计划 {coverage.planned}，执行 {coverage.executed}，通过 {coverage.passed}，失败 {coverage.failed}。{coverage.complete ? '用例已执行完整。' : '用例尚未执行完整。'}</p>}<button className="text-btn" onClick={() => setDetail({ title: '正确性实验与执行记录', content: JSON.stringify(formal, null, 2) })}>查看用例与执行日志 <Icon name="arrow" size={14} /></button></div> : <p>正式实验开始后，显示实际用例、覆盖情况及执行日志。</p> },
    { title: '首轮性能测试', done: !workflow.enable_performance || known && formal?.experiment.status === 'SUCCEEDED' && formal.experiment.evaluation?.performance === 'PASSED', note: !workflow.enable_performance ? '本任务未启用性能测量' : workloadData.length ? `${workloadData.length} 个 workload · ${evaluationLabel(formal?.experiment, 'performance')}` : '等待性能测量', evidence: !workflow.enable_performance ? <p>本任务只验证正确性，没有性能对比。</p> : workloadData.length ? <ul className="stage-facts">{workloadData.map(item => <li key={item.workload_id}><strong>{item.workload_id}</strong><span>基线中位数 {item.baseline_median} → 候选中位数 {item.candidate_median} · {number(item.speedup)}{item.regression ? ' · 退化' : ''}</span></li>)}</ul> : <p>尚无有效的逐 workload 性能测量；下方实验记录保留失败诊断。</p> },
    { title: '独立复验', done: revalidation?.experiment.status === 'SUCCEEDED' && revalidation.experiment.validity === 'VALID' && revalidation.experiment.evaluation?.correctness === 'PASSED' && revalidation.experiment.evaluation.correctness_coverage?.complete === true && (!workflow.enable_performance || revalidation.experiment.evaluation.performance === 'PASSED'), note: revalidation ? `${label(revalidation.experiment.status)} · ${label(revalidation.experiment.validity)}` : '尚未进入复验', evidence: revalidation ? <div className="stage-facts"><p>复验实验 <code>{revalidation.experiment.experiment_id}</code></p><p>执行：{label(revalidation.experiment.status)} · 有效性：{label(revalidation.experiment.validity)} · 正确性：{evaluationLabel(revalidation.experiment, 'correctness')} · 性能：{evaluationLabel(revalidation.experiment, 'performance')}</p><button className="text-btn" onClick={() => setDetail({ title: '独立复验与原始记录', content: JSON.stringify(revalidation, null, 2) })}>查看复验记录 <Icon name="arrow" size={14} /></button></div> : <p>首轮通过后，Runner 会以新实验重新构建、测试和测量。</p> },
    { title: '报告与人工审阅', done: !!selected?.approval || workflow.status === 'DELIVERABLE', note: selected?.approval ? `批准人：${selected.approval.reviewer}` : canReview ? '等待人工审阅源码与实验结果' : approvalBlocked ? '尚不满足当前批准要求' : workflow.status === 'WAITING_APPROVAL' ? '验证记录待核对，暂不能审阅交付' : '实验报告不自动授予批准', evidence: <div className="stage-facts"><p>报告：{response ? '可查看 Markdown 与 JSON' : '正在读取或尚未生成'}；人工审阅：{canReview ? '待处理' : approvalBlocked ? '待补充批准依据' : workflow.status === 'WAITING_APPROVAL' ? '验证记录待核对' : workflow.status === 'DELIVERABLE' ? '已交付' : '尚未进入'}</p><button className="text-btn" onClick={() => navigatePage('reports')}>查看优化报告 <Icon name="arrow" size={14} /></button></div> },
  ];
  const running = attached !== false && ['CREATED', 'GENERATING'].includes(workflow.status);
  const queue = workflow.progress?.runner_queue;
  const activeStep = workflow.status === 'WAITING_APPROVAL' ? tasks.length - 1 : running || ['FAILED', 'VALIDATION_BLOCKED', 'BUDGET_EXHAUSTED', 'INTERRUPTED', 'PERFORMANCE_THRESHOLD_NOT_MET'].includes(workflow.status) ? tasks.findIndex(t => !t.done) : -1;
  const latest = revalidation ?? formal ?? experiments.at(-1);
  const latestEvaluation = latest?.experiment.evaluation;
  const latestCoverage = latestEvaluation?.correctness_coverage;
  const latestValid = latest?.experiment.validity === 'VALID';
  const deliveryMatches = !!workflow.delivery && workflow.delivery.candidate_id === selectedId && workflow.delivery.tree === selected?.candidate.source.tree;
  const resources = report?.task?.declared_context.resources as { cpu_set?: string; numa_node?: number; thread_counts?: number[] } | undefined;
  const measurementUnit = experiments.flatMap(item => item.measurements).find(item => item.kind === 'PERFORMANCE_SAMPLE')?.unit ?? '单位未声明';
  return <>
    <div className="detail-navigation"><button className="text-btn" onClick={backToList}><Icon name="back" size={15} />{page === 'analysis' ? '返回分析列表' : page === 'reports' ? '返回报告列表' : '返回任务列表'}</button><div className="detail-view-links" aria-label="任务查看方式"><button aria-pressed={page === 'tasks'} className={page === 'tasks' ? 'active' : ''} onClick={() => navigatePage('tasks')}>任务详情</button><button aria-pressed={page === 'analysis'} className={page === 'analysis' ? 'active' : ''} onClick={() => navigatePage('analysis')}>查看实验分析</button><button aria-pressed={page === 'reports'} className={page === 'reports' ? 'active' : ''} onClick={() => navigatePage('reports')}>查看优化报告</button></div></div>
    <div className="page-heading"><div><div className="title-row"><h1>{workflow.function_name}</h1><Badge value={isWorkflowValidationBlocked(workflow) ? 'VALIDATION_BLOCKED' : workflow.status} /></div><p>{workflow.source_branch ?? '当前检出版本'} · {selected ? '候选 C' + String(selected.candidate.sequence).padStart(3, '0') + ' · ' : ''}{time(workflow.created_at)}</p></div><div className="actions"><button onClick={() => response && download('report.md', response.markdown)} disabled={!response}><Icon name="download" size={17} />下载报告</button>{canReview && <button className="primary" onClick={() => { setApprovalError(''); setPreparedEvidence(null); setReviewConfirmed(false); setApproval(true); }}>{approvalCurrent ? '交付已批准候选' : '审阅与批准'}</button>}{['CREATED', 'GENERATING'].includes(workflow.status) && <button onClick={() => void cancel()}>取消任务</button>}</div></div>
    {(running || queue && workflow.progress?.runner_status === 'PENDING') && <section className="run-progress" aria-label="当前执行阶段"><div><h2>{running && <span className="pulse" />}{phaseLabel(workflow.progress?.phase)}</h2><p>{workflow.progress?.runner_status === 'PENDING' ? '等待执行机器：' + (queue?.reason ?? '等待可用资源时段') + (queue?.position ? ' · 排队位置 ' + queue.position : '') : workflow.progress?.runner_step ?? 'Agent 在授权范围内调查、实现或验证。'}</p><p>{running ? '关闭页面后后台继续执行；阶段与日志从真实任务记录同步。' : '当前后台未接管，请先核对原作业状态。'}</p></div><div className="run-time">已运行 {elapsed}<br /><small>最近更新 {time(workflow.updated_at)}</small></div></section>}
    <dl className="outcome-strip" aria-label="验证与交付状态">
      <div><dt>实验执行</dt><dd>{running ? '进行中' : latest ? label(latest.experiment.status) : '尚无实验'}<small>{latest ? '执行状态与测试判定分别记录' : '等待候选与真实执行记录'}</small></dd></div>
      <div><dt>正确性</dt><dd>{latest?.experiment.status !== 'UNKNOWN' && latestEvaluation?.correctness === 'PASSED' && (!latestValid || latestCoverage?.complete !== true) ? '结论待核对' : evaluationLabel(latest?.experiment, 'correctness') }<small>{latestCoverage ? latestCoverage.passed + ' / ' + latestCoverage.planned + ' 次执行通过 · ' + label(latest?.experiment.validity) : '尚无完整用例结果'}</small></dd></div>
      <div><dt>性能验收</dt><dd>{!workflow.enable_performance ? '未启用' : latest?.experiment.status !== 'UNKNOWN' && latestEvaluation?.performance === 'PASSED' && !latestValid ? '结论待核对' : evaluationLabel(latest?.experiment, 'performance')}<small>{workflow.enable_performance ? '收益与退化见下方负载和复验' : '本次只验证正确性'}</small></dd></div>
      <div><dt>人工批准</dt><dd>{selected?.approval ? approvalCurrent ? '已记录' : '历史批准，需核对' : pendingDelivery ? '未记录领域批准' : canReview ? '等待决定' : approvalBlocked ? '待补充批准依据' : workflow.status === 'WAITING_APPROVAL' && !historicalCandidate ? '验证待核对' : '未记录'}<small>{selected?.approval ? selected.approval.reviewer : pendingDelivery ? '交付请求已确认；领域批准记录单独管理' : '测试通过不会自动授予批准'}</small></dd></div>
      <div><dt>源码交付</dt><dd>{deliveryMatches ? '已记录交付' : pendingDelivery ? deliveryOperation?.status === 'WAITING' ? '等待继续' : deliveryOperation?.status === 'NEEDS_ATTENTION' ? '需要核对' : '交付处理中' : workflow.status === 'DELIVERABLE' && !historicalCandidate ? '历史记录已交付' : '未交付'}<small>{deliveryMatches ? '交付身份与当前候选匹配' : pendingDelivery ? '交付请求已保存' : workflow.status === 'DELIVERABLE' && !historicalCandidate ? '交付身份需核对原记录' : '批准与合并分别处理'}</small></dd></div>
    </dl>
    {workflow.error && <Feedback text={workflow.error} bad />}
    {attached === false && ['CREATED', 'GENERATING'].includes(workflow.status) && <div className="notice"><strong>此任务当前未由后台接管</strong><p>已有记录已保留。请核对目标机上的实验状态后再决定后续操作；系统不会自动重复启动实验。</p></div>}
    {invalid && <div className="notice"><strong>最近一次验证尚未形成完整有效的结论</strong><p>请查看最新正式验证与随后复验的有效性、正确性覆盖和执行日志。原始测量在下方保留供诊断。</p></div>}
    {workflow.status === 'WAITING_APPROVAL' && !historicalCandidate && !pendingDelivery && !canReview && <div className="notice"><strong>{approvalBlocked ? '尚不满足当前批准条件' : '需要先核对当前验证记录'}</strong><p>{selected?.approval && verification?.ready ? '已有批准绑定的是其他实验，请核对历史并使用新的候选重新审阅。' : approvalBlocked ? report?.summary?.next_step.message : verification ? verification.issues.map(issue => issue.message).join(' ') : response ? '当前报告未提供验证核对结果，请更新服务后重新读取。' : '正在读取正式实验与复验结果。'}</p></div>}
    {deliveryOperation && <section className="notice delivery-status" aria-label="源码交付进度"><strong>{pendingDelivery ? deliveryOperation.status === 'WAITING' ? '等待继续交付' : deliveryOperation.status === 'NEEDS_ATTENTION' ? '交付需要核对' : '交付正在处理或等待状态核对' : '源码交付已记录'}</strong><p>{deliveryOperation.message}</p>{deliveryOperation.cleanup_message && <p>{deliveryOperation.cleanup_message}</p>}<div className="actions">{pendingDelivery && <button disabled={busy} onClick={() => void deliveryAction('reconcile')}>核对交付状态</button>}{pendingDelivery && deliveryOperation.can_resume === true && <button className="primary" disabled={busy} onClick={() => void deliveryAction('resume')}>{deliveryOperation.stop_confirmation_required ? '确认原操作已停止并继续' : '继续原交付'}</button>}{pendingDelivery && deliveryOperation.observation !== 'UNKNOWN' && <button disabled={busy} onClick={() => void deliveryAction('withdraw')}>撤回未完成交付</button>}{!pendingDelivery && deliveryOperation.cleanup === 'NEEDS_ATTENTION' && <button disabled={busy} onClick={() => void deliveryAction('cleanup')}>重新清理候选工作区</button>}</div></section>}
    {!!workflow.delivery_history?.length && <Disclosure title="历史交付请求" summary={`${workflow.delivery_history.length} 条已撤回`}><ul>{workflow.delivery_history.map(operation => <li key={operation.operation_id}>已撤回 · {time(operation.updated_at)} · {operation.commit_message} <CopyValue value={operation.operation_id} label="交付请求标识" /></li>)}</ul></Disclosure>}
    {historicalCandidate && <div className="notice compact">正在查看历史候选。下方仅展示该候选的实验，不代表当前任务的交付建议。</div>}
    {report && !historicalCandidate && (page !== 'tasks' || report.summary?.state !== 'RUNNING') && <CustomerReportPanel report={report} notify={notify} refresh={refresh} />}
    {!report && <p className="loading" role="status">正在读取实验结果与测试条件…</p>}
    <div className="workspace-grid"><div>
      {page !== 'analysis' && page !== 'reports' && <>
        <AgentSessionPanel workflow={workflow} attached={attached} notify={notify} refresh={refresh} scopeAuthority={report?.task ? report.task.library_package ? 'package' : 'user' : undefined} />
        <Panel title="执行进度" aside={<span className="muted">已记录 {tasks.filter(item => item.done).length} / {tasks.length} 个阶段</span>}><div className="timeline">{tasks.map((task, index) => <div className={'timeline-item ' + (task.done ? 'done' : index === activeStep ? running || workflow.status === 'WAITING_APPROVAL' ? 'current' : 'blocked' : '')} key={task.title}><span className="timeline-dot">{task.done ? <Icon name="check" size={13} /> : <i />}</span><div className="timeline-content"><strong>{task.title}</strong><p>{task.note}</p><details className="stage-evidence" open={expandedStage === index}><summary onClick={event => { event.preventDefault(); setExpandedStage(value => value === index ? -1 : index); }}>查看阶段证据</summary><div>{task.evidence}</div></details></div></div>)}</div><div className="live-status">{running && <span className="pulse" />}<span>{phaseLabel(workflow.progress?.phase)}</span><span className="muted">{time(workflow.updated_at)}</span></div></Panel>
      </>}
      {(!!workloadData.length || page === 'analysis') && <Panel title="负载性能对比" className="performance-table" aside={<span className="muted">加速比大于 1 表示更快 · 单位 {measurementUnit}</span>}>
        {!workloadData.length ? <div className="quiet-empty">尚无逐负载性能结果。测试完成后展示实际测量。</div> : <div className="table-scroll"><table><thead><tr><th>负载</th><th>基线中位数</th><th>候选中位数</th><th>加速比</th><th>统计区间 / 退化</th></tr></thead><tbody>{workloadData.map(item => <tr key={item.workload_id} className={item.regression ? 'regression-row' : ''}><td className="workload-name"><strong>{item.workload_id}</strong>{item.critical && <small>关键负载</small>}</td><td>{item.baseline_median.toPrecision(5)}</td><td>{item.candidate_median.toPrecision(5)}</td><td><strong>{number(item.speedup)}</strong></td><td>{item.ci_lower !== undefined && item.ci_upper !== undefined ? number(item.ci_lower) + ' ～ ' + number(item.ci_upper) : '未计算区间'}<small className={item.regression ? 'regression-label' : ''}>{item.regression ? '已标记退化' : item.conclusion === 'IMPROVED' ? '区间支持改善' : item.conclusion === 'REGRESSED' ? '区间支持退化' : '以固定验收规则为准'}</small></td></tr>)}</tbody></table></div>}
      </Panel>}
    </div><aside>
      <Panel title="候选与源码"><div className="candidate-selector"><Field label="查看候选"><select value={selectedId ?? ''} onChange={event => setCandidateId(event.target.value)}>{!selectedId && <option value="">等待 Agent 提交候选</option>}{report?.candidates.map(({ candidate }) => <option key={candidate.candidate_id} value={candidate.candidate_id}>C{String(candidate.sequence).padStart(3, '0')}{candidate.candidate_id === workflow.candidate_id ? ' · 当前任务候选' : ' · 历史候选'}</option>)}</select></Field><button className="text-btn diff-button" disabled={!selected || busy} onClick={() => void diff()}><Icon name="code" size={16} />查看源码差异</button></div>
        {selected?.candidate.hypothesis && <Disclosure title="候选实现说明" summary={selected.candidate.source.changed_files.length + ' 个文件发生变更'}><p>{selected.candidate.hypothesis}</p></Disclosure>}
      </Panel>
      <Panel title="本次运行条件"><dl className="definition"><dt>源码分支</dt><dd>{workflow.source_branch ?? '当前检出版本'}</dd><dt>模型</dt><dd>{String(selected?.candidate.agent_identity.model_id ?? selected?.candidate.agent_identity.model ?? '未记录')}</dd><dt>线程</dt><dd>{resources?.thread_counts?.join(' / ') ?? '见逐负载记录'}</dd><dt>CPU / NUMA</dt><dd>{resources?.cpu_set ?? '未记录'} / {resources?.numa_node ?? '未记录'}</dd></dl><button className="text-btn" onClick={() => setDetail({ title: '运行资源与环境', content: JSON.stringify({ declared: report?.task?.declared_context, experiments: experiments.map(item => ({ id: item.experiment.experiment_id, observed: item.experiment.observed_context })) }, null, 2) })}>查看完整资源与环境<Icon name="arrow" size={15} /></button></Panel>
    </aside></div>
    <Disclosure title="实验记录" summary={experiments.length + ' 次实验' + (historicalIssues ? ' · 含 ' + historicalIssues + ' 次历史失败或不完整记录' : '')} defaultOpen={page === 'analysis'} className="evidence-disclosure">
      {historicalIssues > 0 && <p className="hint">历史实验记录已保留：包含 {historicalIssues} 次失败或不完整的历史实验；当前结论使用最近的正式验证与随后独立复验。</p>}
      <div className="table-scroll"><table><thead><tr><th>实验用途</th><th>执行</th><th>有效性</th><th>正确性</th><th>性能</th><th /></tr></thead><tbody>{experiments.map(({ experiment, commands, measurements }) => <tr key={experiment.experiment_id}><td><strong>{experiment.type === 'REVALIDATION' ? '独立复验' : experiment.type === 'DEVELOPMENT_FEEDBACK' ? '开发反馈' : '正式评估'}</strong><small>{time(experiment.created_at)}</small></td><td><Badge value={experiment.status} /></td><td><Badge value={experiment.validity} /></td><td>{evaluationLabel(experiment, 'correctness')}</td><td>{evaluationLabel(experiment, 'performance')}</td><td><button className="text-btn" onClick={() => setDetail({ title: '实验详情与执行日志', content: JSON.stringify({ experiment, commands, measurements }, null, 2) })}>日志与详情<Icon name="arrow" size={14} /></button></td></tr>)}</tbody></table>{!experiments.length && <div className="quiet-empty">当前候选尚无实验记录</div>}</div>
    </Disclosure>
    {page === 'reports' && <Disclosure title="完整文字报告" summary="适用范围、完整说明与 JSON 下载" className="evidence-disclosure"><div className="actions"><button disabled={!report} onClick={() => report && download('report.json', JSON.stringify(report, null, 2))}><Icon name="download" size={16} />下载 JSON 报告</button></div><ul className="report-notices">{report?.notices.map(notice => <li key={notice}>{notice}</li>)}</ul><pre className="report-preview">{response?.markdown ?? '正在读取报告…'}</pre></Disclosure>}
    {(page === 'analysis' || page === 'reports') && <Disclosure title="逐用例与原始数据" summary={experiments.reduce((count, item) => count + item.measurements.length, 0) + ' 条测量记录'} className="evidence-disclosure"><Field label="筛选 case / workload"><input className="compact-input" placeholder="筛选 case / workload" value={filter} onChange={event => setFilter(event.target.value)} /></Field><div className="table-scroll"><table><thead><tr><th>实验</th><th>类型</th><th>用例 / 负载</th><th>角色</th><th>样本</th><th>值</th><th>单位</th><th>有效性</th></tr></thead><tbody>{experiments.flatMap(item => item.measurements.filter(measurement => measurement.subject_id.includes(filter)).map(measurement => <tr key={measurement.measurement_id}><td>{item.experiment.type === 'REVALIDATION' ? '复验' : item.experiment.type === 'DEVELOPMENT_FEEDBACK' ? '开发' : '首轮'}</td><td>{measurement.kind}</td><td className="mono">{measurement.subject_id}</td><td>{measurement.role}</td><td>{measurement.sample_index ?? '—'}</td><td>{String(measurement.value)}</td><td>{measurement.unit ?? '未声明'}</td><td><Badge value={measurement.validity} /></td></tr>)).slice(0, 500)}</tbody></table></div><p className="hint">页面最多展示 500 条；完整原始记录可下载 JSON 报告查看。</p></Disclosure>}
    <Disclosure title="任务标识与测试资产" summary="可复制身份、查看冻结测试代码与下载测试包" className="evidence-disclosure identity-details"><dl className="definition"><dt>任务标识</dt><dd><CopyValue value={workflow.workflow_id} label="任务标识" /></dd><dt>候选标识</dt><dd>{selectedId ? <CopyValue value={selectedId} label="候选标识" /> : '尚未产生'}</dd><dt>源码提交</dt><dd>{selected ? <CopyValue value={selected.candidate.source.commit} label="源码提交" /> : '尚未冻结'}</dd><dt>验证方案</dt><dd>{report?.task?.evaluator?.id ?? '未记录'}</dd><dt>比较基线</dt><dd>{report?.task?.performance_baseline?.id ?? '未记录'}</dd><dt>测试摘要</dt><dd>{evaluatorDigest ? <CopyValue value={evaluatorDigest} label="测试摘要" /> : '未记录'}</dd></dl>
      {testPackageAction && <div className="actions"><button disabled={busy} onClick={() => void testPackage(true)}>查看本次测试代码</button><button disabled={busy} onClick={() => void testPackage(false)}>下载本次测试包</button></div>}
    </Disclosure>
    {detail && <Modal title={detail.title} onClose={() => setDetail(null)} wide><pre className="detail-code">{detail.content}</pre></Modal>}
    {approval && canReview && <Modal title="人工审阅与源码交付" onClose={() => { if (!busy) setApproval(false); }}><form onSubmit={e => void approve(e)}>
      {approvalCurrent ? <><p className="hint">已由 {selected?.approval?.reviewer} 批准当前候选和验证证据。交付提交只包含已验证的候选；其他本地暂存、未提交和未跟踪内容将保留。与候选文件重叠的本地改动需要先处理。</p>
        <p>交付分支：<strong>{workflow.source_branch ?? '原基线工作区'}</strong></p><label className="field"><span>合并提交说明</span><input required disabled={busy} value={commitMessage} onChange={e => { setCommitMessage(e.target.value); setApprovalError(''); }} placeholder="说明本次优化与验证结果" /></label></>
        : <><p className="hint">先准备并审阅本次冻结证据、源码差异与测试结果；记录人工批准后，源码交付需要另行确认。批准人由操作者填写，当前工作台不验证个人身份。</p>
          <button type="button" disabled={busy} onClick={() => void prepareEvidence()}>{preparedEvidence ? '重新核对冻结证据' : '准备审阅证据'}</button>
          {preparedEvidence && <><p>证据已冻结 · 候选 C{String(selected?.candidate.sequence ?? 0).padStart(3, '0')}</p><div className="actions"><button type="button" disabled={busy} onClick={() => void showEvidence()}>查看证据摘要</button><button type="button" disabled={busy} onClick={() => void downloadEvidence()}>下载冻结证据</button></div>
            <label className="field"><span>批准人</span><input required disabled={busy} value={reviewer} onChange={e => setReviewer(e.target.value)} placeholder="填写审阅人姓名" /></label>
            <label className="field"><span>授权说明</span><textarea required disabled={busy} value={authorizationReference} onChange={e => setAuthorizationReference(e.target.value)} placeholder="填写明确的批准依据或授权说明" /></label>
            <label className="review-confirm"><input type="checkbox" required checked={reviewConfirmed} onChange={e => setReviewConfirmed(e.target.checked)} /><span>我已审阅源码、测试和冻结证据，并明确批准当前候选。</span></label></>}
        </>}
      {approvalError && <Feedback text={approvalError} bad />}<div className="form-actions"><button type="button" disabled={busy} onClick={() => setApproval(false)}>返回</button><button className="primary" disabled={busy || (approvalCurrent ? !commitMessage.trim() : !preparedEvidence || !reviewer.trim() || !authorizationReference.trim() || !reviewConfirmed)}>{busy ? '正在处理…' : approvalCurrent ? '确认交付并合并' : '记录人工批准'}</button></div></form></Modal>}
  </>;
}
