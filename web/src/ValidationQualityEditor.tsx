import React from 'react';
import type { ValidationQualityPlan, ValidationQualityResult } from '../../src/contracts/validation-quality';
import { Field } from './components';

export function ValidationQualityEditor({ value, inputIds, onChange }: { value?: ValidationQualityPlan; inputIds: string[]; onChange: (value: ValidationQualityPlan) => void }) {
  const plan = value ?? { schema_version: 1, coverage: [], probes: [] };
  return <details className="test-secondary-section validation-quality"><summary>测试覆盖与已知错误检验 · {plan.coverage.length} 项覆盖，{plan.probes.length} 个错误实现</summary>
    <p className="hint">通过次数说明执行情况。这里记录输入实际覆盖的语义，并用同一套正确性程序测试已知错误实现，确认它能发现错误。AI 生成正确性代码时可一并起草，已有资产也可自行填写和上传。</p>
    {plan.coverage.map((row, index) => <div className="test-profile-card" key={index}><div className="field-grid">
      <Field label={`覆盖维度 ${index + 1}`}><input value={row.dimension} onChange={e => onChange({ ...plan, coverage: plan.coverage.map((item, i) => i === index ? { ...item, dimension: e.target.value } : item) })} /></Field>
      <Field label="覆盖状态"><select aria-label="覆盖状态" value={row.status} onChange={e => onChange({ ...plan, coverage: plan.coverage.map((item, i) => i === index ? { ...item, status: e.target.value as typeof row.status } : item) })}><option value="UNKNOWN">尚未确认</option><option value="COVERED">有输入覆盖</option><option value="NOT_APPLICABLE">当前 API 不适用</option></select></Field>
      <Field label="覆盖依据"><input value={row.rationale} onChange={e => onChange({ ...plan, coverage: plan.coverage.map((item, i) => i === index ? { ...item, rationale: e.target.value } : item) })} /></Field>
      <Field label="逻辑输入 ID（逗号分隔）"><input value={row.input_ids.join(',')} onChange={e => onChange({ ...plan, coverage: plan.coverage.map((item, i) => i === index ? { ...item, input_ids: e.target.value.split(',').map(id => id.trim()).filter(Boolean) } : item) })} /></Field>
    </div><button type="button" onClick={() => onChange({ ...plan, coverage: plan.coverage.filter((_, i) => i !== index) })}>移除此覆盖项</button></div>)}
    <button type="button" onClick={() => onChange({ ...plan, coverage: [...plan.coverage, { dimension: '', status: 'UNKNOWN', input_ids: [], rationale: '待核对 API 和输入生成规则' }] })}>添加覆盖维度</button>
    <p className="hint">可用逻辑输入：{inputIds.join('、') || '先添加正确性输入'}。按实际 API 选择尾部/尺寸、stride、对齐、别名、浮点边界等维度。</p>
    {plan.probes.map((probe, index) => <div className="test-profile-card" key={index}><div className="field-grid">
      <Field label={`错误实现 ID ${index + 1}`}><input value={probe.probe_id} onChange={e => onChange({ ...plan, probes: plan.probes.map((item, i) => i === index ? { ...item, probe_id: e.target.value } : item) })} /></Field>
      <Field label="故意引入的错误"><input value={probe.defect} onChange={e => onChange({ ...plan, probes: plan.probes.map((item, i) => i === index ? { ...item, defect: e.target.value } : item) })} /></Field>
      <Field label="错误库产物（相对运行目录）"><input value={probe.artifact} placeholder="sensitivity/missing-tail.so" onChange={e => onChange({ ...plan, probes: plan.probes.map((item, i) => i === index ? { ...item, artifact: e.target.value } : item) })} /></Field>
      <Field label="检验输入 ID（逗号分隔）"><input value={probe.input_ids.join(',')} onChange={e => onChange({ ...plan, probes: plan.probes.map((item, i) => i === index ? { ...item, input_ids: e.target.value.split(',').map(id => id.trim()).filter(Boolean) } : item) })} /></Field>
    </div><button type="button" onClick={() => onChange({ ...plan, probes: plan.probes.filter((_, i) => i !== index) })}>移除此错误实现</button></div>)}
    <button type="button" onClick={() => onChange({ ...plan, probes: [...plan.probes, { probe_id: `fault-${plan.probes.length + 1}`, defect: '', artifact: `sensitivity/fault-${plan.probes.length + 1}.so`, input_ids: inputIds.slice(0, 1) }] })}>添加错误实现检验</button>
    <p className="hint">在「测试代码」上传同 ABI 的错误实现源文件，并让测试程序构建脚本将其编译到 runtime_root/sensitivity/。试运行会执行它；编译失败、崩溃和缺失测量均不算识别成功。</p>
  </details>;
}

export function ValidationQualitySummary({ quality }: { quality?: ValidationQualityResult }) {
  if (!quality) return <p className="hint">本版未记录测试辨别力验证；通过数不能证明完整 API 覆盖。</p>;
  return <div className="quality-summary"><p><strong>语义覆盖与辨别力</strong>：{quality.logical_inputs} 个逻辑输入，{quality.correctness_executions} 次条件展开；{quality.status === 'PASSED' ? '已识别所声明的错误实现' : quality.status === 'FAILED' ? '存在未识别的错误实现' : quality.status === 'PENDING' ? '错误实现检验未完成' : '尚未配置错误实现检验'}。</p>
    {quality.probes.map(probe => <p key={probe.probe_id}>{probe.probe_id} · {probe.defect}：{probe.detected ? `已识别（${probe.detecting_inputs.join('、')}）` : '尚未识别'}</p>)}
    {!!quality.unknown_dimensions.length && <p className="hint">尚未确认覆盖：{quality.unknown_dimensions.join('、')}</p>}
    {!!quality.coverage.length && <details><summary>查看覆盖依据及未知项</summary>{quality.coverage.map(row => <p key={row.dimension}>{row.dimension} · {row.status} · {row.input_ids.join('、')}：{row.rationale}</p>)}</details>}
  </div>;
}
