import { COREPILOT_API_VERSION } from '../version.js';
import { isCorePilotHealth } from '../contracts/health.js';
import type { BackendHealth } from '../contracts/health.js';

export type ProbeResult =
  | { kind: 'ok'; health: BackendHealth }
  | { kind: 'unhealthy'; reason: string; code: string; health: Omit<BackendHealth, 'status'> & { status: 'unavailable' } }
  | { kind: 'incompatible'; reason: string; health?: BackendHealth }
  | { kind: 'unknown-service'; detail: string }
  | { kind: 'unreachable'; detail: string };

export interface ProbeOptions { timeoutMs?: number; fetchImpl?: typeof fetch }

/** 探测当前 public workflow 后台，端口上的其他协议一律视为未知服务。 */
export async function probeBackend(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('probe-timeout'), options.timeoutMs ?? 1500);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${url.replace(/\/$/, '')}/v1/health`, { method: 'GET', signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    return { kind: 'unreachable', detail: (error as Error).message };
  }
  clearTimeout(timer);
  let parsed: unknown;
  try { parsed = JSON.parse(await response.text()); }
  catch { return { kind: 'unknown-service', detail: `port responded with non-JSON (HTTP ${response.status})` }; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const value = parsed as Record<string, unknown>;
    const error = value.error as { code?: unknown; message?: unknown } | undefined;
    if (value.service === 'corepilot' && value.status === 'unavailable' && typeof value.api_version === 'number'
      && typeof value.version === 'string' && value.runner === 'workflow' && Array.isArray(value.capabilities)
      && (error?.code === 'CONTROL_LEASE_LOST' || error?.code === 'CONTROL_LEASE_UNKNOWN') && typeof error.message === 'string') {
      if (value.api_version !== COREPILOT_API_VERSION) return { kind: 'incompatible', reason: `backend api_version ${value.api_version} != client ${COREPILOT_API_VERSION}` };
      return { kind: 'unhealthy', code: error.code, reason: error.message,
        health: value as unknown as Omit<BackendHealth, 'status'> & { status: 'unavailable' } };
    }
  }
  if (!isCorePilotHealth(parsed)) return { kind: 'unknown-service', detail: `port responded (HTTP ${response.status}) but is not a CorePilot workflow backend` };
  if (parsed.api_version !== COREPILOT_API_VERSION) return { kind: 'incompatible', health: parsed, reason: `backend api_version ${parsed.api_version} != client ${COREPILOT_API_VERSION}` };
  return { kind: 'ok', health: parsed };
}
