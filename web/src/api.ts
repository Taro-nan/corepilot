import { ApiClient } from '../../src/client/api-client';
export const api = new ApiClient(window.location.origin);
export async function downloadProjectTestPackage(projectId: string, action: string, filename = 'corepilot-test-package.tar.gz') {
  const bytes = await api.downloadProjectTests(projectId, action);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/gzip' }));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  // Model generation follows the server's configured model budget and timeout.
  const timeout = path.endsWith('/generate') ? undefined : AbortSignal.timeout(path.includes('/baseline-bundles/') && /\/(check|bind|finalize)$/.test(path) ? 900000
    : path.endsWith('/validation-trials') ? 180000 : 120000);
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('corepilot-session-expired'));
    const message = data.error?.message ?? `HTTP ${response.status}`;
    throw Object.assign(new Error(response.status === 403 ? '当前操作未获授权。请核对访问凭据与服务器权限。' + message : message), { status: response.status, code: data.error?.code });
  }
  return data as T;
}
