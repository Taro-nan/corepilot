import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FrozenEvidenceArtifactIdentity } from '../contracts/optimization-approval.js';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyFrozenEvidenceArtifact(identity: FrozenEvidenceArtifactIdentity): Record<string, unknown> {
  if (!identity.evidence_id?.trim() || !/^[0-9a-f]{64}$/.test(identity.digest) || !/^[0-9a-f]{64}$/.test(identity.archive_sha256)) {
    throw new Error('invalid frozen Evidence identity');
  }
  if (!path.isAbsolute(identity.archive_path) || !path.isAbsolute(identity.manifest_path)) throw new Error('Evidence paths must be absolute');
  if (sha256(fs.readFileSync(identity.archive_path)) !== identity.archive_sha256) throw new Error('Evidence archive SHA-256 mismatch');
  const manifest = JSON.parse(fs.readFileSync(identity.manifest_path, 'utf8')) as {
    digest_algorithm: string;
    digest: string;
    files: Array<{ relative_path: string; size_bytes: number; sha256: string }>;
  };
  if (manifest.digest_algorithm !== 'sha256-sorted-file-inventory-json' || manifest.digest !== identity.digest ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 || sha256(JSON.stringify(manifest.files)) !== identity.digest) {
    throw new Error('Evidence inventory digest mismatch');
  }
  const root = fs.realpathSync(path.dirname(identity.manifest_path));
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.relative_path !== 'string' || /[:\\\0]/.test(file.relative_path) ||
        path.posix.isAbsolute(file.relative_path) || file.relative_path.split('/').some(part => !part || part === '.' || part === '..') ||
        seen.has(file.relative_path) || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('invalid Evidence file inventory');
    }
    seen.add(file.relative_path);
    const filePath = path.join(root, ...file.relative_path.split('/'));
    const resolved = fs.realpathSync(filePath);
    if (!resolved.startsWith(root + path.sep) || fs.lstatSync(filePath).isSymbolicLink() || !fs.statSync(resolved).isFile()) {
      throw new Error('Evidence file escapes its frozen directory');
    }
    const bytes = fs.readFileSync(resolved);
    if (bytes.length !== file.size_bytes || sha256(bytes) !== file.sha256) throw new Error(`Evidence file identity mismatch: ${file.relative_path}`);
  }
  if (!seen.has('evidence.json')) throw new Error('Evidence inventory is missing evidence.json');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'evidence.json'), 'utf8')) as Record<string, unknown>;
  if (!evidence || Array.isArray(evidence) || evidence.record_type !== 'OPTIMIZATION_EVIDENCE_FREEZE') throw new Error('Evidence is not a frozen optimization artifact');
  return evidence;
}
