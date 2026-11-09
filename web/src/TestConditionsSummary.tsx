import React from 'react';
import type { ValidationAssetDraft } from '../../src/contracts/validation-assets';

/** Read-only view of the saved plan; it never supplies measurement defaults. */
export function TestConditionsSummary({ draft }: { draft: ValidationAssetDraft }) {
  const plan = draft.test_plan;
  return <dl className="review-facts test-conditions-summary">
    <div><dt>测试范围</dt><dd>{draft.cases.length} 个正确性输入 · {draft.workloads.length} 组性能负载</dd></div>
    <div><dt>线程与资源</dt><dd>{plan.execution_matrix ? <>{plan.execution_matrix.thread_counts.join(' / ')} 线程{plan.execution_matrix.profiles.map(profile => <span className="resource-review-line" key={profile.id}>{profile.name} · CPU {profile.cpu_set} · NUMA {profile.numa_node} · {profile.cpu_allocation === 'per_thread' ? '每线程分配核心' : '共享核心集合'} · {profile.omp_proc_bind === 'spread' ? '分散绑定' : '紧凑绑定'}</span>)}</>
      : <>{[...new Set(draft.workloads.map(item => item.threads))].join(' / ')} 线程 · CPU {plan.resources.cpu_set || '未指定'} · NUMA {plan.resources.numa_node}</>}</dd></div>
    <div><dt>采样与计时</dt><dd>预热 {plan.sampling.warmup_count} 次 · 每端 {plan.sampling.sample_count} 个样本 · {plan.inner_iterations} 次调用 / 样本 · {plan.timing_scope === 'kernel' ? '仅函数执行' : '端到端'}计时</dd></div>
    <div><dt>正确性规则</dt><dd>绝对误差 {draft.tolerance_absolute} · 相对误差 {draft.tolerance_relative}<details className="correctness-rule"><summary>查看独立参考与判定规则</summary><p>{draft.oracle_description}</p><p>{draft.tolerance_rule}</p></details></dd></div>
    <div><dt>关键负载</dt><dd>{draft.workloads.filter(item => item.critical).length} 组 · 使用已保存的权重和验收规则</dd></div>
  </dl>;
}
