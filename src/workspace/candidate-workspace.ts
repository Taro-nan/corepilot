import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sourceTreeSha256 } from '../core/source-identity.js';

export interface CandidateWorkspacePaths {
  repository: string;
  baseline_commit: string;
  run_id: string;
  editing: string;
  validation: string;
}

export interface CandidateWorkspaceState extends CandidateWorkspacePaths {
  editing_created: boolean;
  validation_created: boolean;
  candidate_commit: string | null;
  candidate_tree: string | null;
}

export interface CandidateCheckpoint {
  commit: string;
  tree: string;
  files: Array<{ path: string; before_sha256: string | null; after_sha256: string | null }>;
  source_archive_sha256: string;
}

export interface CandidateSourceIdentity {
  commit: string;
  tree: string;
  source_sha256: string;
}

export class CandidateWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateWorkspaceError';
  }
}

function git(repository: string, args: string[], input?: string): string {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    input,
    windowsHide: true,
  });
  if (result.status !== 0) throw new CandidateWorkspaceError(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').trim();
}

function gitNullSeparated(repository: string, args: string[]): string[] {
  const result = spawnSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new CandidateWorkspaceError(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').split('\0').filter((item) => item.length > 0);
}

function safeSegment(value: string, field: string): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('..') || path.isAbsolute(value)) {
    throw new CandidateWorkspaceError(`${field} must be a safe path segment`);
  }
}

function assertInside(candidate: string, root: string): void {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + path.sep)) {
    throw new CandidateWorkspaceError(`workspace path ${resolvedCandidate} escapes ${resolvedRoot}`);
  }
}

function assertNonSymlinkRoot(root: string): void {
  if (!fs.existsSync(root)) return;
  const real = fs.realpathSync(root);
  if (real !== path.resolve(root)) throw new CandidateWorkspaceError(`workspace root is a symlink: ${root}`);
}

function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function workspaceFileSha256(root: string, relative: string): string | null {
  const absolute = path.join(root, ...relative.split('/'));
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new CandidateWorkspaceError(`symbolic link is not allowed in candidate source: ${absolute}`);
  if (!stat.isFile()) throw new CandidateWorkspaceError(`candidate source entry is not a regular file: ${absolute}`);
  return fileSha256(absolute);
}

function isBuildArtifact(relative: string): boolean {
  const normalized = relative.toLowerCase();
  return normalized.endsWith('.o') || normalized.endsWith('.obj') || normalized.endsWith('.a') || normalized.endsWith('.so') ||
    normalized.endsWith('.d') || normalized.endsWith('.pyc') || normalized.includes('/cmakefiles/') || normalized.startsWith('.phyopt/');
}

function addDetached(repository: string, directory: string, commit: string): void {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const result = spawnSync('git', ['-C', repository, 'worktree', 'add', '--detach', directory, commit], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new CandidateWorkspaceError(`git worktree add failed: ${(result.stderr ?? '').trim()}`);
}

/**
 * 确保算法库至少有一个可复现的 main 基线。已有 Git 仓库不触碰用户的
 * dirty 工作区；没有仓库时才把当前源码初始化并提交为 baseline。
 */
export function ensureCandidateRepository(repositoryPath: string): { repository: string; baselineCommit: string } {
  let repository = path.resolve(repositoryPath);
  fs.mkdirSync(repository, { recursive: true });
  const probe = spawnSync('git', ['-C', repository, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) {
    const init = spawnSync('git', ['-C', repository, 'init', '--initial-branch=main'], { encoding: 'utf8', windowsHide: true });
    if (init.status !== 0) throw new CandidateWorkspaceError(`git init failed: ${(init.stderr ?? '').trim()}`);
    // 新仓库可能没有全局身份，使用仓库级临时身份保证 baseline 可记录。
    spawnSync('git', ['-C', repository, 'config', 'user.email', 'phyopt@localhost'], { encoding: 'utf8', windowsHide: true });
    spawnSync('git', ['-C', repository, 'config', 'user.name', 'PhyOpt Agent'], { encoding: 'utf8', windowsHide: true });
  } else {
    // 调用目录可能是仓库子目录；候选身份始终绑定实际 Git 根。
    repository = path.resolve((probe.stdout ?? '').trim());
  }
  const head = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  if (head.status !== 0) {
    const add = spawnSync('git', ['-C', repository, 'add', '-A'], { encoding: 'utf8', windowsHide: true });
    if (add.status !== 0) throw new CandidateWorkspaceError(`git add baseline failed: ${(add.stderr ?? '').trim()}`);
    const commit = spawnSync('git', ['-C', repository, 'commit', '--allow-empty', '-m', 'phyopt baseline'], { encoding: 'utf8', windowsHide: true });
    if (commit.status !== 0) throw new CandidateWorkspaceError(`git baseline commit failed: ${(commit.stderr ?? '').trim()}`);
  }
  // 已有仓库以用户当前检出的分支 HEAD 为基线；只有上面的新仓库初始化
  // 使用 main。不要静默创建或改写用户的分支引用。
  return { repository, baselineCommit: git(repository, ['rev-parse', 'HEAD']) };
}

/** 从候选 commit 导出完整源码归档；归档不包含 .git、构建缓存或工作区外文件。 */
export function exportCandidateSourceArchive(state: CandidateWorkspaceState, outputFile: string): { path: string; sha256: string } {
  const commit = state.candidate_commit ?? state.baseline_commit;
  const absolute = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const result = spawnSync('git', ['-C', state.repository, 'archive', '--format=tar', '--output', absolute, commit], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new CandidateWorkspaceError(`git archive failed: ${(result.stderr ?? '').trim()}`);
  return { path: absolute, sha256: fileSha256(absolute) };
}

/** Identity of the clean validation snapshot currently selected for target staging. */
export function currentCandidateSourceIdentity(state: CandidateWorkspaceState): CandidateSourceIdentity {
  const commit = state.candidate_commit ?? state.baseline_commit;
  return {
    commit,
    tree: git(state.repository, ['rev-parse', `${commit}^{tree}`]),
    source_sha256: sourceTreeSha256(state.validation),
  };
}

/** 将验证 worktree 重置为指定候选 commit，保证复验使用干净目录。 */
export function refreshValidationWorkspace(state: CandidateWorkspaceState, commit = state.candidate_commit ?? state.baseline_commit): void {
  if (fs.existsSync(state.validation)) {
    const remove = spawnSync('git', ['-C', state.repository, 'worktree', 'remove', '--force', state.validation], { encoding: 'utf8', windowsHide: true });
    if (remove.status !== 0) throw new CandidateWorkspaceError(`cannot refresh validation workspace: ${(remove.stderr ?? '').trim()}`);
  }
  addDetached(state.repository, state.validation, commit);
}

/** 创建一次运行专属的编辑树和验证树；两者均从同一基准 commit 派生。 */
export function createCandidateWorkspace(options: {
  repository: string;
  worktreeRoot: string;
  runId: string;
  baselineCommit?: string;
}): CandidateWorkspaceState {
  const prepared = ensureCandidateRepository(options.repository);
  const repository = prepared.repository;
  const worktreeRoot = path.resolve(options.worktreeRoot);
  safeSegment(options.runId, 'runId');
  assertNonSymlinkRoot(worktreeRoot);
  const baselineCommit = options.baselineCommit?.trim() || prepared.baselineCommit;
  git(repository, ['rev-parse', '--verify', `${baselineCommit}^{commit}`]);

  const runRoot = path.join(worktreeRoot, options.runId);
  const editing = path.join(runRoot, 'editing');
  const validation = path.join(runRoot, 'validation');
  assertInside(editing, worktreeRoot);
  assertInside(validation, worktreeRoot);
  if (fs.existsSync(runRoot)) throw new CandidateWorkspaceError(`workspace run already exists: ${runRoot}`);

  addDetached(repository, editing, baselineCommit);
  try {
    // 验证树也从基准版本创建，只有 checkpoint 后才会被替换为候选版本。
    addDetached(repository, validation, baselineCommit);
  } catch (error) {
    removeCandidateWorkspace({ repository, editing, validation });
    throw error;
  }
  return {
    repository,
    baseline_commit: baselineCommit,
    run_id: options.runId,
    editing,
    validation,
    editing_created: true,
    validation_created: true,
    candidate_commit: null,
    candidate_tree: null,
  };
}

/** 将编辑树源码记录为候选 checkpoint，并让验证树重新指向该 commit。 */
export function checkpointCandidate(state: CandidateWorkspaceState, message = 'phyopt candidate checkpoint'): CandidateCheckpoint {
  if (!fs.existsSync(state.editing)) throw new CandidateWorkspaceError(`editing workspace does not exist: ${state.editing}`);
  assertInside(state.editing, path.dirname(path.dirname(state.editing)));

  // checkpoint 只记录源码版本；构建产物不会从编辑树复制到验证树。
  git(state.editing, ['add', '-u']);
  // 新建源码文件需要纳入 checkpoint，但常见构建产物和运行缓存不能进入
  // 验证树；一次枚举 untracked paths，避免在大型源码树中为每个文件启动 Git。
  for (const relative of gitNullSeparated(state.editing, ['ls-files', '--others', '--exclude-standard', '-z'])) {
    if (isBuildArtifact(relative)) continue;
    git(state.editing, ['add', '--', relative]);
  }
  const changedPaths = gitNullSeparated(state.editing, ['diff', '--cached', '--name-only', '-z']);
  const files = changedPaths.map((relative) => ({
    path: relative,
    before_sha256: workspaceFileSha256(state.validation, relative),
    after_sha256: workspaceFileSha256(state.editing, relative),
  }));
  git(state.editing, ['commit', '--allow-empty', '-m', message]);
  const commitSha = git(state.editing, ['rev-parse', 'HEAD']);
  const tree = git(state.editing, ['rev-parse', 'HEAD^{tree}']);
  refreshValidationWorkspace(state, commitSha);
  state.candidate_commit = commitSha;
  state.candidate_tree = tree;
  return { commit: commitSha, tree, files, source_archive_sha256: sourceTreeSha256(state.validation) };
}

/** 只删除本次运行创建的两个 worktree；调用者必须显式确认。 */
export function removeCandidateWorkspace(state: Pick<CandidateWorkspaceState, 'repository' | 'editing' | 'validation'>): void {
  for (const worktree of [state.validation, state.editing]) {
    if (!fs.existsSync(worktree)) continue;
    const result = spawnSync('git', ['-C', state.repository, 'worktree', 'remove', '--force', worktree], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new CandidateWorkspaceError(`git worktree remove failed: ${(result.stderr ?? '').trim()}`);
  }
}
