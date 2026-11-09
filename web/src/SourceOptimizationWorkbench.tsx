import React, { useState } from 'react';
import type { OptimizationReportResponse } from '../../src/contracts/optimization-report';
import type { OptimizationWorkflowRecord } from '../../src/contracts/workflow';
import { api, request } from './api';
import { AgentSessionPanel } from './AgentSessionPanel';
import { Badge, CopyValue, Disclosure, Feedback, Icon, Modal, Panel, download, time } from './components';

export interface CandidateTestingContext { projectId: string; branch: string; commit: string; functionName: string }

export function SourceOptimizationWorkbench({ workflow, response, attached, notify, refresh, projectId, backToList, testCandidate }: {
  workflow: OptimizationWorkflowRecord; response: OptimizationReportResponse | null; attached?: boolean;
  notify: (text: string, bad?: boolean) => void; refresh: () => void; projectId?: string; backToList: () => void;
  testCandidate?: (context: CandidateTestingContext) => void;
}) {
  const [candidateId, setCandidateId] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const report = response?.report;
  const candidate = report?.candidates.find(item => item.candidate.candidate_id === candidateId)
    ?? report?.candidates.find(item => item.candidate.candidate_id === workflow.candidate_id) ?? report?.candidates.at(-1);
  const active = attached !== false && ['CREATED', 'GENERATING'].includes(workflow.status);
  async function readPatch(save = false) {
    if (!candidate) return;
    setBusy(true);
    try {
      const result = await request<{ diff: string }>(`/v1/workflows/${encodeURIComponent(workflow.workflow_id)}/candidates/${encodeURIComponent(candidate.candidate.candidate_id)}/diff`);
      if (save) download(`corepilot-${workflow.function_name}.patch`, result.diff);
      else setDiff(result.diff || '没有源码差异');
    } catch (error) { notify((error as Error).message, true); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try {
      const result = await api.cancelOptimizationWorkflow(workflow.workflow_id) as { ok: boolean; message: string };
      notify(result.ok ? '取消请求已提交，等待后台确认停止。' : result.message, !result.ok); refresh();
    } catch (error) { notify((error as Error).message, true); }
    finally { setBusy(false); }
  }
  return <>
    <div className="detail-navigation"><button className="text-btn" onClick={backToList}><Icon name="back" size={15} />返回优化任务</button></div>
    <div className="page-heading"><div><div className="title-row"><h1>{workflow.function_name}</h1><Badge value={workflow.status} /></div>
      <p>{workflow.source_branch ?? '当前检出版本'} · 仅生成优化代码 · {time(workflow.created_at)}</p></div>
      <div className="actions">{active && <button disabled={busy} onClick={() => void cancel()}>取消任务</button>}
        {candidate && <button disabled={busy} onClick={() => void readPatch(true)}><Icon name="download" size={16} />下载补丁</button>}
        {candidate && projectId && testCandidate && <button className="primary" onClick={() => testCandidate({ projectId, branch: workflow.source_branch ?? '',
          commit: candidate.candidate.source.commit, functionName: workflow.function_name })}>测试这个候选<Icon name="arrow" size={15} /></button>}
      </div>
    </div>
    <dl className="outcome-strip source-outcomes" aria-label="源码优化结果">
      <div><dt>代码实现</dt><dd>{active ? '正在调查与实现' : candidate ? '候选已冻结' : '尚无候选'}<small>{candidate ? '只记录源码变化，不代表优化有效' : '工作过程保留在下方'}</small></dd></div>
      <div><dt>正确性</dt><dd>未验证<small>尚未执行正确性测试</small></dd></div>
      <div><dt>性能</dt><dd>未测量<small>尚无目标机器性能结论</small></dd></div>
    </dl>
    {workflow.error && <Feedback text={workflow.error} bad />}
    {attached === false && ['CREATED', 'GENERATING'].includes(workflow.status) && <div className="notice compact">任务当前未由后台接管，已有源码和过程记录仍保留。可在下方继续原会话。</div>}
    {candidate && <Panel title="源码候选" aside={report && report.candidates.length > 1 && <select aria-label="选择源码候选" value={candidate.candidate.candidate_id} onChange={event => setCandidateId(event.target.value)}>
      {report.candidates.map(item => <option key={item.candidate.candidate_id} value={item.candidate.candidate_id}>候选 {item.candidate.sequence}</option>)}</select>}>
      <div className="source-candidate"><div><strong>{candidate.candidate.source.changed_files.length} 个文件发生变化</strong>
        <p className="hint">此候选可单独测试。未经验证不能批准或正式交付。</p></div><button disabled={busy} onClick={() => void readPatch()}>查看源码差异<Icon name="code" size={15} /></button></div>
      <ul className="source-changed-files">{candidate.candidate.source.changed_files.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
      <Disclosure title="固定源码身份" summary="提交、目录与任务标识"><dl className="definition">
        <dt>源码提交</dt><dd><CopyValue value={candidate.candidate.source.commit} label="候选提交" /></dd>
        <dt>源码树</dt><dd><CopyValue value={candidate.candidate.source.tree} label="源码树" /></dd>
        <dt>任务</dt><dd><CopyValue value={workflow.workflow_id} label="任务标识" /></dd>
      </dl></Disclosure>
    </Panel>}
    <AgentSessionPanel workflow={workflow} attached={attached} notify={notify} refresh={refresh} />
    {!!report?.hypotheses.length && <Disclosure title="优化假设与调查结论" summary={`${report.hypotheses.length} 条记录`}><ul className="stage-facts">
      {report.hypotheses.map(item => <li key={item.hypothesis_id}><strong>{item.description}</strong><span>{item.motivation}</span></li>)}
    </ul></Disclosure>}
    {response && <Disclosure title="报告与原始记录" summary="Markdown / JSON"><div className="actions"><button onClick={() => download('corepilot-source-report.md', response.markdown)}>下载报告</button><button onClick={() => download('corepilot-source-record.json', JSON.stringify(response.report, null, 2))}>下载原始记录</button></div></Disclosure>}
    {diff !== null && <Modal title="候选源码差异" onClose={() => setDiff(null)} wide><pre className="detail-code">{diff}</pre></Modal>}
  </>;
}
