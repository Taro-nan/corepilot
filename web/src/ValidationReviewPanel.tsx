import React, { useEffect, useState } from 'react';
import type { ValidationAssetDraft } from '../../src/contracts/validation-assets';
import type { ValidationReview } from '../../src/contracts/validation-review';
import { displayBuildCommand } from '../../src/config/build-command';
import { request } from './api';
import { Feedback, Field, Modal, CopyValue } from './components';
import { testProgramFile } from './ValidationTestCode';
import { ValidationQualitySummary } from './ValidationQualityEditor';

export function ValidationReviewPanel({ url, draft, dirty, refreshKey, onApproved }: {
  url: string; draft: ValidationAssetDraft; dirty: boolean; refreshKey: string; onApproved: () => Promise<void>;
}) {
  const [review, setReview] = useState<ValidationReview | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [reviewer, setReviewer] = useState(() => localStorage.getItem('corepilot-validation-reviewer') ?? '');
  useEffect(() => {
    let active = true; setError(''); setReview(null);
    request<ValidationReview>(`${url}/review`).then(value => { if (active) setReview(value); })
      .catch(error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [url, refreshKey, retry]);
  async function approve(event: React.FormEvent) {
    event.preventDefault(); if (!review?.trial) return;
    setBusy(true); setError('');
    try {
      const updated = await request<ValidationReview>(`${url}/review`, 'POST', { expected_digest: review.evaluator_digest,
        expected_package_digest: review.package_digest, trial_id: review.trial.trial_id, reviewer: reviewer.trim(), confirm: true });
      localStorage.setItem('corepilot-validation-reviewer', reviewer.trim()); setReview(updated); setOpen(false);
      await onApproved();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <section className="validation-review" aria-label="审阅并启用测试方案">
    <strong>{review?.state === 'QUALIFIED' ? '测试方案已确认，可用于正式优化' : review?.state === 'READY_FOR_REVIEW' ? '试跑已通过，下一步确认测试方案' : '正式优化前的测试方案确认'}</strong>
    {review?.state === 'QUALIFIED' ? <><p>审阅人：{review.approval?.reviewer}</p>{review.approval?.trial_id && <details><summary>查看审阅依据标识</summary><CopyValue value={review.approval.trial_id} label="审阅依据" /></details>}</>
      : review?.state === 'READY_FOR_REVIEW' ? <><p>{review.trial?.machine_name} 上正确性 {review.trial?.correctness_passed}/{review.trial?.correctness_planned} 通过，性能样本 {review.trial?.performance_measured}/{review.trial?.performance_planned} 齐全。请核对测试代码、基线与条件后确认启用。</p>
        <button type="button" className="primary" disabled={dirty} onClick={() => setOpen(true)}>审阅并启用测试方案</button>
        {dirty && <p className="hint">当前还有未保存的修改。保存后需对新版本试跑，再确认启用。</p>}</>
      : review ? <p>{review.blockers.join(' ')}</p> : !error && <p>正在读取试跑与审阅状态…</p>}
    {error && <><Feedback text={error} bad /><button type="button" onClick={() => setRetry(value => value + 1)}>重新读取审阅状态</button></>}
    <ValidationQualitySummary quality={review?.quality} />
    {open && review?.trial && <Modal title="确认这版测试方案用于正式优化" wide onClose={() => { if (!busy) setOpen(false); }}>
      <form onSubmit={event => void approve(event)} className="validation-review-form">
        <p>确认后固定本版测试代码与条件，优化 Agent 按这些规则验证候选。此操作只启用测试方案；优化结果仍需后续真实实验、复验和交付审阅。</p>
        <dl className="definition"><dt>当前函数</dt><dd>{review.function_name}</dd><dt>试跑机器</dt><dd>{review.trial.machine_name}</dd>
          <dt>源码</dt><dd>{review.trial.source_branch ?? 'HEAD'} · {review.trial.source_commit.slice(0, 12)}</dd>
          <dt>比较基线</dt><dd>{review.baseline.library} · {review.baseline.version} · {review.baseline.sha256.slice(0, 12)}</dd>
          <dt>正确性结果</dt><dd>{review.trial.correctness_passed}/{review.trial.correctness_planned} 通过</dd>
          <dt>有效性能样本</dt><dd>{review.trial.performance_measured}/{review.trial.performance_planned}</dd>
          <dt>正确性参考</dt><dd>{draft.oracle_description}</dd><dt>误差规则</dt><dd>{draft.tolerance_rule} · 绝对 {draft.tolerance_absolute} · 相对 {draft.tolerance_relative}</dd>
          <dt>执行条件</dt><dd>{draft.test_plan.execution_matrix ? `${draft.test_plan.execution_matrix.thread_counts.join(' / ')} 线程，${draft.test_plan.execution_matrix.profiles.length} 组绑核方案` : `CPU ${draft.test_plan.resources.cpu_set}，NUMA ${draft.test_plan.resources.numa_node}`}</dd>
          <dt>采样</dt><dd>{draft.test_plan.sampling.warmup_count} 次预热，每端 {draft.test_plan.sampling.sample_count} 个样本，每样本 {draft.test_plan.inner_iterations} 次调用，种子 {draft.test_plan.seed}</dd>
          <dt>计时方式</dt><dd>{draft.benchmark_description}</dd><dt>可修改源码</dt><dd>{review.scope.include.join('、')}</dd>
        </dl>
        <details><summary>查看构建命令、完整执行条件与验收门槛</summary><pre className="detail-code">{displayBuildCommand(review.build)}</pre><pre className="detail-code">{JSON.stringify({ test_plan: draft.test_plan, acceptance: review.acceptance, scope: review.scope }, null, 2)}</pre></details>
        {(['correctness', 'performance'] as const).map(scope => { const file = testProgramFile(draft, scope); return <details key={scope}><summary>查看{scope === 'correctness' ? '正确性' : '性能'}测试代码 · {file.path}</summary><pre className="detail-code">{file.content}</pre></details>; })}
        <p className="hint">试跑 ID：{review.trial.trial_id} · 测试版本：{review.evaluator_digest.slice(0, 12)}</p>
        <Field label="审阅人" help="记录你对本版测试方案的确认，可填写姓名或维护者标识。"><input aria-label="测试方案审阅人" autoFocus required maxLength={160} value={reviewer} onChange={event => setReviewer(event.target.value)} /></Field>
        {error && <Feedback text={error} bad />}
        <div className="form-actions"><button type="button" disabled={busy} onClick={() => setOpen(false)}>返回检查</button><button type="submit" className="primary" disabled={busy || !reviewer.trim()}>{busy ? '正在启用测试方案…' : '确认启用并运行前检查'}</button></div>
      </form>
    </Modal>}
  </section>;
}
