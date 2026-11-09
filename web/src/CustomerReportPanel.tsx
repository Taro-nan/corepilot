import React, { useState } from 'react';
import type { OptimizationReport } from '../../src/contracts/optimization-report';
import { api } from './api';
import { Panel, download, Field, Disclosure, CopyValue, label } from './components';

export function CustomerReportPanel({ report, notify, refresh }: { report: OptimizationReport; notify: (message: string, bad?: boolean) => void; refresh: () => void }) {
  const [busy, setBusy] = useState(false), [dimension, setDimension] = useState('');
  const summary = report.summary, workflow = report.workflow, job = workflow.reproduction;
  if (!summary) return null;
  const dimensions = [...new Set(summary.groups.map(row => row.dimension))];
  const rows = summary.groups.filter(row => row.dimension === (dimension || dimensions[0]));
  const active = !!job && ['PREPARING', 'RUNNING'].includes(job.status);
  const deliveryPending = !!workflow.delivery_operation && workflow.delivery_operation.status !== 'COMPLETED';
  const resources = report.task?.declared_context.resources as { cpu_set?: string; numa_node?: number; thread_counts?: number[] } | undefined;
  const machine = report.task?.declared_context.execution_machine as { name?: string } | undefined;
  const baseline = report.task?.performance_baseline;
  const ratio = (value: number | null) => value === null ? '尚无有效汇总' : value.toFixed(3) + '×';
  async function reproduce() {
    setBusy(true); try { await api.reproduceWorkflow(workflow.workflow_id); notify('已提交干净重建复现：使用原冻结源码与测试，新建实验，不调用模型。'); refresh(); }
    catch (error) { notify((error as Error).message, true); } finally { setBusy(false); }
  }
  return <Panel title={summary.state === 'RUNNING' ? '结果将在验证后形成' : '结果与下一步'} className="customer-report-summary">
    <p className="customer-conclusion">{summary.conclusion}</p>
    {summary.state !== 'RUNNING' && <><dl className="result-facts"><div><dt>首轮 / 独立复验加速比{summary.verification?.ready ? '' : '（待核对）'}</dt><dd>{workflow.enable_performance ? ratio(summary.formal_speedup) + ' / ' + ratio(summary.revalidation_speedup) : '未启用性能测试'}</dd><small>{summary.overall_interval ? '总体区间 ' + ratio(summary.overall_interval.lower) + ' ～ ' + ratio(summary.overall_interval.upper) : '未计算真实区间，不宣称统计置信'}</small></div>
      <div><dt>正确性覆盖范围</dt><dd>{summary.logical_inputs === null ? '逻辑输入未知' : summary.logical_inputs + ' 个逻辑输入'}</dd><small>{summary.correctness_executions} 次测试条件展开；执行次数不等于输入种类</small></div>
      <div><dt>关键退化</dt><dd>{!workflow.enable_performance ? '未测量' : !summary.verification?.ready || summary.formal_speedup === null ? '尚无完整结论' : summary.regressions.length ? summary.regressions.length + ' 组退化' : '已测负载未标记退化'}</dd><small>{summary.regressions.length ? summary.regressions.join('、') : '仅适用于本次声明的负载与资源条件'}</small></div></dl>
      <div className="result-conditions"><strong>本次声明的测试条件</strong><p>{machine?.name ?? '机器名称未记录'} · {resources?.thread_counts?.length ? resources.thread_counts.join(' / ') + ' 线程' : '线程见逐负载记录'} · CPU {resources?.cpu_set ?? '未记录'} · NUMA {resources?.numa_node ?? '未记录'}</p><p>比较对象：{typeof baseline?.details?.library === 'string' ? baseline.details.library + ' · ' + baseline.version : '本次固定比较基线'}；身份与实际资源观测可展开核对。</p></div></>}
    <div className="customer-next-step"><strong>下一步</strong><p>{summary.next_step.message}</p></div>
    {!!rows.length && <Disclosure title={summary.verification?.ready ? '按输入和运行条件查看收益' : '按输入和运行条件查看测量（待核对）'} summary={dimensions.length + ' 个分组维度'}><Field label="分组维度"><select value={dimension || dimensions[0]} onChange={e => setDimension(e.target.value)}>{dimensions.map(name => <option key={name}>{name}</option>)}</select></Field><div className="table-scroll"><table><thead><tr><th>条件</th><th>负载数</th><th>组内加速比</th><th>最慢负载</th></tr></thead><tbody>{rows.map(row => <tr key={row.value}><td>{row.value}</td><td>{row.workloads}</td><td>{row.weighted_speedup.toFixed(4)}×</td><td>{row.worst_speedup.toFixed(4)}×</td></tr>)}</tbody></table></div></Disclosure>}
    <Disclosure title="结果适用范围与尚未验证的内容" summary="输入覆盖、统计口径与可推广范围"><ul>{summary.limits.map(limit => <li key={limit}>{limit}</li>)}</ul></Disclosure>
    <Disclosure title="结果身份与自动化命令" summary="候选、源码、实验和交付标识"><dl className="definition">
      <dt>当前候选</dt><dd>{summary.candidate_id ? <CopyValue value={summary.candidate_id} label="候选标识" /> : '尚未产生'}</dd><dt>冻结源码</dt><dd>{summary.source_commit ? <CopyValue value={summary.source_commit} label="源码提交" /> : '尚未冻结'}</dd>
      <dt>资源等待</dt><dd>{(summary.resource_wait_ms / 1000).toFixed(1)} 秒</dd>{workflow.delivery && <><dt>交付提交</dt><dd><CopyValue value={workflow.delivery.commit} label="交付提交" /></dd></>}
      {summary.next_step.command && <><dt>CLI 操作</dt><dd><CopyValue value={summary.next_step.command} label="自动化命令" /></dd></>}
    </dl></Disclosure>
    <Disclosure title="重建复现与身份清单" summary={job ? '最近复现：' + label(job.status) : '按需在原机器重新构建和测试'} defaultOpen={active}>
    <div className="reproduction-controls"><p className="hint">在原机器的新目录重新解包、构建和测试。这会占用执行机器并追加新实验，保留原交付记录。</p>{deliveryPending && <p>请先核对或撤回未完成的交付请求，再重建复现。</p>}<div className="form-actions">
      <button disabled={busy || active || deliveryPending || !workflow.candidate_id || ['CREATED', 'GENERATING'].includes(workflow.status)} onClick={() => void reproduce()}>{busy ? '正在提交…' : job?.status === 'UNKNOWN' ? '核对并继续原复现' : '在 Runner 重建复现'}</button>
      <button disabled={busy} onClick={() => { setBusy(true); void api.getReproduction(workflow.workflow_id).then(value => download('reproduction.json', JSON.stringify(value, null, 2))).catch(error => notify(error.message, true)).finally(() => setBusy(false)); }}>下载复现说明与身份清单</button>
      {active && <button onClick={() => { void api.cancelReproduction(workflow.workflow_id).then(() => { notify('已请求停止复现，等待 Runner 确认。'); refresh(); }).catch(error => notify(error.message, true)); }}>取消复现</button>}
    </div>{job && <p role="status">重建复现：{label(job.status)} · {job.phase}<br /><CopyValue value={job.experiment_id} label="复现实验标识" />{job.remote_root && <><br />执行目录：<CopyValue value={job.remote_root} label="执行目录" /></>}{job.error && <><br />{job.error}</>}</p>}</div></Disclosure>
  </Panel>;
}
