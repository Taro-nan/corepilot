import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendHealth } from '../contracts/health.js';
import { probeBackend } from './health.js';
import type { ProbeResult } from './health.js';
import {
  MANAGED_BACKEND_TOKEN_ENV,
  MANAGED_SHUTDOWN_PATH,
  MANAGED_SHUTDOWN_TOKEN_HEADER,
} from './managed-control.js';

export type BackendErrorCode =
  | 'UNREACHABLE'
  | 'PORT_IN_USE'
  | 'INCOMPATIBLE_VERSION'
  | 'MODE_MISMATCH'
  | 'START_FAILED'
  | 'START_TIMEOUT';

export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly diagnostics: string;
  constructor(code: BackendErrorCode, message: string, diagnostics = '') {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface ServeSpec {
  host: string;
  port: number;
  dbPath: string;
  runner: 'workflow';
  transport: 'mock' | 'ssh';
  sshAlias: string | null;
  /** Direct SSH connection fields for targets without an ssh_config alias. */
  sshHost?: string | null;
  sshUsername?: string | null;
  sshPort?: number | null;
  sshIdentityFile?: string | null;
  /** Extra env vars injected into the managed backend process (e.g. a
   * credential resolved from the IDE's secret store, passed via env — never
   * via argv, never logged, never written to a file). */
  extraEnv?: Record<string, string>;
}

export interface ManagedChild {
  readonly pid: number | null;
  /** Resolves when the child process has exited. */
  readonly exited: Promise<{ code: number | null }>;
  /** Last chunk of the child's combined stdout/stderr (for diagnostics). */
  stderrTail(): string;
  kill(): void;
  /** Allow the parent to exit while the child keeps running. */
  unref(): void;
}

export interface BackendManagerOptions {
  url: string;
  spec: ServeSpec;
  /** Only a target URL that corresponds to our own managed local backend may spawn. */
  allowSpawn: boolean;
  probe?: (url: string) => Promise<ProbeResult>;
  spawn?: (spec: ServeSpec) => ManagedChild;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
  onEvent?: (message: string) => void;
  /** Where the managed-backend record is kept; defaults next to the database. */
  statePath?: string;
}

export interface ManagedState {
  pid: number | null;
  host: string;
  port: number;
  db_path: string;
  runner: string;
  version: string;
  api_version: number;
  started_at: string;
  /** Per-process capability required by the private graceful-shutdown route. */
  shutdown_token: string;
}

export function managedStatePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backend.json');
}

function readState(statePath: string): ManagedState | null {
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as ManagedState;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(statePath: string, state: ManagedState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, statePath);
}

function clearState(statePath: string): void {
  try {
    fs.rmSync(statePath, { force: true });
  } catch {
    /* ignore */
  }
}

export interface EnsureResult {
  url: string;
  reused: boolean;
  started: boolean;
  health: BackendHealth;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Manages the local backend lifecycle for a single terminal / window:
 * reuse a compatible backend if one is listening, otherwise start a managed
 * one. Never kills an unknown process, never silently falls back to Mock.
 */
export class BackendManager {
  private child: ManagedChild | null = null;
  private readonly statePath: string;

  constructor(private readonly options: BackendManagerOptions) {
    this.statePath = options.statePath ?? managedStatePath(options.spec.dbPath);
  }

  get startedChild(): ManagedChild | null {
    return this.child;
  }

  async ensure(): Promise<EnsureResult> {
    const probe = this.options.probe ?? ((url: string) => probeBackend(url));
    const log = this.options.onEvent ?? (() => undefined);

    const first = await probe(this.options.url);
    const reuse = this.reuseOutcome(first);
    if (reuse) return reuse;

    if (first.kind === 'incompatible') {
      throw new BackendError('INCOMPATIBLE_VERSION', first.reason, `at ${this.options.url}`);
    }
    if (first.kind === 'unknown-service') {
      throw new BackendError(
        'PORT_IN_USE',
        `port ${this.options.spec.port} is held by a non-PhyOpt service; refusing to reuse or stop it`,
        `${first.detail}. Free the port or change backend.port / --port, then retry.`,
      );
    }
    if (first.kind === 'ok') {
      // reuseOutcome returns for a compatible runner and throws on mismatch, so
      // this is unreachable; kept so the type narrows to 'unreachable' below.
      throw new BackendError('MODE_MISMATCH', `unexpected healthy probe state at ${this.options.url}`);
    }
    if (!this.options.allowSpawn) {
      throw new BackendError('UNREACHABLE', `no PhyOpt backend at ${this.options.url}`, first.detail);
    }

    log(`backend not found at ${this.options.url}; starting a managed local host...`);
    const spawnImpl = this.options.spawn ?? ((spec: ServeSpec) => defaultSpawn(spec));
    const sleep = this.options.sleep ?? defaultSleep;
    const now = this.options.now ?? (() => Date.now());
    const timeout = this.options.readyTimeoutMs ?? 15_000;
    const interval = this.options.pollIntervalMs ?? 200;

    const shutdownToken = randomBytes(32).toString('hex');
    const child = spawnImpl({
      ...this.options.spec,
      extraEnv: {
        ...this.options.spec.extraEnv,
        [MANAGED_BACKEND_TOKEN_ENV]: shutdownToken,
      },
    });
    this.child = child;
    let exited = false;
    void child.exited.then(() => {
      exited = true;
    });

    const deadline = now() + timeout;
    while (now() < deadline) {
      await sleep(interval);
      const result = await probe(this.options.url);
      if (result.kind === 'ok') {
        // We started it; it must match the requested runner or it is a bug.
        if (result.health.runner !== this.options.spec.runner) {
          child.kill();
          throw new BackendError(
            'MODE_MISMATCH',
            `started backend runner '${result.health.runner}' != requested '${this.options.spec.runner}'`,
          );
        }
        child.unref();
        writeState(this.statePath, {
          pid: child.pid,
          host: this.options.spec.host,
          port: this.options.spec.port,
          db_path: this.options.spec.dbPath,
          runner: result.health.runner,
          version: result.health.version,
          api_version: result.health.api_version,
          started_at: new Date().toISOString(),
          shutdown_token: shutdownToken,
        });
        log(`backend ready at ${this.options.url} (pid ${child.pid ?? '?'})`);
        return { url: this.options.url, reused: false, started: true, health: result.health };
      }
      if (result.kind === 'unknown-service') {
        child.kill();
        throw new BackendError('PORT_IN_USE', `port ${this.options.spec.port} became occupied during startup`, result.detail);
      }
      if (exited) {
        // The child may have lost the lease race to another host: re-probe once
        // and reuse it if it is a compatible backend, else report the failure.
        const after = await probe(this.options.url);
        const lateReuse = this.reuseOutcome(after);
        if (lateReuse) {
          log('another managed backend won the lease; reusing it');
          return lateReuse;
        }
        child.unref();
        throw new BackendError(
          'START_FAILED',
          'managed backend process exited before becoming ready',
          child.stderrTail() || '(no diagnostics captured)',
        );
      }
    }

    child.kill();
    child.unref();
    throw new BackendError(
      'START_TIMEOUT',
      `managed backend did not become ready within ${timeout}ms`,
      child.stderrTail() || '(no diagnostics captured)',
    );
  }

  /** Stop the child this manager started and wait for graceful completion. */
  async stop(): Promise<boolean> {
    if (!this.child) return false;
    const result = await stopManagedBackend({ url: this.options.url, statePath: this.statePath });
    if (result.stopped) this.child = null;
    return result.stopped;
  }

  private reuseOutcome(result: ProbeResult): EnsureResult | null {
    if (result.kind !== 'ok') return null;
    if (result.health.runner !== this.options.spec.runner) {
      throw new BackendError(
        'MODE_MISMATCH',
        `running backend uses runner '${result.health.runner}' but config requests '${this.options.spec.runner}'; refusing to silently switch modes`,
        'Stop the running backend or align backend.runner, then retry.',
      );
    }
    return { url: this.options.url, reused: true, started: false, health: result.health };
  }
}

export interface ServeInvocation {
  command: string;
  baseArgs: string[];
}

/**
 * Resolve how to start a fresh `serve` process. Prefers the compiled entry
 * (`dist/entry.js`) and falls back to the TS source via tsx for dev runs. The
 * path is derived from THIS module's location (never process.argv), so it is
 * correct in tests, in the dev CLI and in the packaged tarball.
 */
export function resolveServeInvocation(moduleUrl: string = import.meta.url): ServeInvocation {
  const override = process.env.PHYOPT_SERVE_CMD;
  if (override && override.trim().length > 0) {
    const trimmed = override.trim();
    if (trimmed.startsWith('[')) {
      const parts = JSON.parse(trimmed) as string[];
      return { command: parts[0], baseArgs: parts.slice(1) };
    }
    return { command: trimmed, baseArgs: [] };
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const root = path.resolve(moduleDir, '..', '..');
  const distEntry = path.join(root, 'dist', 'entry.js');
  const srcEntry = path.join(root, 'src', 'entry.ts');

  // In a source checkout, prefer the TS entry so the managed backend always
  // runs the CURRENT code (a stale dist/ would otherwise be picked up). In the
  // packaged tarball only dist exists, so the compiled entry is used.
  if (fs.existsSync(srcEntry)) {
    return { command: process.execPath, baseArgs: ['--import', 'tsx', srcEntry] };
  }
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, baseArgs: [distEntry] };
  }
  return { command: process.execPath, baseArgs: [path.join(root, 'dist', 'entry.js')] };
}

export function serveArgsToArgv(spec: ServeSpec): string[] {
  const argv = ['backend', 'serve', '--transport', spec.transport, '--host', spec.host, '--port', String(spec.port), '--db', spec.dbPath];
  if (spec.sshAlias) {
    argv.push('--ssh-alias', spec.sshAlias);
  } else if (spec.sshHost && spec.sshUsername) {
    argv.push('--ssh-host', spec.sshHost, '--ssh-username', spec.sshUsername, '--ssh-port', String(spec.sshPort ?? 22));
    if (spec.sshIdentityFile) argv.push('--ssh-identity-file', spec.sshIdentityFile);
  }
  return argv;
}

export interface StopResult {
  stopped: boolean;
  reason: string;
}

async function requestManagedShutdown(url: string, token: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('shutdown-request-timeout'), 2000);
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}${MANAGED_SHUTDOWN_PATH}`, {
      method: 'POST',
      headers: { [MANAGED_SHUTDOWN_TOKEN_HEADER]: token },
      signal: controller.signal,
    });
    // Consume the response before returning so the backend can close its
    // listener without leaving this client socket active.
    await response.arrayBuffer();
    return response.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a previously managed backend, using its persisted record. Refuses to
 * touch a port held by a non-PhyOpt service; clears a stale record instead of
 * killing an unrelated pid.
 */
export async function stopManagedBackend(options: {
  url: string;
  statePath: string;
  probe?: (url: string) => Promise<ProbeResult>;
  requestShutdown?: (url: string, token: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<StopResult> {
  const state = readState(options.statePath);
  if (!state) return { stopped: false, reason: 'no managed backend recorded' };

  const probe = options.probe ?? ((url: string) => probeBackend(url));
  const result = await probe(options.url);

  if (result.kind === 'unknown-service') {
    return { stopped: false, reason: `refusing to stop: ${options.url} is held by a non-PhyOpt service` };
  }
  if (result.kind === 'ok' || result.kind === 'incompatible') {
    if (!state.shutdown_token) return { stopped: false, reason: 'managed backend state has no shutdown token; state retained' };
    const requestShutdown = options.requestShutdown ?? requestManagedShutdown;
    const graceful = await requestShutdown(options.url, state.shutdown_token);
    if (!graceful) {
      const afterRequest = await probe(options.url);
      if (afterRequest.kind !== 'unreachable') return { stopped: false, reason: 'managed backend rejected or did not acknowledge graceful shutdown; state retained' };
    }

    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const timeout = options.stopTimeoutMs ?? 30_000;
    const interval = options.pollIntervalMs ?? 100;
    const deadline = now() + timeout;

    while (now() < deadline) {
      const stoppedProbe = await probe(options.url);
      if (stoppedProbe.kind === 'unreachable') {
        clearState(options.statePath);
        const pid = state.pid === null ? '?' : String(state.pid);
        return {
          stopped: true,
          reason: `gracefully stopped managed backend pid ${pid}`,
        };
      }
      await sleep(interval);
    }

    return {
      stopped: false,
      reason: `managed backend did not stop within ${timeout}ms; state retained`,
    };
  }

  clearState(options.statePath);
  return { stopped: false, reason: 'recorded backend was not reachable; cleared stale record' };
}

const TAIL_LIMIT = 4000;

function defaultSpawn(spec: ServeSpec): ManagedChild {
  const invocation = resolveServeInvocation();
  const argv = [...invocation.baseArgs, ...serveArgsToArgv(spec)];

  const logDir = path.join(path.dirname(spec.dbPath), 'backend');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `backend-${spec.port}.log`);
  const fd = fs.openSync(logPath, 'a');

  const child = spawn(invocation.command, argv, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...spec.extraEnv },
  });
  fs.closeSync(fd);

  let tail = '';
  try {
    tail = fs.readFileSync(logPath, 'utf8').slice(-TAIL_LIMIT);
  } catch {
    tail = '';
  }

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once('exit', (code) => resolve({ code: code ?? null }));
    child.once('error', () => resolve({ code: null }));
  });

  return {
    pid: child.pid ?? null,
    exited,
    stderrTail: () => {
      try {
        return fs.readFileSync(logPath, 'utf8').slice(-TAIL_LIMIT);
      } catch {
        return tail;
      }
    },
    kill: () => {
      if (child.pid) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          } else {
            process.kill(-child.pid, 'SIGTERM');
          }
        } catch {
          /* already gone */
        }
      }
    },
    unref: () => child.unref(),
  };
}
