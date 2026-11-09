import React, { useState } from 'react';
import type { TestingTaskDetails } from '../../../src/contracts/testing';
import { api } from '../api';
import { Badge, CopyValue, Disclosure, Field, Icon, Panel, download, label, time } from '../components';
import { TestingConditions } from './TestingConditions';
import { testingActive, testingPhaseLabel } from './testing-draft';

const ratio = (value: number | null) => value === null ? '—' : value.toFixed(3) + '×';
const seconds = (value: number | null) => value === null ? '—' : value.toPrecision(5);
export function TestingResult({ details, back, refresh, notify, optimize }: {
  details: TestingTaskDetails; back: () => void; refresh: () => void; notify: (text: string, bad?: boolean) => void;
  optimize: (projectId: string, branch: string, functionName: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const { task, summary } = details;
  const localOnly = !!details.observation;
  const active = testingActive(task.execution.status);
  const source = task.input.candidate.kind === 'source' ? task.input.candidate : null;
  const command = details.commands[commandIndex];
  async function cancel() {
    setBusy(true);
    try { await api.testing.cancel(task.task_id); refresh(); notify('取消请求已提交，后台确认停止后会更新状态。'); }
    catch (error) { notify((error as Error).message, true); }
    finally { setBusy(false); }
  }
  return <>
    <div className="detail-navigation"><button className="text-btn" onClick={back}><Icon name="back" size={15} />返回测试任务</button></div>
    <div className="page-heading"><div><div className="title-row"><h1>{task.name}</h1><Badge value={task.execution.status} /></div>
      <p>{task.plan.function_name} · {task.machine.name} · {time(task.created_at)}</p></div>
      <div className="actions"><button onClick={() => download('corepilot-test-result.json', JSON.stringify(details, null, 2))}><Icon name="download" size={16} />下载结果</button>
        {active && <button disabled={busy || localOnly || task.execution.cancel_requested} onClick={() => void cancel()}>{task.execution.cancel_requested ? '等待停止确认' : '取消测试'}</button>}
        {!active && source && <button className="primary" onClick={() => optimize(source.project_id, source.branch, task.plan.function_name)}>优化待测源码<Icon name="arrow" size={15} /></button>}
      </div>
    </div>
    {details.observation && <p className="notice compact" role="status">{details.observation.message}</p>}
    <dl className="outcome-strip testing-outcomes" aria-label="测试结果">
      <div><dt>执行</dt><dd>{label(task.execution.status)}<small>{task.execution.cancel_requested ? '已请求取消，终态以 Runner 确认为准' : task.execution.message || '执行状态不代表测试通过'}</small></dd></div>
      <div><dt>正确性</dt><dd>{label(summary.correctness.status)}<small>{summary.correctness.status === 'NOT_REQUESTED' ? '本次未选择正确性测试' : `${summary.correctness.status === 'UNVERIFIED' ? '原始记录：' : ''}${summary.correctness.passed} / ${summary.correctness.planned} 通过 · ${summary.correctness.failed} 失败`}</small></dd></div>
      <div><dt>性能</dt><dd>{label(summary.performance.status)}<small>{summary.performance.status === 'UNVERIFIED'
        ? `${summary.performance.measured} / ${summary.performance.planned} 条原始样本，库身份待核对`
        : summary.performance.speedup === null ? `${summary.performance.measured} / ${summary.performance.planned} 个有效样本` : `${ratio(summary.performance.speedup)} · 相对比较对象 A`}</small></dd></div>
    </dl>
    {active && <section className="run-progress" aria-label="测试执行进展"><div><h2>{task.execution.status !== 'UNKNOWN' && <span className="pulse" />}{task.execution.status === 'UNKNOWN' ? '核对原作业状态' : testingPhaseLabel(task.execution.phase)}</h2>
      {task.execution.message && <p>{task.execution.message}</p>}
      <p>{localOnly ? '仅显示上次保存的状态，未向 Runner 查询或发送取消请求。' : task.execution.status === 'UNKNOWN' ? '正在查询原作业；不会重复提交。' : '关闭页面后后台继续运行，刷新可查看真实进展。'}</p></div><small>最近更新 {time(task.updated_at)}</small></section>}
    {task.execution.failure && <div className="notice"><strong>{task.execution.failure.message}</strong><p>请检查本次配置和下方执行记录。修复后创建新的测试，原任务会保留。</p><small>{task.execution.failure.stage} · {task.execution.failure.code}</small></div>}
    {!!summary.provenance_issues?.length && <div className="notice compact" role="status"><strong>库身份待核对</strong><p>{summary.provenance_issues.join('；')}</p></div>}
    {!!summary.performance.issues.length && <div className="notice compact"><strong>性能结论的限制</strong><p>{summary.performance.issues.join('；')}</p></div>}
    <div className="testing-scope"><strong>独立测试结果</strong><span>{summary.conclusion_scope}</span><small>未产生优化批准或交付记录。</small></div>
    <Panel title="比较对象"><div className="testing-subject-identities">{(['candidate', 'baseline'] as const).map(role => {
      const subject = task.subjects[role];
      return <section key={role}><h3>{role === 'candidate' ? '待测对象 B' : '比较对象 A'}</h3>{subject ? <><strong>{subject.name} · {subject.version}</strong><p>{subject.kind === 'source' ? '源码构建' : '固定库包'}</p>
        {subject.source && <p>分支 {subject.source.branch}</p>}<Disclosure title="对象身份与产物" summary={subject.source ? '源码提交、构建与产物' : '库包摘要与入口'}><dl className="definition">
          {subject.source && <><dt>源码提交</dt><dd><CopyValue value={subject.source.commit} label="源码提交" /></dd><dt>构建目录</dt><dd><CopyValue value={subject.source.build_root} label="构建目录" /></dd></>}
          <dt>产物</dt><dd><CopyValue value={subject.artifact_path} label="产物位置" /></dd><dt>产物摘要</dt><dd>{subject.artifact_sha256 ? <CopyValue value={subject.artifact_sha256} label="产物摘要" /> : '构建后由执行记录核对'}</dd>
        </dl></Disclosure></> : <p className="hint">{role === 'baseline' && !task.input.baseline ? '本次未指定比较对象' : '正在准备并固定对象身份'}</p>}</section>;
    })}</div></Panel>
    {!!summary.comparisons.length && <Panel title="逐负载性能" aside={<span className="muted">加速比大于 1 表示 B 更快 · 单位：秒</span>}><div className="table-scroll"><table><thead><tr><th>负载</th><th>线程</th><th>A 中位数</th><th>B 中位数</th><th>加速比</th><th>区间与结论</th></tr></thead><tbody>{summary.comparisons.map(row => <tr key={row.workload_id} className={row.conclusion === 'REGRESSED' ? 'regression-row' : ''}>
      <td><strong>{row.workload_id}</strong>{row.critical && <small>关键负载</small>}<details className="row-identity"><summary>输入与样本</summary><pre>{JSON.stringify({ parameters: row.parameters, baseline_samples: row.baseline_samples, candidate_samples: row.candidate_samples }, null, 2)}</pre></details></td>
      <td>{row.threads}</td><td>{seconds(row.baseline_median)}</td><td>{seconds(row.candidate_median)}</td><td>{ratio(row.speedup)}</td><td>{row.interval ? `${ratio(row.interval.lower)} ～ ${ratio(row.interval.upper)}` : '未计算区间'}<small>{label(row.conclusion)}</small></td>
    </tr>)}</tbody></table></div></Panel>}
    {(summary.correctness.failed > 0 || summary.correctness.missing.length > 0 || summary.correctness.invalid.length > 0) && <Disclosure title="正确性明细" summary={`${summary.correctness.failed} 失败 · ${summary.correctness.missing.length} 未取得结果 · ${summary.correctness.invalid.length} 无效`}>
      <pre className="detail-code">{JSON.stringify(summary.correctness, null, 2)}</pre></Disclosure>}
    <TestingConditions plan={task.plan} mode={task.input.mode} />
    <Disclosure title="执行日志与诊断" summary={`${details.commands.length} 条命令 · ${details.measurements.length} 条测量`}>
      {details.commands.length > 0 ? <><Field label="查看执行命令"><select value={commandIndex} onChange={event => setCommandIndex(Number(event.target.value))}>{details.commands.map((item, index) => <option key={index} value={index}>命令 {index + 1} · {item.command}</option>)}</select></Field>
        <pre className="detail-code">{JSON.stringify(command, null, 2)}</pre></> : <p className="hint">尚无已执行命令。准备阶段的原因显示在上方。</p>}
      {details.output && <details><summary>Runner 输出</summary><pre className="detail-code">{JSON.stringify(details.output, null, 2)}</pre></details>}
    </Disclosure>
    <Disclosure title="任务与执行机器身份" summary="任务标识、远端目录和机器信息"><dl className="definition"><dt>任务标识</dt><dd><CopyValue value={task.task_id} label="任务标识" /></dd>
      <dt>远端工作目录</dt><dd><CopyValue value={task.workspace.run_root} label="工作目录" /></dd></dl><pre className="detail-code">{JSON.stringify(task.machine.hardware, null, 2)}</pre></Disclosure>
  </>;
}
