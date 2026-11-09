import React from 'react';
import type { CorrectnessPlanProposal } from '../../src/contracts/validation-assets';

export function CorrectnessPlanReview({ proposal, stale, busy, onAdopt, onEdit }: {
  proposal: CorrectnessPlanProposal; stale: boolean; busy: boolean;
  onAdopt: () => void; onEdit: () => void;
}) {
  return <section className="correctness-plan-review" aria-label="AI 正确性方案建议">
    <div className="test-section-heading"><strong>正确性方案建议</strong><span className="setup-state review">待你采用</span></div>
    <p>{proposal.summary}</p>
    <div className="correctness-plan-reference"><strong>独立参考与通过标准</strong><p>{proposal.oracle_description}</p></div>
    <div className="correctness-plan-reference"><strong>误差建议</strong><p>{proposal.tolerance_rule}</p><p>绝对误差：<code>{proposal.tolerance_absolute}</code> · 相对误差：<code>{proposal.tolerance_relative}</code></p></div>
    <details open><summary>正确性输入 · {proposal.cases.length} 组</summary><div className="test-table-scroll"><table><thead><tr><th>用例</th><th>输入参数</th></tr></thead><tbody>{proposal.cases.map(item => <tr key={item.case_id}><td>{item.case_id}</td><td>{Object.entries(item.parameters).map(([key, value]) => <span className="correctness-plan-parameter" key={key}><code>{key}</code> = {String(value)}</span>)}</td></tr>)}</tbody></table></div></details>
    {proposal.cases.some(item => item.input_generation) && <details><summary>输入数据生成规则</summary>{proposal.cases.map(item => <p key={item.case_id}><strong>{item.case_id}</strong>：{item.input_generation || '保留现有规则'}</p>)}</details>}
    <details open><summary>设计依据与待确认事项</summary><p>{proposal.rationale}</p>{!!proposal.assumptions.length && <ul>{proposal.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul>}<p className="hint">源码依据：{proposal.evidence_files.join('、')}。源码版本：{proposal.source_commit?.slice(0, 12) ?? '当前工作目录'}。</p></details>
    <p className="hint">采用后保存为测试方案草稿，再调用已配置的模型生成代码。线程、绑核、采样、性能输入和比较基线沿用现有设置；测试结果以目标机实际执行为准。</p>
    {stale && <p className="hint">当前有修改或测试版本已变化。请先保存条件并重新起草，避免覆盖你的编辑。</p>}
    <div className="form-actions"><button type="button" className="primary" disabled={busy || stale} onClick={onAdopt}>采用方案并生成正确性代码</button><button type="button" disabled={busy || stale} onClick={onEdit}>放入编辑器调整</button></div>
  </section>;
}
