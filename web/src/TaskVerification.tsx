import React from 'react';
import type { ValidationAssetDraft } from '../../src/contracts/validation-assets';
import type { OptimizationVerificationMode } from '../../src/contracts/public-workflow';
import { Disclosure, Feedback, Icon } from './components';
import { TestConditionsSummary } from './TestConditionsSummary';

export type VerificationMode = OptimizationVerificationMode;

export function VerificationChoice({ value, onChange }: { value: VerificationMode; onChange: (mode: VerificationMode) => void }) {
  return <fieldset className="verification-choice">
    <legend>优化方式</legend>
    <label className={value === 'source_only' ? 'selected' : ''}>
      <input type="radio" name="verification-mode" value="source_only" checked={value === 'source_only'} onChange={() => onChange('source_only')} />
      <span><strong>仅生成优化代码</strong><small>Agent 调查并修改源码，测试可稍后单独进行。</small></span>
    </label>
    <label className={value === 'verified' ? 'selected' : ''}>
      <input type="radio" name="verification-mode" value="verified" checked={value === 'verified'} onChange={() => onChange('verified')} />
      <span><strong>优化并自动验证</strong><small>使用已准备的测试方案，运行测试和独立复验。</small></span>
    </label>
  </fieldset>;
}

export function TaskTestReview({ plan, error, retry, mismatched, owned, baseline, hasSelection, hasTestpack, ready, performance, prepare }: {
  plan: ValidationAssetDraft | null; error: string; retry: () => void; mismatched: boolean; owned: boolean;
  baseline?: string; hasSelection: boolean; hasTestpack: boolean; ready: boolean; performance: boolean; prepare: () => void;
}) {
  return <section className="submission-review" aria-label="本次测试条件">
    <div className="review-heading"><h3>测试条件</h3><span>已保存的方案</span></div>
    <dl className="review-facts"><div><dt>比较基线</dt><dd>{mismatched ? '需先选择目标函数对应的方案' : plan?.comparison_baseline ? <>
      {plan.comparison_baseline.library} · {plan.comparison_baseline.version}
      {plan.comparison_baseline.source_detail && <span className="resource-review-line">{plan.comparison_baseline.source_kind === 'branch' ? '来源分支：' : '来源：'}{plan.comparison_baseline.source_detail}</span>}
    </> : baseline?.split(/[\\/]/).at(-1) || (hasSelection ? '使用接入方案中固定的比较基线' : hasTestpack ? '使用已有测试方案的基线' : '尚未准备')}</dd></div></dl>
    {!mismatched && plan ? <TestConditionsSummary draft={plan} /> : !mismatched && owned ? <div role="status">
      {error ? <><Feedback text={'测试条件暂时无法读取：' + error} bad /><button type="button" onClick={retry}>重新读取测试条件</button></> : '正在读取测试条件…'}
    </div> : <p className="hint">测试范围、资源、采样和误差沿用已有方案，提交后固定本次版本。</p>}
    {ready && <button type="button" className="text-btn" onClick={prepare}>查看或调整测试方案<Icon name="arrow" size={14} /></button>}
    <p className="submission-budget"><strong>{performance ? '正确性 + 性能测量 + 独立复验' : '仅验证正确性，不测量性能'}</strong></p>
    <Disclosure title="如何判定结果" summary="执行、验证与批准分别记录"><p className="hint">测试执行完成不代表性能提升。正式批准和源码交付需要在结果页由人工另行确认。</p></Disclosure>
  </section>;
}
