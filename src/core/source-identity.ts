import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Deterministic identity of a source/evaluator tree, excluding Git metadata. */
export function sourceTreeSha256(root: string): string {
  const absoluteRoot = path.resolve(root);
  const hash = createHash('sha256');
  for (const relative of sourceFiles(absoluteRoot)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(absoluteRoot, ...relative.split('/'))));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function sourceFiles(root: string, current = root): string[] {
  if (!fs.existsSync(current)) throw new Error(`content directory does not exist: ${root}`);
  if (!fs.statSync(current).isDirectory()) throw new Error(`content path is not a directory: ${root}`);
  const output: string[] = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in content tree: ${absolute}`);
    if (entry.isDirectory()) output.push(...sourceFiles(root, absolute));
    else if (entry.isFile()) output.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`unsupported content-tree entry: ${absolute}`);
  }
  return output.sort();
}
