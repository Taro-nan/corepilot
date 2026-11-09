import React, { useState } from 'react';
import type { FormalCaseDefinition, FormalWorkloadDefinition } from '../../src/contracts/formal-evaluator';
import { parseValidationInputs } from '../../src/evaluator/validation-inputs';

type Entry = FormalCaseDefinition | FormalWorkloadDefinition;
export interface ValidationInventoryScratch { parameter?: string; parameterType?: string; advanced?: string }
export function ValidationInventoryEditor({ title, kind, entries, matrixMode = false, onChange, scratch, onScratchChange }: {
  title: string; kind: 'cases' | 'workloads'; entries: Entry[]; matrixMode?: boolean; onChange: (entries: Entry[]) => void;
  scratch: ValidationInventoryScratch; onScratchChange: (value: ValidationInventoryScratch) => void;
}) {
  const parameter = scratch.parameter ?? '';
  const parameterType = scratch.parameterType ?? 'number';
  const [error, setError] = useState('');
  const [showWeights, setShowWeights] = useState(false);
  const columns = [...new Set(entries.flatMap(item => Object.keys(item.parameters)))];
  const key = kind === 'cases' ? 'case_id' : 'workload_id';
  const idOf = (item: Entry) => 'case_id' in item ? item.case_id : item.workload_id;
  function update(index: number, patch: Partial<Entry>) { onChange(entries.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  function add() {
    let n = entries.length + 1;
    while (entries.some(item => idOf(item) === `${kind === 'cases' ? 'case' : 'workload'}-${n}`)) n++;
    const base = { [key]: `${kind === 'cases' ? 'case' : 'workload'}-${n}`, parameters: { ...entries[0]?.parameters } };
    onChange([...entries, ...parseValidationInputs([base], kind)]);
  }
  function duplicate(item: Entry) {
    let n = 2; while (entries.some(entry => idOf(entry) === `${idOf(item)}-${n}`)) n++;
    onChange([...entries, { ...item, [key]: `${idOf(item)}-${n}`, parameters: { ...item.parameters } }]);
  }
  function addParameter() {
    const name = parameter.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || columns.includes(name) || ['threads', 'case_id', 'workload_id', 'role', 'phase', 'artifact_path', 'iteration_index', 'runtime_root'].includes(name)) {
      setError('请填写唯一的输入参数名，例如 width、length；线程数等运行字段请用专门的配置。'); return;
    }
    onChange(entries.map(item => ({ ...item, parameters: { ...item.parameters, [name]: parameterType === 'number' ? 1 : parameterType === 'boolean' ? false : '' } })));
    onScratchChange({ ...scratch, parameter: undefined, parameterType: undefined }); setError('');
  }
  return <div className="test-inventory"><div className="test-section-heading"><strong>{title}</strong><button type="button" onClick={add}>添加{kind === 'cases' ? '用例' : '负载'}</button></div>
    <p className="hint">填写要覆盖的尺寸、数据类型等输入，可复制一行后修改。{matrixMode ? '每行自动覆盖所选线程与绑核组合。' : '两端性能测试使用同一份负载与输入种子。'}</p>
    <div className="test-table-scroll"><table><thead><tr><th>名称</th>{!matrixMode && <th>线程数</th>}{columns.map(name => <th key={name}>{name}<button type="button" className="text-btn" aria-label={`删除${title}参数 ${name}`} onClick={() => onChange(entries.map(item => ({ ...item, parameters: Object.fromEntries(Object.entries(item.parameters).filter(([key]) => key !== name)) })))}>×</button></th>)}
      {kind === 'workloads' && showWeights && <><th>关键负载</th><th>权重</th></>}<th>操作</th></tr></thead><tbody>{entries.map((item, index) => <tr key={index}>
        <td><input aria-label={`${title} ${index + 1} 名称`} value={idOf(item)} onChange={e => update(index, { [key]: e.target.value })} /></td>
        {!matrixMode && <td><input aria-label={`${title} ${index + 1} 线程数`} type="number" min="1" value={item.threads} onChange={e => update(index, { threads: Number(e.target.value) })} /></td>}
        {columns.map(name => { const value = item.parameters[name] ?? ''; return <td key={name}>{typeof value === 'boolean'
          ? <input aria-label={`${title} ${index + 1} ${name}`} type="checkbox" checked={value} onChange={e => update(index, { parameters: { ...item.parameters, [name]: e.target.checked } })} />
          : <input aria-label={`${title} ${index + 1} ${name}`} type={typeof value === 'number' ? 'number' : 'text'} step="any" value={value} onChange={e => update(index, { parameters: { ...item.parameters, [name]: typeof value === 'number' ? Number(e.target.value) : e.target.value } })} />}</td>; })}
        {'workload_id' in item && showWeights && <><td><input aria-label={`${title} ${index + 1} 关键负载`} type="checkbox" checked={item.critical} onChange={e => update(index, { critical: e.target.checked })} /></td><td><input aria-label={`${title} ${index + 1} 权重`} type="number" min="0.001" step="any" value={item.weight} onChange={e => update(index, { weight: Number(e.target.value) })} /></td></>}
        <td><div className="inventory-row-actions"><button type="button" aria-label={`复制${title} ${index + 1}`} onClick={() => duplicate(item)}>复制</button><button type="button" disabled={entries.length <= 1} onClick={() => onChange(entries.filter((_, i) => i !== index))}>删除</button></div></td>
      </tr>)}</tbody></table></div>
    {kind === 'workloads' && <button type="button" className="text-btn inventory-weight-toggle" aria-expanded={showWeights} onClick={() => setShowWeights(value => !value)}>{showWeights ? '收起权重与关键负载' : '高级：权重与关键负载'}{!showWeights && ` · ${entries.filter(item => 'critical' in item && item.critical).length} 个关键负载`}</button>}
    <details open={!!parameter || parameterType !== 'number' || undefined}><summary>添加输入参数</summary><div className="test-parameter-add"><input aria-label={`${title}新增参数名`} value={parameter} onChange={e => onScratchChange({ ...scratch, parameter: e.target.value || undefined })} placeholder="输入参数名，如 width" />
      <select aria-label={`${title}新增参数类型`} value={parameterType} onChange={e => onScratchChange({ ...scratch, parameterType: e.target.value })}><option value="number">数字</option><option value="string">文本</option><option value="boolean">开关</option></select><button type="button" onClick={addParameter}>添加输入参数</button>{(parameter || parameterType !== 'number') && <button type="button" onClick={() => { onScratchChange({ ...scratch, parameter: undefined, parameterType: undefined }); setError(''); }}>放弃参数输入</button>}</div>{(parameter || parameterType !== 'number') && <p className="hint">参数尚未添加到表格，请点击“添加输入参数”或放弃参数输入。</p>}</details>
    {error && <p className="hint" role="alert">{error}</p>}
    <details open={scratch.advanced !== undefined || undefined}><summary>高级：编辑{title} JSON</summary>
      <p className="hint">每行填写唯一名称和 parameters。名称使用英文字母、数字、点、下划线或短横线。省略的运行字段沿用同名输入的已有设置；新增输入默认 1 线程{kind === 'workloads' ? '、权重 1、非关键负载' : ''}。多个尺寸请拆成多行，参数值使用数字、文本或开关。</p>
      <textarea aria-label={`${title} JSON`} rows={7} value={scratch.advanced ?? JSON.stringify(entries, null, 2)} onChange={e => onScratchChange({ ...scratch, advanced: e.target.value === JSON.stringify(entries, null, 2) ? undefined : e.target.value })} /><button type="button" onClick={() => {
        try { const value = parseValidationInputs(JSON.parse(scratch.advanced ?? JSON.stringify(entries)), kind, entries); onChange(value); onScratchChange({ ...scratch, advanced: undefined }); setError(''); }
        catch (error) { setError(error instanceof SyntaxError ? 'JSON 格式不正确，请检查引号、逗号和方括号。' : (error as Error).message); }
      }}>应用 JSON</button>{scratch.advanced !== undefined && <><button type="button" onClick={() => onScratchChange({ ...scratch, advanced: undefined })}>放弃 JSON 修改</button><p className="hint">JSON 修改尚未应用到表格。</p></>}</details>
  </div>;
}
