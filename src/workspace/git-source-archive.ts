import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { isBuildArtifact, type CandidateWorkspaceState } from './candidate-workspace.js';

const execute = promisify(execFile);

/** Snapshot current edits using a temporary index; neither HEAD nor the real index changes. */
export async function snapshotEditingSource(workspace: CandidateWorkspaceState) {
  const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'corepilot-source-index-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'),
    GIT_AUTHOR_NAME: 'CorePilot', GIT_AUTHOR_EMAIL: 'corepilot@localhost', GIT_COMMITTER_NAME: 'CorePilot', GIT_COMMITTER_EMAIL: 'corepilot@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
  const git = async (args: string[]) => (await execute('git', ['-C', workspace.editing, ...args],
    { env, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  try {
    await git(['read-tree', 'HEAD']);
    await git(['add', '-u']);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => file && !isBuildArtifact(file));
    for (let offset = 0; offset < untracked.length; offset += 128) await git(['add', '--', ...untracked.slice(offset, offset + 128)]);
    const tree = await git(['write-tree']);
    const commit = await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'CorePilot development source snapshot']);
    return { commit, tree };
  } finally {
    await fs.promises.rm(temporary, { recursive: true, force: true });
  }
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
