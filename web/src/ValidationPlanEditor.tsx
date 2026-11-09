import React, { useState } from 'react';
import type { ValidationPreparationContext, ValidationTestPlan } from '../../src/contracts/validation-assets';
import { expandCpuSet, formatCpuSet } from '../../src/config/cpu-set';
import { Field } from './components';
import { DEFAULT_STATISTICS } from '../../src/contracts/performance-statistics';

type Matrix = NonNullable<ValidationTestPlan['execution_matrix']>;
export function ValidationPlanEditor({ plan, context, onChange, caseCount, workloadCount, threadInput, onThreadInputChange }: {
  plan: ValidationTestPlan; context: ValidationPreparationContext | null; onChange: (plan: ValidationTestPlan) => void;
  caseCount: number; workloadCount: number; threadInput?: string; onThreadInputChange: (value?: string) => void;
}) {
  const nodes = Object.entries(context?.machine?.hardware.cpu_topology?.node_cpu_lists ?? {}).map(([name, cpus]) => ({ node: Number(name.replace('node', '')), cpus }));
  const matrix = plan.execution_matrix;
  const [error, setError] = useState('');
  const updateMatrix = (value: Matrix) => { setError(''); onChange({ ...plan, execution_matrix: value }); };
  function startMatrix() {
    const node = nodes.find(item => item.node === plan.resources.numa_node) ?? nodes[0];
    if (!node) return;
    updateMatrix({ thread_counts: [1], profiles: [{ id: 'profile1', name: `节点 ${node.node} · 按线程分配 CPU`, cpu_set: node.cpus, numa_node: node.node, cpu_allocation: 'per_thread', omp_proc_bind: 'close' }] });
  }
  function updateProfile(index: number, patch: Partial<Matrix['profiles'][number]>) { updateMatrix({ ...matrix!, profiles: matrix!.profiles.map((item, i) => i === index ? { ...item, ...patch } : item) }); }
  function addProfile() {
    let index = matrix!.profiles.length + 1; while (matrix!.profiles.some(item => item.id === `profile${index}`)) index++;
    const node = nodes.find(item => !matrix!.profiles.some(profile => profile.numa_node === item.node)) ?? nodes[0];
    const previous = matrix!.profiles[0];
    updateMatrix({ ...matrix!, profiles: [...matrix!.profiles, { ...previous, id: `profile${index}`, name: `运行配置 ${index}`, ...(node ? { cpu_set: node.cpus, numa_node: node.node } : {}) }] });
  }
  let combinations: Array<{ name: string; threads: number; cpus: string; numa: number; placement: string }> = [];
  let validation = '';
  try {
    if (matrix) combinations = matrix.profiles.flatMap(profile => matrix.thread_counts.map(threads => {
      const pool = expandCpuSet(profile.cpu_set);
      if (threads > pool.length) throw new Error(`“${profile.name}”只有 ${pool.length} 个 CPU，不能运行 ${threads} 线程`);
      return { name: profile.name, threads, cpus: formatCpuSet(profile.cpu_allocation === 'per_thread' ? pool.slice(0, threads) : pool), numa: profile.numa_node, placement: profile.omp_proc_bind };
    }));
  } catch (failure) { validation = (failure as Error).message; }
  const factor = matrix ? matrix.profiles.length * matrix.thread_counts.length : 1;
  const commands = 2 + caseCount * factor + workloadCount * factor * 2 * (plan.sampling.warmup_count + plan.sampling.sample_count);
  const presets = [{ id: 'quick', title: '快速检查', detail: '1 次预热 · 每端 3 个样本', warmup: 1, samples: 3 },
    { id: 'repeat', title: '重复测量', detail: '3 次预热 · 每端 9 个样本', warmup: 3, samples: 9 }];
  const selectedPreset = presets.find(item => item.warmup === plan.sampling.warmup_count && item.samples === plan.sampling.sample_count);
  return <>
    <div className="test-plan"><div className="test-section-heading"><strong>线程与绑核方案</strong><span className="hint">两库使用相同配置，逐组执行</span></div>
      <p className="hint">输入尺寸只需填写一次。系统将按所选线程数和运行配置展开测试，分别保留每组结果。</p>
      {!matrix ? <div className="test-matrix-start"><p>当前沿用单一资源配置：CPU {plan.resources.cpu_set || '待选择'} · NUMA {plan.resources.numa_node}，线程数按现有输入表执行。</p>
        <button type="button" className="primary" disabled={!nodes.length} onClick={startMatrix}>配置多线程与绑核对比</button>{!nodes.length && <small>连接并保存执行机器后，可按真实 NUMA 拓扑选择。</small>}</div>
      : <>
        <div className="thread-selection"><strong>要测试的线程数</strong><div className="thread-chips">{[1, 2, 4, 8, 16, 32, 64].map(n => <button key={n} type="button" aria-pressed={matrix.thread_counts.includes(n)} onClick={() => {
          const next = matrix.thread_counts.includes(n) ? matrix.thread_counts.filter(value => value !== n) : [...matrix.thread_counts, n].sort((a, b) => a - b);
          if (next.length) updateMatrix({ ...matrix, thread_counts: next });
        }}>{n} 线程</button>)}</div>
          <details open={threadInput !== undefined || undefined}><summary>其他线程数</summary><div className="test-parameter-add"><input aria-label="自定义线程数" value={threadInput ?? '1, 2, 4, 8'} onChange={e => onThreadInputChange(e.target.value)} /><button type="button" onClick={() => {
            const counts = [...new Set((threadInput ?? '1, 2, 4, 8').trim().split(/[,，\s]+/).map(Number))].sort((a, b) => a - b);
            if (!counts.length || counts.length > 16 || counts.some(n => !Number.isSafeInteger(n) || n < 1 || n > 65536)) { setError('请输入不重复的正整数线程数，例如 1, 3, 6, 12'); return; }
            updateMatrix({ ...matrix, thread_counts: counts }); onThreadInputChange(undefined);
          }}>应用线程数</button>{threadInput !== undefined && <button type="button" onClick={() => { onThreadInputChange(undefined); setError(''); }}>放弃输入</button>}</div>{threadInput !== undefined && <p className="hint">线程数尚未应用到测试方案。</p>}</details>
        </div>
        {matrix.profiles.map((profile, index) => <div className="execution-profile" key={profile.id}><div className="test-section-heading"><strong>运行配置 {index + 1}</strong><button type="button" disabled={matrix.profiles.length <= 1} onClick={() => updateMatrix({ ...matrix, profiles: matrix.profiles.filter((_, i) => i !== index) })}>移除配置</button></div>
          <div className="validation-script-grid"><Field label={`运行配置 ${index + 1} 名称`}><input value={profile.name} onChange={e => updateProfile(index, { name: e.target.value })} /></Field>
            <Field label={`运行配置 ${index + 1} NUMA 节点`}><select aria-label={`运行配置 ${index + 1} NUMA 节点`} value={profile.numa_node} onChange={e => { const node = nodes.find(item => item.node === Number(e.target.value)); if (node) updateProfile(index, { numa_node: node.node, cpu_set: node.cpus }); }}>{nodes.map(node => <option key={node.node} value={node.node}>节点 {node.node} · CPU {node.cpus}</option>)}</select></Field>
            <Field label={`运行配置 ${index + 1} CPU 分配`}><select aria-label={`运行配置 ${index + 1} CPU 分配`} value={profile.cpu_allocation} onChange={e => updateProfile(index, { cpu_allocation: e.target.value as 'per_thread' | 'shared' })}><option value="per_thread">按线程数限制 CPU 数</option><option value="shared">始终使用整个 CPU 池</option></select></Field>
          </div><p className="hint">{profile.cpu_allocation === 'per_thread' ? 'N 线程使用池中编号最小的 N 个 CPU。' : '所有线程数使用同一个 CPU 集合，便于比较固定资源下的扩展性。'}内存绑定到所选节点。实际 CPU 集合见下方预览。</p>
          <details><summary>自定义 CPU 与 OpenMP 放置</summary><div className="validation-script-grid"><Field label={`运行配置 ${index + 1} CPU 池`}><input value={profile.cpu_set} onChange={e => updateProfile(index, { cpu_set: e.target.value })} /></Field><Field label={`运行配置 ${index + 1} OpenMP 放置`}><select value={profile.omp_proc_bind} onChange={e => updateProfile(index, { omp_proc_bind: e.target.value as 'close' | 'spread' })}><option value="close">close · 紧凑放置</option><option value="spread">spread · 分散放置</option></select></Field></div><p className="hint">CPU 池需位于所选 NUMA 节点内。OpenMP 放置用于支持该设置的运行库；Runner 记录施加的环境与观测，不将其视为任意库的逐线程映射保证。</p></details>
        </div>)}
        <div className="form-actions"><button type="button" disabled={matrix.profiles.length >= 8} onClick={addProfile}>添加另一组绑核配置</button><button type="button" className="text-btn" onClick={() => { if (threadInput !== undefined) { setError('请先应用或放弃自定义线程数。'); return; } const { execution_matrix: _matrix, ...previous } = plan; onChange(previous); }}>使用原有逐行线程配置</button></div>
        {!validation && <details className="execution-preview" open><summary>执行预览 · {combinations.length} 组线程与绑核组合</summary><div className="test-table-scroll"><table><thead><tr><th>运行配置</th><th>线程</th><th>CPU 集合</th><th>内存节点</th><th>OpenMP</th></tr></thead><tbody>{combinations.map((row, i) => <tr key={i}><td>{row.name}</td><td>{row.threads}</td><td>{row.cpus}</td><td>{row.numa}</td><td>{row.placement}</td></tr>)}</tbody></table></div></details>}
      </>}
      {(error || validation) && <p role="alert" className="test-condition-error">{error || validation}</p>}
      {!matrix && <details><summary>高级：原有单一资源配置</summary><div className="validation-script-grid"><Field label="CPU 集合"><input aria-label="CPU 集合" value={plan.resources.cpu_set} onChange={e => onChange({ ...plan, resources: { ...plan.resources, cpu_set: e.target.value } })} /></Field><Field label="NUMA 节点"><input type="number" min="0" value={plan.resources.numa_node} onChange={e => onChange({ ...plan, resources: { ...plan.resources, numa_node: Number(e.target.value) } })} /></Field></div></details>}
    </div>
    <div className="test-plan"><div className="test-section-heading"><strong>测量方式</strong><span className="hint">当前：{selectedPreset?.title ?? '自定义采样'}</span></div>
      <div className="measurement-presets">{presets.map(item => <button type="button" key={item.id} aria-pressed={selectedPreset?.id === item.id} onClick={() => onChange({ ...plan, statistics: item.id === 'repeat' ? { ...DEFAULT_STATISTICS, seed: plan.seed } : undefined, sampling: { ...plan.sampling, warmup_count: item.warmup, sample_count: item.samples, order: 'alternating' } })}><strong>{item.title}</strong><small>{item.detail}</small></button>)}</div>
      <p className="hint">{plan.statistics ? `${Math.round(plan.statistics.confidence_level * 100)}% 配对分块 bootstrap 区间；至少每端 ${plan.statistics.min_samples} 个样本。区间跨越验收线会显示证据不足。` : '当前沿用点估计判定；重复测量预设会启用真实统计区间。'}</p>
      <details><summary>统计判定方法与固定参数</summary><label className="checkbox"><input type="checkbox" checked={!!plan.statistics} onChange={e => onChange({ ...plan, statistics: e.target.checked ? { ...DEFAULT_STATISTICS, seed: plan.seed } : undefined, sampling: { ...plan.sampling, sample_count: e.target.checked ? Math.max(9, plan.sampling.sample_count) : plan.sampling.sample_count } })} />使用真实统计区间</label>
        {plan.statistics && <><p className="hint">在每个负载内按相邻配对样本分块重采样；总体区间对应固定权重几何平均。逐负载区间按声明负载数校正，分别检查全部负载和关键负载退化线。不会自动加测直到通过。</p><div className="field-grid">
          <Field label="置信水平"><input type="number" min="0.8" max="0.99" step="0.01" value={plan.statistics.confidence_level} onChange={e => onChange({ ...plan, statistics: { ...plan.statistics!, confidence_level: Number(e.target.value) } })} /></Field>
          <Field label="重采样次数"><input type="number" min="1000" max="20000" value={plan.statistics.iterations} onChange={e => onChange({ ...plan, statistics: { ...plan.statistics!, iterations: Number(e.target.value) } })} /></Field>
          <Field label="相邻样本分块长度"><input type="number" min="1" max={plan.statistics.min_samples} value={plan.statistics.block_length} onChange={e => onChange({ ...plan, statistics: { ...plan.statistics!, block_length: Number(e.target.value) } })} /></Field>
          <Field label="统计重采样种子"><input type="number" min="0" max="4294967295" value={plan.statistics.seed} onChange={e => onChange({ ...plan, statistics: { ...plan.statistics!, seed: Number(e.target.value) } })} /></Field>
        </div></>}
      </details>
      <Field label="计时范围"><select value={plan.timing_scope} onChange={e => onChange({ ...plan, timing_scope: e.target.value as ValidationTestPlan['timing_scope'] })}><option value="kernel">函数执行 · 排除输入准备与格式转换</option><option value="end-to-end">端到端 · 包含输入准备与格式转换</option></select></Field>
      <details className="sampling-advanced"><summary>高级采样设置 · 预热 {plan.sampling.warmup_count} 次，每端 {plan.sampling.sample_count} 个样本 · {plan.inner_iterations} 次调用 / 样本 · seed {plan.seed}</summary><p className="hint">每个样本单独启动测试进程；样本内调用次数用于摊薄计时开销。参数会固定保存，两端保持一致，AI 不决定这些值。</p>
        <div className="validation-script-grid"><Field label="预热次数"><input type="number" min="0" max="100" value={plan.sampling.warmup_count} onChange={e => onChange({ ...plan, sampling: { ...plan.sampling, warmup_count: Number(e.target.value) } })} /></Field><Field label="每端采样次数"><input type="number" min="1" max="100" value={plan.sampling.sample_count} onChange={e => onChange({ ...plan, sampling: { ...plan.sampling, sample_count: Number(e.target.value) } })} /></Field>
          <Field label="每个样本调用次数"><input type="number" min="1" value={plan.inner_iterations} onChange={e => onChange({ ...plan, inner_iterations: Number(e.target.value) })} /></Field><Field label="固定随机种子"><input type="number" min="0" max="4294967295" value={plan.seed} onChange={e => onChange({ ...plan, seed: Number(e.target.value) })} /></Field>
          <Field label="两端测量顺序"><select value={plan.sampling.order} onChange={e => onChange({ ...plan, sampling: { ...plan.sampling, order: e.target.value as 'paired' | 'alternating' } })}><option value="paired">逐样本配对：基线 → 当前库</option><option value="alternating">交替先后：基线先、当前库先轮换</option></select></Field></div></details>
      <div className="execution-budget"><strong>本次测试规模</strong><p>{caseCount} 个正确性输入 × {factor} 组配置；{workloadCount} 个性能输入 × {factor} 组配置 × 两端 {plan.sampling.sample_count} 个样本。</p><p>含构建、预热约 {commands} 条执行命令。各组分别比较，不混合不同线程与绑核条件的原始样本。</p>{commands > 2048 && <p role="alert">超过单次 2048 条命令，请减少组合或采样次数。</p>}</div>
    </div>
  </>;
}
