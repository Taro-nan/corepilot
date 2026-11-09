import React, { useEffect, useRef, useState } from 'react';
import { canRetryWorkflowValidation, isWorkflowValidationBlocked, type OptimizationWorkflowRecord } from '../../src/contracts/workflow';
import type { OptimizationSessionEvent } from '../../src/contracts/optimization-session';
import { api } from './api';
import { Icon, Modal, Panel, Disclosure } from './components';

const toolLabels: Record<string, string> = {
  list_tree: '浏览源码', search_code: '搜索源码', find_symbol: '查找符号', find_references: '查找引用', read_file: '读取文件',
  replace_text: '修改源码', write_file: '写入源码', create_file: '创建文件', delete_file: '删除文件', move_file: '移动文件',
  inspect_machine: '调查执行机器', inspect_binary: '检查二进制', disassemble: '查看反汇编', run_dev_benchmark: '运行开发测量',
  profile_perf_stat: '采集性能计数器', record_hypothesis: '记录优化假设', record_development_findings: '记录调查结论',
  submit_candidate: '提交候选验证', record_candidate_decision: '选择下一步', read_optimization_history: '查阅历史实验',
  finish_optimization: '结束本次调查',
};

export function AgentSessionPanel({ workflow, attached, notify, refresh }: {
  workflow: OptimizationWorkflowRecord; attached?: boolean; notify: (text: string, bad?: boolean) => void; refresh: () => void;
}) {
  const [events, setEvents] = useState<OptimizationSessionEvent[]>([]);
  const [error, setError] = useState('');
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventRetry, setEventRetry] = useState(0);
  const [detail, setDetail] = useState<OptimizationSessionEvent | null>(null);
  const [message, setMessage] = useState('');
  const [minutes, setMinutes] = useState(Math.round((workflow.session_budget?.time_limit_ms ?? 3_600_000) / 60_000));
  const [candidates, setCandidates] = useState(workflow.session_budget?.max_candidates ?? 8);
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const active = attached !== false && ['CREATED', 'GENERATING'].includes(workflow.status);
  const deliveryPending = !!workflow.delivery_operation && workflow.delivery_operation.status !== 'COMPLETED';
  const canRetry = !active && canRetryWorkflowValidation(workflow);
  const validationBlocked = isWorkflowValidationBlocked(workflow);
  const measurementInconclusive = workflow.candidate_evaluation_feedback?.performance_summary.status === 'INCONCLUSIVE';
  const canResume = !deliveryPending && !validationBlocked && !!workflow.agent_session && !active && ['BUDGET_EXHAUSTED', 'INTERRUPTED', 'FAILED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'NO_CANDIDATE', 'CREATED', 'GENERATING'].includes(workflow.status);
  const running = useRef(active);
  running.current = active;
  useEffect(() => { if (followLatest.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [events]);
  useEffect(() => {
    let cancelled = false; let reading = false; let cursor = 0; let wasRunning = true;
    setEvents([]); setError(''); setLoadingEvents(true);
    async function read() {
      if (reading || cancelled) return;
      reading = true;
      try {
        const data = await api.getOptimizationSessionEvents(workflow.workflow_id, cursor);
        if (cancelled) return;
        cursor = data.next_cursor;
        setEvents(previous => {
          const known = new Set(previous.map(item => item.id));
          return [...previous, ...data.events.filter(item => !known.has(item.id))].slice(-400);
        });
        setError('');
      } catch (failure) { if (!cancelled) setError((failure as Error).message); }
      finally { reading = false; if (!cancelled) setLoadingEvents(false); }
    }
    void read();
    const timer = setInterval(() => {
      if (running.current || wasRunning) void read();
      wasRunning = running.current;
    }, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [workflow.workflow_id, workflow.agent_session?.id, eventRetry]);

  async function continueOrSend(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (active) { await api.sendOptimizationMessage(workflow.workflow_id, message); notify('补充要求已发送，Agent 会在工具执行边界读取。'); }
      else { await api.resumeOptimizationWorkflow(workflow.workflow_id, { ...(message.trim() ? { message } : {}), budget: { time_limit_ms: minutes * 60_000, max_candidates: candidates } }); notify('已继续原优化会话。'); }
      setMessage(''); refresh();
    } catch (failure) { notify((failure as Error).message, true); }
    finally { setBusy(false); }
  }

  return <Panel title="Agent 工作过程" className="agent-session" aside={workflow.agent_session && <small className="muted">{workflow.agent_session.turns} 次分析 · {workflow.agent_session.tool_calls} 次工具调用</small>}>
    <div className="agent-session-body">
    {canRetry && <div className="notice"><strong>{measurementInconclusive ? '测量证据不足，候选已保留' : validationBlocked ? '验证环境异常，候选已保留' : '当前候选已保留'}</strong><p>{measurementInconclusive ? '先检查测量噪声。采样方案变化需要建立新测试版本；不要重复试到通过。' : validationBlocked ? '本次测试未形成完整结论。修复执行环境后，可以重新验证当前候选。' : '可以继续优化以生成新候选，或保持当前源码重新验证。'}系统会创建新实验并保留原记录，重新验证不调用模型。</p><button className="primary" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await api.retryOptimizationValidation(workflow.workflow_id, workflow.candidate_id); notify('已开始重新验证当前候选。'); refresh(); }
      catch (failure) { notify((failure as Error).message, true); }
      finally { setBusy(false); }
    }}>{busy ? '正在提交…' : '重新验证当前候选'}</button></div>}
    {workflow.stop_reason && <details className="notice"><summary>本次结束原因{validationBlocked ? '（原 Agent 总结）' : ''}</summary><p>{workflow.stop_reason}</p></details>}
    {workflow.status === 'BUDGET_EXHAUSTED' && <div className="notice"><strong>本次探索预算已用完</strong><p>源码修改、调查记录和实验结果已保留，可以增加预算继续原任务。</p></div>}
    {workflow.status === 'INTERRUPTED' && <div className="notice"><strong>会话已中断，现场已保留</strong><p>继续时会恢复工作区，并核对已有 Runner 实验。</p></div>}
    {error && <div><p role="alert" className="hint">过程记录暂时不可用：{error}。任务记录仍保留。</p><button className="text-btn" onClick={() => setEventRetry(value => value + 1)}>重新读取过程记录</button></div>}
    {!events.length && !error && <p className="hint" role={loadingEvents ? 'status' : undefined}>{loadingEvents ? '正在读取调查和工具记录…' : workflow.agent_session ? '当前尚无过程记录。后台产生新记录后会自动同步。' : '此任务尚无持久会话记录。新创建的优化任务会显示完整工作过程。'}</p>}
    {!!events.length && <><div className="agent-event-preview" aria-label="最近进展">{events.slice(-2).map(event => <button key={event.id} className={`agent-event ${event.is_error ? 'has-error' : ''}`} onClick={() => setDetail(event)}><span className="agent-event-icon"><Icon name={event.is_error ? 'report' : 'code'} size={15} /></span><span className="agent-event-body"><strong>{event.tool_name ? toolLabels[event.tool_name] ?? event.tool_name : event.kind === 'progress' ? '执行进展' : 'Agent 记录'}</strong><span>{event.text.replace(/\s+/g, ' ').slice(0, 140)}</span></span><time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time></button>)}</div>
    <Disclosure title="完整过程记录" summary={'最近 ' + events.length + ' 条 · 工具调用、输出与诊断'}><div className="agent-event-list" aria-label="Agent 过程记录" ref={list} onScroll={event => { const target = event.currentTarget; followLatest.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48; }}>{events.map(event => <button key={event.id} className={`agent-event ${event.is_error ? 'has-error' : ''}`} onClick={() => setDetail(event)}>
      <span className="agent-event-icon"><Icon name={event.kind === 'tool_call' ? 'code' : event.is_error ? 'report' : event.kind === 'tool_result' ? 'check' : 'tasks'} size={15} /></span>
      <span className="agent-event-body"><strong>{event.tool_name ? toolLabels[event.tool_name] ?? event.tool_name : event.kind === 'compaction' ? '整理上下文' : event.role === 'user' ? '任务与补充要求' : event.kind === 'progress' ? '执行进展' : 'Agent'}{event.kind === 'tool_result' ? event.is_error ? ' · 返回错误' : ' · 完成' : ''}</strong><span>{event.text.replace(/\s+/g, ' ').slice(0, 180)}</span></span>
      <time>{new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</time>
    </button>)}</div></Disclosure></>}
    {(active || canResume) && <form className="agent-instructions" onSubmit={event => void continueOrSend(event)}>
      <label className="field"><span>{active ? '补充优化要求' : '继续时的补充要求（可选）'}</span><textarea rows={2} maxLength={16384} value={message} onChange={event => setMessage(event.target.value)} placeholder="例如：先分析大尺寸输入的缓存行为，保留小尺寸性能。" disabled={busy} /></label>
      {canResume && <Disclosure title="本次继续的探索预算" summary={minutes + ' 分钟 · ' + candidates + ' 个候选'} modified={minutes !== Math.round((workflow.session_budget?.time_limit_ms ?? 3_600_000) / 60_000) || candidates !== (workflow.session_budget?.max_candidates ?? 8)}><div className="field-grid"><label className="field"><span>探索时间（分钟）</span><input type="number" min={1} max={1440} required value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label><label className="field"><span>最多评估候选数</span><input type="number" min={1} max={1000} required value={candidates} onChange={event => setCandidates(Number(event.target.value))} /></label></div></Disclosure>}
      <div className="form-actions"><button className="primary" disabled={busy || active && !message.trim()}>{busy ? '正在提交…' : active ? '发送给 Agent' : '继续优化'}</button><span className="hint">{active ? '关闭页面后，后台会继续运行。' : '沿用原源码和测试口径，保留已有实验。'}</span></div>
    </form>}
    {detail && <Modal title={detail.tool_name ? toolLabels[detail.tool_name] ?? detail.tool_name : 'Agent 过程详情'} onClose={() => setDetail(null)} wide><pre className="detail-code">{detail.text}</pre></Modal>}
    </div>
  </Panel>;
}
