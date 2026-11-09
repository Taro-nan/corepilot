import path from 'node:path';
import { exportGitSourceArchive } from './git-source-archive.js';
import type { RunnerClient } from '../client/runner-client.js';

/** One source transfer contract for optimization and development snapshots. */
export async function stageRpcSource(input: { repository: string; commit: string; localDirectory: string;
  remoteRoot: string; runner: RunnerClient; expectedSourceDigest?: string; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const archive = await exportGitSourceArchive(input.repository, input.commit, path.join(input.localDirectory, `${input.commit}.tar.gz`));
  const staged = await input.runner.uploadSourceArchive({ filename: archive.path, sha256: archive.sha256,
    workspacePath: path.posix.join(input.remoteRoot, 'source') }, input.signal);
  if (input.expectedSourceDigest && staged.source_sha256 !== input.expectedSourceDigest) throw new Error('Runner source differs from the frozen Candidate');
  return staged;
}
