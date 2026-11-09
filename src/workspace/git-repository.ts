import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { RepositoryInspection } from '../contracts/project.js';

const execute = promisify(execFile);

export function sourceDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) throw new Error('源码目录必须是服务器上的绝对路径');
  let root: string;
  try { root = fs.realpathSync(directory); }
  catch { throw new Error('找不到源码目录，请确认路径存在于运行 CorePilot 的服务器上'); }
  if (!fs.statSync(root).isDirectory()) throw new Error('源码路径指向文件，请选择源码目录');
  return root;
}

/** Read local Git state without checkout, fetch, init or modifying the repository. */
export async function inspectRepository(directory: string): Promise<RepositoryInspection> {
  const root = sourceDirectory(directory);
  const git = (args: string[]) => execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  let repository: string;
  try { repository = (await git(['rev-parse', '--show-toplevel'])).stdout.trim(); }
  catch (error) {
    if ((error as { code?: string | number }).code !== 128) throw new Error(`无法读取 Git 仓库：${(error as Error).message}`);
    return { repository_root: root, is_git: false, current_branch: null, head_commit: null, branches: [] };
  }
  const [head, branch, refs] = await Promise.allSettled([
    git(['rev-parse', '--verify', 'HEAD']),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(['for-each-ref', '--sort=refname', '--format=%(refname:lstrip=2)%00%(objectname)%00%(subject)%00%(upstream:short)', 'refs/heads/']),
  ]);
  if (refs.status === 'rejected') throw refs.reason;
  return {
    repository_root: path.resolve(repository), is_git: true,
    current_branch: branch.status === 'fulfilled' ? branch.value.stdout.trim() : null,
    head_commit: head.status === 'fulfilled' ? head.value.stdout.trim() : null,
    branches: refs.value.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [name, commit, subject, upstream] = line.split('\0');
      return { name, commit, subject, upstream: upstream || null };
    }),
  };
}

/** Resolve only an exact local branch, never an arbitrary revision expression. */
export function resolveSourceBranch(repository: string, branch: string): { branch: string; commit: string } {
  if (typeof branch !== 'string' || !branch.trim()) throw new Error('请选择要优化的 Git 分支');
  const name = branch.trim();
  const result = spawnSync('git', ['-C', repository, 'show-ref', '--verify', '--hash', `refs/heads/${name}`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`找不到本地 Git 分支「${name}」，请刷新分支列表后重试`);
  return { branch: name, commit: result.stdout.trim() };
}
