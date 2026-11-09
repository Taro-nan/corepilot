/** Runtime placeholders are protocol fields, not control-machine filesystem paths. */
const CANDIDATE_ROOT = /\$\{[A-Z][A-Z0-9_]*_CANDIDATE_ROOT\}/g;

export function hasCandidateRoot(value: string): boolean {
  return /\$\{[A-Z][A-Z0-9_]*_CANDIDATE_ROOT\}/.test(value);
}

export function resolveCandidateRoot(value: string, root: string): string {
  return value.replace(CANDIDATE_ROOT, () => root);
}

export function candidateRelativePath(value: string): string | null {
  return value.replace(/\\/g, '/').match(/^\$\{[A-Z][A-Z0-9_]*_CANDIDATE_ROOT\}\/(.+)$/)?.[1] ?? null;
}
