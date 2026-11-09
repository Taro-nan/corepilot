import path from 'node:path';
import { createHash } from 'node:crypto';

function label(value: string, fallback: string) {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 60) || fallback;
}

/** Human-readable location; source and output identities still use full recorded IDs. */
export function remoteRunLayout(input: { workspaceRoot: string; projectName: string; projectId: string; branch: string;
  commit: string; runId: string; purpose: string; createdAt: string }) {
  const branchHash = createHash('sha256').update(input.branch).digest('hex').slice(0, 8);
  const timestamp = input.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const run = path.posix.join(input.workspaceRoot.replaceAll('\\', '/'), 'projects', `${label(input.projectName, 'project')}-${input.projectId.slice(0, 8)}`,
    'branches', `${label(input.branch, 'detached')}-${branchHash}`, 'runs',
    `${timestamp}-${input.purpose === 'BASELINE_BUILD' ? 'baseline' : 'validation'}-${input.commit.slice(0, 8)}-${input.runId.slice(0, 8)}`);
  return { run_root: run, source_root: path.posix.join(run, 'source'), logs_root: path.posix.join(run, 'logs'),
    build_root: path.posix.join(run, 'build'),
    artifacts_root: path.posix.join(run, 'artifacts'), metadata_path: path.posix.join(run, 'run.json'),
    source_archive_path: path.posix.join(run, 'source.tar.gz') };
}
