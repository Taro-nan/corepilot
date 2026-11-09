import React, { useState } from 'react';
import type { useTrialRequest } from './useTrialRequest';

/** Inspect or fence the old request before allowing a new submission. */
export function TrialRequestRecovery({ requestState, label, onFound, onMessage, sending = false }: {
  requestState: ReturnType<typeof useTrialRequest>; label: string;
  onFound: (trialId: string) => void; onMessage: (message: string, bad?: boolean) => void; sending?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const id = requestState.pending;
  async function run(action: 'check' | 'close') {
    if (!id) return;
    setBusy(true);
    try {
      const result = await (action === 'check' ? requestState.check(id) : requestState.close(id));
      if (!requestState.isCurrent()) return;
      if (result.state === 'CREATED') {
        onFound(result.trial_id); requestState.clear(id);
        onMessage('已找到原作业，继续查看其状态；没有创建新的作业。');
      } else if (result.state === 'CLOSED') {
        requestState.clear(id); onMessage('尚未创建的原请求已关闭，可以重新检查条件后提交。');
      } else if (result.state === 'PREPARING') {
        onMessage('服务器已登记原请求，作业尚未创建；它可能仍在准备。可稍后核对，或关闭尚未创建的请求。');
      } else {
        onMessage('服务器尚未找到原请求，原提交仍可能在途中。可稍后核对，或关闭尚未创建的请求。');
      }
    } catch (error) { if (requestState.isCurrent()) onMessage((error as Error).message, true); }
    finally { if (requestState.isCurrent()) setBusy(false); }
  }
  if (requestState.storageError) return <p role="alert">{requestState.storageError}</p>;
  if (!id || sending) return null;
  return <div className="notice compact" role="status"><strong>上次{label}请求尚未确认</strong>
    <p>先核对原请求。关闭操作只阻止尚未创建的作业；已创建的作业会保留并显示。</p>
    <details><summary>请求标识</summary><code>{id}</code></details>
    <div className="form-actions"><button type="button" disabled={busy} onClick={() => void run('check')}>核对上次请求</button>
      <button type="button" disabled={busy} onClick={() => void run('close')}>关闭未创建的请求</button></div>
  </div>;
}
