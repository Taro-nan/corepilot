import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { isBuildArtifact, type CandidateWorkspaceState } from './candidate-workspace.js';

const execute = promisify(execFile);

async function withEditingTree<T>(workspace: CandidateWorkspaceState, index: 'head' | 'current',
  useTree: (tree: string, git: (args: string[]) => Promise<string>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'corepilot-source-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'CorePilot', GIT_AUTHOR_EMAIL: 'corepilot@localhost', GIT_COMMITTER_NAME: 'CorePilot', GIT_COMMITTER_EMAIL: 'corepilot@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const gitOutput = async (args: string[]) => (await execute('git', ['-C', workspace.editing, ...args],
    { env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal })).stdout;
  const git = async (args: string[]) => (await gitOutput(args)).trim();
  try {
    let checkCurrentIndex: (() => Promise<void>) | undefined;
    if (index === 'head') await git(['read-tree', 'HEAD']);
    else {
      // A checkpoint starts with this worktree's actual index, which may
      // already contain staged additions (including force-added ignored files).
      const current = (await execute('git', ['-C', workspace.editing, 'rev-parse', '--path-format=absolute', '--git-path', 'index'],
        { windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, signal })).stdout.trim();
      const expectedHead = await git(['rev-parse', '--verify', `${workspace.candidate_commit ?? workspace.baseline_commit}^{commit}`]);
      const checkHead = async () => {
        if (await git(['rev-parse', 'HEAD']) !== expectedHead) throw new Error('editing HEAD is changing');
        try { await fs.promises.lstat(`${current}.lock`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        throw new Error('editing index is locked');
      };
      await checkHead();
      const original = await fs.promises.readFile(current);
      await fs.promises.writeFile(env.GIT_INDEX_FILE, original, { flag: 'wx' });
      checkCurrentIndex = async () => {
        await checkHead();
        if (!original.equals(await fs.promises.readFile(current))) throw new Error('editing index changed during inspection');
      };
      await checkCurrentIndex();
    }
    await git(['add', '-u']);
    const untracked = (await gitOutput(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => file && !isBuildArtifact(file));
    if (index === 'current') {
      // Match checkpointCandidate even for unusual Git pathspec characters.
      for (const file of untracked) await git(['add', '--', file]);
    } else {
      for (let offset = 0; offset < untracked.length; offset += 128) await git(['add', '--', ...untracked.slice(offset, offset + 128)]);
    }
    const tree = await git(['write-tree']);
    await checkCurrentIndex?.();
    return await useTree(tree, git);
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

/** Preview the tree checkpointCandidate would stage, without changing HEAD or its index. */
export async function snapshotEditingTree(workspace: CandidateWorkspaceState, signal?: AbortSignal): Promise<string> {
  return withEditingTree(workspace, 'current', async tree => tree, signal);
}

/** Snapshot development edits using a temporary index; neither HEAD nor the real index changes. */
export async function snapshotEditingSource(workspace: CandidateWorkspaceState) {
  return withEditingTree(workspace, 'head', async (tree, git) => {
    const commit = await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'CorePilot development source snapshot']);
    return { commit, tree };
  });
}

/** Export a pinned Git object without materializing a checkout on Control. */
export async function exportGitSourceArchive(repository: string, commit: string, filename: string) {
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('源码归档需要明确的 Git commit');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  await execute('git', ['-C', repository, 'archive', '--format=tar.gz', '--output', filename, commit],
    { windowsHide: true, timeout: 600_000, maxBuffer: 1024 * 1024 });
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return { path: filename, sha256: hash.digest('hex'), bytes: fs.statSync(filename).size };
}

export async function gitSourceVersion(repository: string, revision: string) {
  const result = await execute('git', ['-C', repository, 'rev-parse', '--verify', `${revision}^{commit}`], { windowsHide: true });
  const commit = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('请选择已有提交的源码分支');
  const tree = (await execute('git', ['-C', repository, 'rev-parse', `${commit}^{tree}`], { windowsHide: true })).stdout.trim();
  return { commit, tree };
}
