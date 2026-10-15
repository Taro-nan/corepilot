import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { removeCandidateWorkspace, type CandidateWorkspaceState } from './candidate-workspace.js';

export class CandidateApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandidateApprovalError';
  }
}

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new CandidateApprovalError(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return (result.stdout ?? '').trim();
}

function userWorkspaceChanges(repository: string): string[] {
  return git(repository, ['status', '--porcelain', '--untracked-files=all'])
    .split(/\r?\n/)
    .filter(Boolean)
    // `.phyopt/` 是 PhyOpt 自己的未跟踪运行状态；已跟踪文件的任何
    // 修改仍会保留在结果中并阻止合入。
    .filter((line) => !(line.startsWith('?? ') && line.slice(3).replace(/\\/g, '/').startsWith('.phyopt/')));
}

/** 用户确认后把候选 commit 合入当前基准分支，并创建明确的交付提交。 */
export function approveCandidate(input: {
  workspace: CandidateWorkspaceState;
  expectedBaselineCommit: string;
  commitMessage: string;
}): { commit: string; tree: string } {
  const repository = path.resolve(input.workspace.repository);
  if (!input.commitMessage.trim()) throw new CandidateApprovalError('commitMessage must not be empty');
  const current = git(repository, ['rev-parse', 'HEAD']);
  if (current !== input.expectedBaselineCommit) throw new CandidateApprovalError(`baseline changed after validation: expected ${input.expectedBaselineCommit}, got ${current}`);
  const changes = userWorkspaceChanges(repository);
  if (changes.length > 0) throw new CandidateApprovalError(`baseline worktree is dirty; refusing to overwrite user changes: ${changes[0]}`);
  if (!input.workspace.candidate_commit) throw new CandidateApprovalError('candidate commit is missing; run checkpoint first');
  git(repository, ['rev-parse', '--verify', `${input.workspace.candidate_commit}^{commit}`]);

  // --no-commit 允许交付提交使用“修改内容 + 性能提升点”的用户说明。
  try {
    git(repository, ['merge', '--no-ff', '--no-commit', input.workspace.candidate_commit]);
    git(repository, ['commit', '-m', input.commitMessage.trim()]);
  } catch (error) {
    // 合并冲突时尽量撤销索引/工作区，仍不触碰候选 worktree。
    spawnSync('git', ['-C', repository, 'merge', '--abort'], { encoding: 'utf8', windowsHide: true });
    throw error;
  }
  return { commit: git(repository, ['rev-parse', 'HEAD']), tree: git(repository, ['rev-parse', 'HEAD^{tree}']) };
}

/** 交付提交完成后再删除编辑/验证树。 */
export function approveAndCleanup(input: {
  workspace: CandidateWorkspaceState;
  expectedBaselineCommit: string;
  commitMessage: string;
}): { commit: string; tree: string } {
  const result = approveCandidate(input);
  removeCandidateWorkspace(input.workspace);
  return result;
}
