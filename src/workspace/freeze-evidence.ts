import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FrozenEvidenceArtifactIdentity } from '../contracts/optimization-approval.js';
import { verifyFrozenEvidenceArtifact } from './frozen-evidence.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const format = 'COREPILOT_EVIDENCE_JSON_GZIP_V1' as const;

/** Freeze the supplied facts; the caller owns eligibility and identity checks. */
export function freezeEvidenceFiles(root: string, files: ReadonlyMap<string, Buffer>): FrozenEvidenceArtifactIdentity {
  const base = path.resolve(root);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(base, 'evidence-'));
  const paths = [...files.keys()].sort();
  if (!paths.includes('evidence.json')) throw new Error('Evidence is missing evidence.json');
  const inventory = paths.map(relative => {
    if (!relative || /[:\\\0]/.test(relative) || path.posix.isAbsolute(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid Evidence file path');
    const bytes = files.get(relative)!;
    const filename = path.join(directory, ...relative.split('/'));
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
    return { relative_path: relative, size_bytes: bytes.length, sha256: sha256(bytes) };
  });
  const digest = sha256(JSON.stringify(inventory));
  const manifest = { digest_algorithm: 'sha256-sorted-file-inventory-json', digest, files: inventory };
  const manifestPath = path.join(directory, 'evidence-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const archive = gzipSync(Buffer.from(JSON.stringify({ format, manifest,
    files: paths.map(relative_path => ({ relative_path, base64: files.get(relative_path)!.toString('base64') })) })));
  const archivePath = path.join(directory, 'evidence.json.gz');
  fs.writeFileSync(archivePath, archive, { mode: 0o600, flag: 'wx' });
  const identity: FrozenEvidenceArtifactIdentity = { evidence_id: `evidence:${digest}`, digest,
    archive_path: archivePath, archive_sha256: sha256(archive), manifest_path: manifestPath, archive_format: format };
  verifyFrozenEvidenceArtifact(identity);
  return identity;
}
