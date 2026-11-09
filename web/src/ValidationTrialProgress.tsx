import React, { useEffect, useState } from 'react';
import type { RunnerExecutionOutput } from '../../src/contracts/runner-rpc';

export const TRIAL_TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN'];
export interface TrialProgressState {
  trial: { created_at?: string; preparation?: { state: string; phase?: string; message: string | null } };
  status: { status: string; current_step?: string | null; started_at?: string | null; ended_at?: string | null;
    queue?: { position?: number; wait_ms: number | null; waiting_for?: string | null; reason?: string | null } };
  output?: Pick<RunnerExecutionOutput, 'stdout' | 'stderr' | 'truncated'> | null;
}
export interface TrialSubmission { mode: 'correctness' | 'comparison' | 'calibration'; created_at: string; message: string }

const steps: Record<string, string> = {
  BUILD: '正在构建当前分支', EVALUATOR_SETUP: '正在构建测试程序', CORRECTNESS: '正在执行正确性测试',
  PERFORMANCE: '正在预热并采集性能样本',
};
const states: Record<string, string> = {
  PREPARING: '正在准备执行文件', PENDING: '等待 Runner 执行', RUNNING: 'Runner 正在执行',
  SUCCEEDED: '执行完成', FAILED: '执行失败', CANCELLED: '已取消', UNKNOWN: '执行状态待核对', CANCELLING: '正在停止执行',
};

export function ValidationTrialProgress({ trial, submission }: { trial?: TrialProgressState | null; submission?: TrialSubmission | null }) {
  const [now, setNow] = useState(Date.now);
  const status = trial?.status.status;
  const active = !!submission || !status || !TRIAL_TERMINAL_STATUSES.includes(status);
  const start = submission?.created_at ?? trial?.trial.created_at ?? trial?.status.started_at;
  const end = !submission && trial?.status.ended_at;
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, start, end]);
  const seconds = start ? Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000)) : null;
  const message = submission?.message ?? (status === 'PENDING' ? trial?.status.queue?.reason : null) ?? (status === 'PREPARING' ? trial?.trial.preparation?.message : null)
    ?? (status === 'RUNNING' ? steps[trial?.status.current_step ?? ''] : null)
    ?? states[status ?? ''] ?? '正在读取试运行状态…';
  return <div className="trial-progress" aria-live="polite" aria-busy={active}>
    <div className="test-section-heading"><strong>{submission ? '正在提交试运行' : `开发试运行 · ${states[status ?? ''] ?? '正在连接 Runner'}`}</strong>{seconds !== null && <span>已用时 {seconds} 秒</span>}</div>
    <p className="trial-current-step">{message}</p>
    {trial?.status.queue && <p className="hint">{status === 'PENDING' ? `排队位置 ${trial.status.queue.position ?? '—'}；` : ''}{trial.status.queue.wait_ms !== null ? `资源等待 ${(trial.status.queue.wait_ms / 1000).toFixed(1)} 秒。` : ''}{trial.status.queue.waiting_for ? `当前占用：${trial.status.queue.waiting_for}` : ''}</p>}
    {active && !submission && <p className="hint">每 2 秒更新执行进度。可以离开或刷新页面，后台会继续执行。</p>}
    {trial?.output && (trial.output.stdout || trial.output.stderr) && !submission && <details className="trial-live-output"><summary>查看 Runner 最新输出</summary>
      {trial.output.truncated && <p className="hint">显示日志末尾，完整执行记录保留在 Runner。</p>}
      <pre>{trial.output.stdout}{trial.output.stderr ? `\n[stderr]\n${trial.output.stderr}` : ''}</pre>
    </details>}
  </div>;
}
