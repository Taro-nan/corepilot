import { PHYOPT_API_VERSION } from '../version.js';
import { isPhyoptHealth } from '../contracts/health.js';
import type { BackendHealth } from '../contracts/health.js';

export type ProbeResult =
  | { kind: 'ok'; health: BackendHealth }
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
  if (!isPhyoptHealth(parsed)) return { kind: 'unknown-service', detail: `port responded (HTTP ${response.status}) but is not a PhyOpt workflow backend` };
  if (parsed.api_version !== PHYOPT_API_VERSION) return { kind: 'incompatible', health: parsed, reason: `backend api_version ${parsed.api_version} != client ${PHYOPT_API_VERSION}` };
  return { kind: 'ok', health: parsed };
}
