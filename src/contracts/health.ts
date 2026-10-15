import { PHYOPT_API_VERSION, VERSION } from '../version.js';

/**
 * Health envelope returned by `GET /v1/health`.
 *
 * 后台管理器使用 `service`、`api_version` 和 `runner` 判断是否可复用进程。
 */
export interface BackendHealth {
  service: 'phyopt';
  api_version: number;
  version: string;
  runner: 'workflow';
  status: 'ok';
  capabilities: string[];
}

export interface BackendHealthInput {
  capabilities?: string[];
}

export function buildHealth(input: BackendHealthInput): BackendHealth {
  return {
    service: 'phyopt',
    api_version: PHYOPT_API_VERSION,
    version: VERSION,
    runner: 'workflow',
    status: 'ok',
    capabilities: input.capabilities ?? ['workflows', 'tasks', 'events'],
  };
}

/** True when a parsed JSON body looks like a PhyOpt backend health envelope. */
export function isPhyoptHealth(value: unknown): value is BackendHealth {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.service === 'phyopt' && typeof v.api_version === 'number' && v.status === 'ok';
}
