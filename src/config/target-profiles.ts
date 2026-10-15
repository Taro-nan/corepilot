import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TargetConfig, TargetProfile } from './target-config.js';
import { targetConnectionId, targetLabel } from './target-config.js';

/** 用户级目标记录只保存连接地址，不保存密码、私钥内容或 token。 */
export function defaultTargetProfilesPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.phyopt', 'targets.json');
}

export class TargetProfilesStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetProfilesStoreError';
  }
}

function readProfiles(filePath: string): TargetProfile[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('根节点必须是数组');
    return parsed.flatMap((item): TargetProfile[] => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Partial<TargetProfile>;
      if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.updated_at !== 'string') return [];
      const rawTarget = value.target;
      if (!rawTarget || typeof rawTarget !== 'object') return [];
      const candidate = rawTarget as Record<string, unknown>;
      const workspace = typeof candidate.workspace_root === 'string' && candidate.workspace_root.trim()
        ? candidate.workspace_root.trim()
        : null;
      if (!workspace) return [];
      const identityFile = candidate.identity_file === undefined
        ? undefined
        : typeof candidate.identity_file === 'string' && candidate.identity_file.trim()
          ? candidate.identity_file.trim()
          : null;
      if (identityFile === null) return [];
      if (typeof candidate.ssh_alias === 'string' && candidate.ssh_alias.trim() && !('host' in candidate) && !('username' in candidate) && identityFile === undefined) {
        return [{ id: value.id, name: value.name, updated_at: value.updated_at, target: { ssh_alias: candidate.ssh_alias.trim(), workspace_root: workspace } }];
      }
      if (typeof candidate.host === 'string' && candidate.host.trim()
        && typeof candidate.username === 'string' && candidate.username.trim()
        && Number.isInteger(candidate.port) && (candidate.port as number) >= 1 && (candidate.port as number) <= 65535) {
        return [{ id: value.id, name: value.name, updated_at: value.updated_at, target: { host: candidate.host.trim(), username: candidate.username.trim(), port: candidate.port as number, ...(identityFile === undefined ? {} : { identity_file: identityFile }), workspace_root: workspace } }];
      }
      return [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new TargetProfilesStoreError(`无法读取目标机器记录 ${filePath}：${(error as Error).message}`);
  }
}

function writeProfiles(filePath: string, profiles: TargetProfile[]): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(profiles, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(temporaryPath, 0o600);
    // Windows does not replace an existing destination with renameSync. Use
    // copy-then-remove there; POSIX keeps the atomic rename path.
    if (process.platform === 'win32') {
      fs.copyFileSync(temporaryPath, filePath);
      fs.rmSync(temporaryPath, { force: true });
    } else {
      fs.renameSync(temporaryPath, filePath);
    }
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* 保留原始错误 */ }
    throw new TargetProfilesStoreError(`无法保存目标机器记录 ${filePath}：${(error as Error).message}`);
  }
}

export function listTargetProfiles(options: { filePath?: string } = {}): TargetProfile[] {
  return readProfiles(options.filePath ?? defaultTargetProfilesPath());
}

export function saveTargetProfile(
  target: TargetConfig,
  options: { filePath?: string; name?: string } = {},
): TargetProfile {
  const filePath = options.filePath ?? defaultTargetProfilesPath();
  const profiles = readProfiles(filePath);
  const id = targetConnectionId(target);
  const profile: TargetProfile = {
    id,
    name: options.name?.trim() || targetLabel(target),
    target,
    updated_at: new Date().toISOString(),
  };
  const index = profiles.findIndex((item) => item.id === id);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  writeProfiles(filePath, profiles);
  return profile;
}
