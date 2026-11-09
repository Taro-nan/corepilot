/** Shared by configuration parsing, project setup and the browser form. */
export const DEFAULT_RUNNER_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_RUNNER_POLL_INTERVAL_MS = 250;

export type RunnerMode = 'legacy' | 'rpc';
export interface RpcRunnerConnection { mode: 'rpc'; endpoint: string; token: string; request_timeout_ms: number; poll_interval_ms: number }
export interface RegisteredRunner { mode: 'rpc'; machine_id: string }
export type RunnerConfig =
  | { mode: 'legacy' }
  | RpcRunnerConnection
  | RegisteredRunner;

export function isRegisteredRunner(runner: RunnerConfig | undefined): runner is RegisteredRunner {
  return runner?.mode === 'rpc' && 'machine_id' in runner;
}

export function redactRpcRunner(runner: RpcRunnerConnection): RpcRunnerConnection {
  const token = runner.token.trim();
  return { ...runner, token: !token || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(token) ? token : '[redacted]' };
}

/** An explicit setup state; execution must resolve real connection details first. */
export function createRpcRunnerConfig(): RpcRunnerConnection {
  return { mode: 'rpc', endpoint: '', token: '', request_timeout_ms: DEFAULT_RUNNER_REQUEST_TIMEOUT_MS, poll_interval_ms: DEFAULT_RUNNER_POLL_INTERVAL_MS };
}
