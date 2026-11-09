import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Worktrees stay outside the source repository, including on Windows long-path hosts. */
export function localWorktreeRoot(repository: string, root?: string): string {
  const identity = createHash('sha256').update(path.resolve(repository)).digest('hex').slice(0, 16);
  return path.join(root ?? path.join(os.tmpdir(), 'corepilot-worktrees'), identity);
}
