import { isControlIdentity, type ControlIdentity } from '../../src/contracts/control-identity';

const prefix = (projectId: string) => `corepilot-optimization-request:${projectId}:`;

/** Only request identities are durable; the editable draft remains in sessionStorage. */
export function pendingOptimizationRequests(projectId: string): Array<{ requestId: string; identity: ControlIdentity | null }> {
  const keyPrefix = prefix(projectId);
  const keys: Array<{ requestId: string; identity: ControlIdentity | null }> = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(keyPrefix)) continue;
    let identity: ControlIdentity | null = null;
    try {
      const record = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (record?.version === 2 && isControlIdentity(record.identity)) identity = record.identity;
    } catch { /* Legacy or damaged records remain unresolved. */ }
    keys.push({ requestId: key.slice(keyPrefix.length), identity });
  }
  return keys.sort((a, b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
}

export function rememberOptimizationRequest(projectId: string, requestId: string, identity: ControlIdentity): void {
  if (!isControlIdentity(identity)) throw new Error('无法核对控制端身份。');
  const key = prefix(projectId) + requestId;
  const record = JSON.stringify({ version: 2, identity });
  localStorage.setItem(key, record);
  if (localStorage.getItem(key) !== record) throw new Error('无法保存任务请求标识，请启用浏览器本地存储后重试。');
}

export function forgetOptimizationRequest(projectId: string, requestId: string): void {
  const key = prefix(projectId) + requestId;
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error('无法更新任务请求状态，请检查浏览器本地存储。');
}
