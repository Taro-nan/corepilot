import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { WorkflowDeliveryOperation } from '../contracts/delivery.js';

export class DeliveryGitError extends Error {
  constructor(message: string) { super(message); this.name = 'DeliveryGitError'; }
}

async function git(repository: string, args: string[], input?: string, allowed: readonly number[] = [0]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const process = spawn('git', ['-C', repository, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, overflow = false;
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size <= 16 * 1024 * 1024) target.push(chunk); else overflow = true;
    };
    process.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    process.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    process.stdin.on('error', () => { /* Git may exit before consuming input. */ });
    process.once('error', error => reject(new DeliveryGitError(`启动 git 失败（${repository}）：${error.message}`)));
    process.once('close', code => {
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      if (overflow) { reject(new DeliveryGitError(`git 输出过大，无法核对结果（${repository}）`)); return; }
      if (code === null || !allowed.includes(code)) {
        if (args[0] === 'merge' && /would be overwritten/i.test(stderr)) {
          reject(new DeliveryGitError(`待交付文件与本地改动重叠，请处理后继续交付：\n${stderr}`)); return;
        }
        reject(new DeliveryGitError(`git ${args.join(' ')} failed in ${repository}: ${stderr || `exit=${code ?? 'unknown'}`}`)); return;
      }
      resolve({ stdout: Buffer.concat(output).toString('utf8').trim(), code });
    });
    process.stdin.end(input);
  });
}

type Target = WorkflowDeliveryOperation['target'];

async function targetCommit(repository: string, target: Target): Promise<string> {
  if (target.kind === 'BRANCH') {
    const result = await git(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}^{commit}`], undefined, [0, 1]);
    if (result.code !== 0) throw new DeliveryGitError(`找不到交付分支「${target.branch}」，请核对原仓库。`);
    return result.stdout;
  }
  const symbolic = await git(target.worktree, ['symbolic-ref', '--quiet', 'HEAD'], undefined, [0, 1]);
  if (symbolic.code === 0) throw new DeliveryGitError('原来分离检出的工作区已切换分支，请核对交付目标。');
  return (await git(target.worktree, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout;
}

/** Resolve the exact target before recording user intent; this does not mutate Git. */
export async function resolveDeliveryTarget(repository: string, branch?: string): Promise<{ target: Target; commit: string }> {
  const root = path.resolve(repository);
  if (branch) {
    const target: Target = { kind: 'BRANCH', branch };
    return { target, commit: await targetCommit(root, target) };
  }
  const symbolic = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], undefined, [0, 1]);
  const target: Target = symbolic.code === 0 ? { kind: 'BRANCH', branch: symbolic.stdout } : { kind: 'DETACHED', worktree: root };
  return { target, commit: await targetCommit(root, target) };
}

function pinRef(operation: WorkflowDeliveryOperation): string {
  if (!/^[0-9a-f-]{36}$/.test(operation.operation_id)) throw new DeliveryGitError('交付操作身份无效，请核对保存的记录。');
  return `refs/corepilot/deliveries/${operation.operation_id}`;
}

async function pinnedCommit(operation: WorkflowDeliveryOperation): Promise<string | null> {
  const result = await git(operation.repository, ['rev-parse', '--verify', '--quiet', `${pinRef(operation)}^{commit}`], undefined, [0, 1]);
  return result.code === 0 ? result.stdout : null;
}

async function verifyPrepared(operation: WorkflowDeliveryOperation, commit: string): Promise<void> {
  const result = await git(operation.repository, ['show', '-s', '--format=%T%n%P%n%B', commit]);
  const [tree, parents, ...message] = result.stdout.split('\n');
  if (tree !== operation.candidate_tree || parents !== `${operation.baseline_commit} ${operation.candidate_commit}`
    || message.join('\n').trim() !== operation.commit_message.trim()) {
    throw new DeliveryGitError('保存的交付提交与候选、基线或提交说明不一致，请核对原记录。');
  }
}

/** Prepare and pin one Git object before the target ref is touched. */
export async function prepareCandidateDelivery(operation: WorkflowDeliveryOperation): Promise<string> {
  const existing = await pinnedCommit(operation);
  if (existing) { await verifyPrepared(operation, existing); return existing; }
  if (await targetCommit(operation.repository, operation.target) !== operation.baseline_commit) {
    throw new DeliveryGitError('baseline changed after validation; delivery was not applied');
  }
  const candidate = (await git(operation.repository, ['rev-parse', '--verify', `${operation.candidate_commit}^{commit}`])).stdout;
  const tree = (await git(operation.repository, ['rev-parse', `${candidate}^{tree}`])).stdout;
  if (candidate !== operation.candidate_commit || tree !== operation.candidate_tree) throw new DeliveryGitError('候选源码树与已验证记录不一致，未执行交付。');
  if ((await git(operation.repository, ['merge-base', operation.baseline_commit, candidate])).stdout !== operation.baseline_commit) {
    throw new DeliveryGitError('候选不以已验证基线为祖先，请检查候选与基线身份。');
  }
  const commit = (await git(operation.repository, ['commit-tree', tree, '-p', operation.baseline_commit, '-p', candidate, '-F', '-'], operation.commit_message.trim() + '\n')).stdout;
  try { await git(operation.repository, ['update-ref', '--stdin'], `create ${pinRef(operation)} ${commit}\n`); }
  catch (error) {
    const concurrent = await pinnedCommit(operation);
    if (!concurrent) throw error;
    await verifyPrepared(operation, concurrent);
    return concurrent;
  }
  return commit;
}

export interface DeliveryObservation {
  state: 'NOT_APPLIED' | 'APPLIED' | 'DIVERGED';
  commit: string | null;
  target_commit: string;
}

/** Read Git facts only. In particular, never retry a merge while reconciling. */
export async function inspectCandidateDelivery(operation: WorkflowDeliveryOperation): Promise<DeliveryObservation> {
  const pinned = await pinnedCommit(operation);
  if (pinned && operation.prepared_commit && pinned !== operation.prepared_commit) throw new DeliveryGitError('交付操作引用与保存的提交不一致，请核对原记录。');
  const commit = operation.prepared_commit ?? pinned;
  if (commit) await verifyPrepared(operation, commit);
  const current = await targetCommit(operation.repository, operation.target);
  if (commit) {
    const ancestor = await git(operation.repository, ['merge-base', '--is-ancestor', commit, current], undefined, [0, 1]);
    if (ancestor.code === 0) return { state: 'APPLIED', commit, target_commit: current };
  }
  return { state: current === operation.baseline_commit ? 'NOT_APPLIED' : 'DIVERGED', commit, target_commit: current };
}

/** Apply only the already-persisted commit, with the original baseline as a compare-and-swap. */
export async function applyCandidateDelivery(operation: WorkflowDeliveryOperation): Promise<{ commit: string; tree: string }> {
  if (!operation.prepared_commit) throw new DeliveryGitError('交付提交尚未持久化，不能更新分支。');
  const observation = await inspectCandidateDelivery(operation);
  if (observation.state === 'APPLIED') return { commit: operation.prepared_commit, tree: operation.candidate_tree };
  if (observation.state !== 'NOT_APPLIED') throw new DeliveryGitError('目标分支已改变，请先核对原基线与交付记录。');
  let checkout: string | null = operation.target.kind === 'DETACHED' ? operation.target.worktree : null;
  if (operation.target.kind === 'BRANCH') {
    const branch = operation.target.branch;
    const entries = (await git(operation.repository, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0');
    const registered = entries.find(block => block.split('\0').includes(`branch refs/heads/${branch}`));
    checkout = registered?.split('\0').find(line => line.startsWith('worktree '))?.slice(9) ?? null;
    if (checkout && (await git(checkout, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout !== branch) {
      throw new DeliveryGitError('交付分支已改变，请重新检查源码分支。');
    }
  }
  if (checkout) {
    if ((await git(checkout, ['rev-parse', 'HEAD'])).stdout !== operation.baseline_commit) throw new DeliveryGitError('baseline changed after validation; delivery was not applied');
    await git(checkout, ['merge', '--ff-only', '--no-edit', '--no-stat', '--no-overwrite-ignore', operation.prepared_commit]);
  } else if (operation.target.kind === 'BRANCH') {
    await git(operation.repository, ['update-ref', `refs/heads/${operation.target.branch}`, operation.prepared_commit, operation.baseline_commit]);
  }
  const after = await inspectCandidateDelivery(operation);
  if (after.state !== 'APPLIED') throw new DeliveryGitError('未能确认目标分支包含交付提交，请先核对交付状态。');
  return { commit: operation.prepared_commit, tree: operation.candidate_tree };
}

/** Preserve tracked, untracked and ignored changes made after the candidate was frozen. */
export async function cleanupDeliveryWorkspaces(operation: WorkflowDeliveryOperation): Promise<void> {
  for (const workspace of [operation.validation_workspace, operation.editing_workspace]) {
    if (!fs.existsSync(workspace)) continue;
    if ((await git(workspace, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching'])).stdout) {
      throw new DeliveryGitError(`交付已记录，但工作区存在未提交内容，已保留：${workspace}`);
    }
    await git(operation.repository, ['worktree', 'remove', workspace]);
  }
}
