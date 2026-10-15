import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { TargetConnection, TargetConfig } from '../config/target-config.js';

export interface CommandResult {
  command: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface RemoteTransport {
  readonly transport_type: 'ssh' | 'mock';
  readonly ssh_calls: number;
  runRemote(argv: string[]): CommandResult;
}

/**
 * Real SSH transport. Uses BatchMode (never prompts for password/key), never
 * uses StrictHostKeyChecking=no, never auto-accepts an unknown host key.
 * Callers must validate argv against a whitelist before invoking.
 */
export class SshTransport implements RemoteTransport {
  readonly transport_type = 'ssh' as const;
  ssh_calls = 0;

  constructor(private readonly target: SshTarget) {}

  runRemote(argv: string[]): CommandResult {
    this.ssh_calls += 1;
    const res = spawnSync(
      'ssh',
      buildSshCommandArgs(this.target, argv),
      // Builds can emit several MB of compile output; the 1MB default would kill
      // the ssh process (status null -> exit -1), so allow a large buffer.
      { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      command: argv[0] ?? '',
      argv,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      exit_code: res.status ?? -1,
    };
  }

  /** Copy a local file to the remote host via scp (BatchMode, no prompt). */
  uploadFile(localPath: string, remotePath: string): { exit_code: number; stderr: string } {
    this.ssh_calls += 1;
    if (!fs.existsSync(localPath)) {
      return { exit_code: -1, stderr: `local file not found: ${localPath}` };
    }
    const res = spawnSync(
      'scp',
      buildScpCommandArgs(this.target, localPath, remotePath),
      { encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 },
    );
    return { exit_code: res.status ?? -1, stderr: res.stderr ?? '' };
  }
}

export interface MockCommand {
  argv: string[];
  stdout: string;
  stderr?: string;
  exit_code?: number;
}

/**
 * Deterministic mock transport for tests. Returns canned responses matched by
 * the full remote argv (joined), falling back to a default response.
 */
export class MockRemoteTransport implements RemoteTransport {
  readonly transport_type = 'mock' as const;
  ssh_calls = 0;

  constructor(
    private readonly responses: Map<string, CommandResult> = new Map(),
    private readonly fallback: CommandResult = { command: '', argv: [], stdout: '', stderr: '', exit_code: 0 },
  ) {}

  runRemote(argv: string[]): CommandResult {
    this.ssh_calls += 1;
    const key = argv.join(' ');
    const hit = this.responses.get(key);
    if (hit) return { ...hit, argv };
    return { ...this.fallback, argv };
  }
}

export interface SshTargetCheck {
  ok: boolean;
  message: string;
  architecture?: string;
  username?: string;
}

/**
 * 在保存目标配置前执行一次最小免交互检查。
 * 不关闭主机密钥校验，也不接受密码输入；密码不会进入 YAML 或命令参数。
 */
export function checkSshTarget(target: TargetConfig): SshTargetCheck {
  if (!('ssh_alias' in target) && target.identity_file) {
    const identityFile = expandIdentityFile(target.identity_file);
    if (!fs.existsSync(identityFile)) return { ok: false, message: `找不到私钥文件：${target.identity_file}` };
    if (!fs.statSync(identityFile).isFile()) return { ok: false, message: `私钥路径不是文件：${target.identity_file}` };
  }
  const transport = new SshTransport(target);
  const architecture = transport.runRemote(['uname', '-m']);
  if (architecture.exit_code !== 0) {
    return { ok: false, message: sshFailureMessage(architecture.stderr) };
  }
  const username = transport.runRemote(['id', '-un']);
  if (username.exit_code !== 0) {
    return { ok: false, message: sshFailureMessage(username.stderr) };
  }
  const probePath = `${target.workspace_root.replace(/\/$/, '')}/.phyopt-connection-${randomUUID()}`;
  const created = transport.runRemote(['mkdir', '-p', probePath]);
  if (created.exit_code !== 0) {
    return { ok: false, message: created.stderr.trim() || `远端工作目录不可写：${target.workspace_root}` };
  }
  const removed = transport.runRemote(['rmdir', probePath]);
  if (removed.exit_code !== 0) {
    return { ok: false, message: removed.stderr.trim() || `无法清理远端测试目录：${probePath}` };
  }
  return {
    ok: true,
    message: 'SSH 连接和远端工作目录验证通过',
    architecture: architecture.stdout.trim(),
    username: username.stdout.trim(),
  };
}

export type SshTarget = TargetConnection | string;

function expandIdentityFile(identityFile: string): string {
  if (identityFile === '~') return os.homedir();
  if (identityFile.startsWith('~/') || identityFile.startsWith('~\\')) return path.join(os.homedir(), identityFile.slice(2));
  return identityFile;
}

function sshFailureMessage(stderr: string): string {
  const detail = stderr.trim();
  if (/Permission denied/i.test(detail)) return 'SSH 认证失败：请确认用户名正确，且 SSH Agent、默认密钥或指定私钥对应的公钥已加入远端 authorized_keys。';
  if (/Host key verification failed/i.test(detail)) return '主机指纹尚未确认或已发生变化，请先在终端手动执行一次 ssh 并确认指纹。';
  if (/Could not resolve hostname|getaddrinfo/i.test(detail)) return '无法解析服务器地址，请检查 IP 或域名。';
  if (/Connection refused/i.test(detail)) return '服务器拒绝了 SSH 连接，请检查 SSH 端口和远端 sshd 服务。';
  if (/timed out|Timeout/i.test(detail)) return 'SSH 连接超时，请检查服务器地址、端口、防火墙和网络连接。';
  return detail || 'SSH 连接失败';
}

function sshConnection(target: SshTarget): { destination: string; options: string[]; scpOptions: string[] } {
  if (typeof target === 'string') return { destination: target, options: [], scpOptions: [] };
  if ('ssh_alias' in target) return { destination: target.ssh_alias, options: [], scpOptions: [] };
  const identityOptions = target.identity_file
    ? ['-i', expandIdentityFile(target.identity_file), '-o', 'IdentitiesOnly=yes']
    : [];
  return {
    destination: `${target.username}@${target.host}`,
    options: [...identityOptions, '-p', String(target.port)],
    scpOptions: [...identityOptions, '-P', String(target.port)],
  };
}

export function buildSshCommandArgs(target: SshTarget, argv: string[]): string[] {
  const connection = sshConnection(target);
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'LogLevel=ERROR',
    ...connection.options,
    connection.destination,
    serializeRemoteArgv(argv),
  ];
}

/**
 * OpenSSH sends a remote command as one shell string even when spawn receives
 * several local argv entries. Quote each remote argv item explicitly so that
 * `bash -lc <script>` retains the complete script as its third argument.
 */
export function serializeRemoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new Error('remote command argv must not be empty');
  return argv.map((value) => `'${value.replaceAll("'", `'"'"'`)}'`).join(' ');
}

export function buildScpCommandArgs(target: SshTarget, localPath: string, remotePath: string): string[] {
  const connection = sshConnection(target);
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'LogLevel=ERROR', ...connection.scpOptions, localPath, `${connection.destination}:${remotePath}`];
}
