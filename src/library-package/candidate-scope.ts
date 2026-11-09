import type { CandidateSourceScope } from '../contracts/library-package.js';
import { isProtectedWorkspacePath } from '../contracts/source-scope.js';

export function candidatePathAllowed(scope: CandidateSourceScope, filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some((part) => part === '..' || part === '.' || !part)) return false;
  if (isProtectedWorkspacePath(normalized) || ['packages', 'evaluators'].includes(normalized.split('/')[0].toLowerCase())) return false;
  const matches = (entry: string) => entry.endsWith('/') ? normalized.startsWith(entry) : normalized === entry;
  return scope.include.some(matches) && !scope.exclude.some(matches);
}

export function assertCandidateSourceScope(scope: CandidateSourceScope, filenames: readonly string[]): void {
  for (const filename of filenames) if (!candidatePathAllowed(scope, filename)) throw new Error(`候选源码超出允许修改范围：${filename}`);
}
