import type { RpcRunnerConnection } from '../config/runner-config.js';
import type { TargetConfig } from '../config/target-config.js';
import type { RunnerHealth, RunnerMachineInfo } from './runner-rpc.js';

export interface ExecutionMachineIdentity { machine_id: string; name: string; revision: number }
export interface ExecutionMachineRecord extends ExecutionMachineIdentity {
  runner: RpcRunnerConnection;
  target: TargetConfig | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_check: { status: 'ONLINE' | 'OFFLINE'; checked_at: string; error: string | null } | null;
  last_success: { checked_at: string; health: RunnerHealth; machine: RunnerMachineInfo } | null;
}
/** Public machine inventory never includes connection credentials or SSH settings. */
export interface ExecutionMachineSummary extends ExecutionMachineIdentity {
  status: 'UNKNOWN' | 'ONLINE' | 'OFFLINE' | 'STALE' | 'DISABLED';
  enabled: boolean;
  setup_complete: boolean;
  last_checked_at: string | null;
  last_online_at: string | null;
  health: RunnerHealth | null;
  hardware: RunnerMachineInfo | null;
  error: string | null;
}
/** Maintainer form; the returned token is always a mask or environment reference. */
export interface ExecutionMachineDetails extends ExecutionMachineSummary {
  runner: RpcRunnerConnection;
  target: TargetConfig | null;
}
export interface ResolvedExecutionMachine {
  identity: ExecutionMachineIdentity;
  runner: RpcRunnerConnection;
  target: TargetConfig;
}
