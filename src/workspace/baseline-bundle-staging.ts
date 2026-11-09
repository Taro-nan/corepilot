import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BaselineBundleFile, RunnerBundleInspection } from '../contracts/baseline-bundle.js';
import type { TargetConfig } from '../config/target-config.js';
import { buildScpCommandArgs, buildSshCommandArgs } from '../testpack/remote-transport.js';
import { bundleRelativePath } from '../runner/baseline-bundle-inspector.js';
import { RunnerClient } from '../client/runner-client.js';
import type { BinaryBundleBaselineDefinition } from '../contracts/library-package.js';
import type { StagedRemoteBaseline } from './validation-runner.js';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

async function run(command: string, args: string[], timeout: number): Promise<void> {
  try { await execute(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }); }
  catch (error) { throw new Error(`${command} failed: ${(error as Error & { stderr?: string }).stderr || (error as Error).message}`); }
}

/** Maintenance SSH only stages bytes; Runner RPC independently checks their identities and ELF closure. */
export async function stageAndInspectBaselineBundle(input: {
  localRoot: string;
  remoteRoot: string;
  target: TargetConfig;
  runner: { endpoint: string; token: string; requestTimeoutMs: number; storeInstanceId?: string };
  entryPath: string;
  files: BaselineBundleFile[];
}): Promise<RunnerBundleInspection> {
  const remoteRoot = input.remoteRoot.replaceAll('\\', '/');
  if (!/^\/[A-Za-z0-9_./+-]+$/.test(remoteRoot) || remoteRoot.split('/').includes('..')) throw new Error('invalid remote bundle workspace');
  const localRoot = fs.realpathSync(input.localRoot);
  const directories = [...new Set(input.files.map(file => path.posix.dirname(bundleRelativePath(file.path))))];
  await run('ssh', buildSshCommandArgs(input.target, ['bash', '-lc',
    `mkdir -p -- ${[remoteRoot, ...directories.map(dir => path.posix.join(remoteRoot, dir))].map(quote).join(' ')}`]), 60_000);
  for (const file of input.files) {
    const relative = bundleRelativePath(file.path);
    const local = path.resolve(localRoot, ...relative.split('/'));
    const outside = path.relative(localRoot, local);
    if (outside.startsWith('..') || path.isAbsolute(outside) || fs.lstatSync(local).isSymbolicLink()) throw new Error(`invalid local bundle file: ${relative}`);
    await run('scp', buildScpCommandArgs(input.target, local, path.posix.join(remoteRoot, relative)), 600_000);
  }
  const client = new RunnerClient({ baseUrl: input.runner.endpoint, token: input.runner.token,
    requestTimeoutMs: Math.max(input.runner.requestTimeoutMs, 300_000) });
  if (input.runner.storeInstanceId) client.bindStoreIdentity(input.runner.storeInstanceId);
  return client.inspectBaselineBundle({ bundle_root: remoteRoot, entry_path: input.entryPath, files: input.files });
}

/** Shared by draft comparisons and formal optimization; both use the same frozen bundle checks. */
export async function stageVerifiedBinaryBaseline(input: {
  bundle: BinaryBundleBaselineDefinition; bundleRoot: string; entryPath: string; expectedDigest: string;
  remoteRoot: string; target: TargetConfig; runner: { endpoint: string; token: string; requestTimeoutMs: number; storeInstanceId?: string };
}): Promise<StagedRemoteBaseline> {
  const files = [...input.bundle.headers, ...input.bundle.libraries].map(file => ({
    path: file.path, sha256: file.sha256, bytes: fs.statSync(path.join(input.bundleRoot, ...file.path.split('/'))).size }));
  const inspection = await stageAndInspectBaselineBundle({ localRoot: input.bundleRoot, remoteRoot: input.remoteRoot,
    target: input.target, runner: input.runner, entryPath: input.entryPath, files });
  if (!inspection.ok) throw new Error(`Runner 上的比较包依赖检查失败：${inspection.issues.join('；')}`);
  if (inspection.machine_identity_sha256 !== input.bundle.dependency_closure.target_machine) throw new Error('比较包是在另一台机器上验证的，请重新检查目标机依赖闭包');
  if (inspection.entry_sha256 !== input.expectedDigest) throw new Error('比较包入口库身份与任务不一致');
  const verified = new Map(input.bundle.dependency_closure.resolved_libraries.map(item => [item.soname, item.sha256]));
  for (const dependency of inspection.resolved_libraries) if (verified.get(dependency.soname) !== dependency.sha256) {
    throw new Error(`目标机运行时依赖已变化：${dependency.soname}；请重新验证比较包`);
  }
  return { remote_artifact: path.posix.join(input.remoteRoot, input.entryPath), digest: input.expectedDigest,
    library_paths: input.bundle.loader_environment.search_paths.map(dir => path.posix.join(input.remoteRoot, dir)),
    dependencies: [...input.bundle.libraries.filter(item => item.path !== input.entryPath).map(item => ({ path: path.posix.join(input.remoteRoot, item.path), sha256: item.sha256 })),
      ...inspection.resolved_libraries.filter(item => !item.path.startsWith(`${input.remoteRoot}/`)).map(item => ({ path: item.path, sha256: item.sha256 }))] };
}
