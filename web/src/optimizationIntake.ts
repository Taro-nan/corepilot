const prefix = (projectId: string) => `corepilot-optimization-request:${projectId}:`;

/** Only request identities are durable; the editable draft remains in sessionStorage. */
export function pendingOptimizationRequests(projectId: string): string[] {
  const keyPrefix = prefix(projectId);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(keyPrefix)) keys.push(key.slice(keyPrefix.length));
  }
  return keys.sort();
}

export function rememberOptimizationRequest(projectId: string, requestId: string): void {
  const key = prefix(projectId) + requestId;
  localStorage.setItem(key, '1');
  if (localStorage.getItem(key) !== '1') throw new Error('无法保存任务请求标识，请启用浏览器本地存储后重试。');
}

export function forgetOptimizationRequest(projectId: string, requestId: string): void {
  const key = prefix(projectId) + requestId;
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error('无法更新任务请求状态，请检查浏览器本地存储。');
}
