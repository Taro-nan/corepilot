/** 远程目标的连接信息，不包含密码或其他秘密凭据。 */
export type TargetConnection =
  | { ssh_alias: string }
  | { host: string; username: string; port: number; identity_file?: string };

export type TargetConfig = TargetConnection & { workspace_root: string };

export interface TargetProfile {
  id: string;
  name: string;
  target: TargetConfig;
  updated_at: string;
}

export const DEFAULT_WORKSPACE_ROOT = '/tmp/phyopt';

export function isAliasTarget(target: TargetConnection): target is { ssh_alias: string } {
  return 'ssh_alias' in target;
}

export function targetIdentityFile(target: TargetConnection): string | undefined {
  return isAliasTarget(target) ? undefined : target.identity_file;
}

export function targetAuthDescription(target: TargetConnection): string {
  if (isAliasTarget(target)) return 'SSH Alias 配置';
  return target.identity_file ? `私钥：${target.identity_file}` : 'SSH Agent / 默认密钥';
}

export function targetLabel(target: TargetConnection): string {
  return isAliasTarget(target) ? target.ssh_alias : `${target.username}@${target.host}`;
}

export function targetConnectionId(target: TargetConnection): string {
  return isAliasTarget(target)
    ? `alias:${target.ssh_alias}`
    : `direct:${target.username}@${target.host}:${target.port}`;
}

export function targetDescription(target: TargetConnection): string {
  return isAliasTarget(target)
    ? `SSH Alias：${target.ssh_alias}`
    : `${target.username}@${target.host}:${target.port}`;
}
