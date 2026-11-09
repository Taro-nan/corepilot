import React from 'react';
import type { TestingMode, TestingPlanPreview } from '../../../src/contracts/testing';
import { CopyValue, Disclosure } from '../components';

export function TestingConditions({ plan, mode }: { plan: TestingPlanPreview; mode: TestingMode }) {
  const conditions = plan.test_plan;
  const brief = (value: string) => value.length > 220 ? value.slice(0, 220) + '…' : value;
  const entries = mode === 'correctness' ? plan.cases : mode === 'performance' ? plan.workloads : [...plan.cases, ...plan.workloads];
  return <section className="submission-review testing-conditions" aria-label="本次测试条件">
    <div className="review-heading"><h3>{plan.function_name}</h3><span>沿用已保存条件</span></div>
    <dl className="review-facts">
      <div><dt>测试范围</dt><dd>{mode !== 'performance' && <span>{plan.cases.length} 个正确性用例</span>}{mode === 'both' && ' · '}{mode !== 'correctness' && <span>{plan.workloads.length} 组性能负载</span>}</dd></div>
      <div><dt>线程与资源</dt><dd>{conditions.execution_matrix ? <>{conditions.execution_matrix.thread_counts.join(' / ')} 线程
        {conditions.execution_matrix.profiles.map(profile => <span className="resource-review-line" key={profile.id}>{profile.name} · CPU {profile.cpu_set} · NUMA {profile.numa_node} · {profile.omp_proc_bind === 'spread' ? '分散绑定' : profile.omp_proc_bind === 'close' ? '紧凑绑定' : '未指定线程亲和'}</span>)}</>
        : <>{[...new Set(entries.map(item => item.threads))].join(' / ')} 线程 · CPU {conditions.resources.cpu_set || '未指定'} · NUMA {conditions.resources.numa_node}</>}</dd></div>
      {mode !== 'correctness' && <div><dt>采样与计时</dt><dd>预热 {conditions.sampling.warmup_count} 次 · 每端 {conditions.sampling.sample_count} 个样本 · {conditions.inner_iterations} 次调用 / 样本 · {conditions.timing_scope === 'kernel' ? '函数' : '端到端'}计时</dd></div>}
      {mode !== 'performance' && <><div><dt>正确性依据</dt><dd>{plan.correctness?.definition ? brief(plan.correctness.definition) : '此历史方案未记录摘要，请核对原测试规则。'}</dd></div>
        <div><dt>误差与通过标准</dt><dd>{plan.correctness ? <>{brief(plan.correctness.tolerance.rule)}<small>绝对误差 {plan.correctness.tolerance.absolute} · 相对误差 {plan.correctness.tolerance.relative}</small></> : '未记录；不能据此推定零误差'}</dd></div></>}
      <div><dt>规则版本</dt><dd>{plan.evaluator.version}<small>{plan.evaluator.qualification === 'QUALIFIED' ? '已取得资格的规则版本' : '草稿规则 · 本次用于独立测试'}</small></dd></div>
    </dl>
    <Disclosure title="输入与版本详情" summary="逐输入参数、采样规则和固定摘要">
      <dl className="definition"><dt>测试方案</dt><dd>{plan.evaluator.id} · {plan.evaluator.version}</dd><dt>测试规则摘要</dt><dd><CopyValue value={plan.evaluator.digest} label="测试规则摘要" /></dd>{plan.correctness && <><dt>参考实现</dt><dd>{plan.correctness.reference.implementation} · {plan.correctness.reference.accumulation}</dd></>}</dl>
      <pre className="detail-code">{JSON.stringify({ correctness: mode === 'performance' ? undefined : plan.correctness, cases: mode === 'performance' ? undefined : plan.cases, workloads: mode === 'correctness' ? undefined : plan.workloads, test_plan: conditions }, null, 2)}</pre>
    </Disclosure>
  </section>;
}
