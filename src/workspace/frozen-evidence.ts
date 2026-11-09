import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { FrozenEvidenceArtifactIdentity } from '../contracts/optimization-approval.js';

const ARCHIVE_FORMAT = 'COREPILOT_EVIDENCE_JSON_GZIP_V1';
const OFFLINE_LIMITS = { archiveBytes: 256 * 1024 * 1024, inflatedBytes: 512 * 1024 * 1024, files: 25_000 };
type InventoryFile = { relative_path: string; size_bytes: number; sha256: string };
type EvidenceManifest = { digest_algorithm: string; digest: string; files: InventoryFile[] };

function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }

function validateManifest(value: unknown, expectedDigest?: string, maxFiles?: number, strictPaths = false): EvidenceManifest {
  const manifest = value as EvidenceManifest | null;
  if (!manifest || manifest.digest_algorithm !== 'sha256-sorted-file-inventory-json' || !/^[0-9a-f]{64}$/.test(manifest.digest) ||
      (expectedDigest !== undefined && manifest.digest !== expectedDigest) || !Array.isArray(manifest.files) || !manifest.files.length ||
      (maxFiles !== undefined && manifest.files.length > maxFiles) || sha256(JSON.stringify(manifest.files)) !== manifest.digest) {
    throw new Error('Evidence inventory digest mismatch or inventory exceeds the file-count limit');
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!file || typeof file.relative_path !== 'string' || /[:\\\0]/.test(file.relative_path) ||
        (strictPaths && /[\x00-\x1f\x7f]/.test(file.relative_path)) || path.posix.isAbsolute(file.relative_path) ||
        file.relative_path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(file.relative_path) ||
        !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('invalid Evidence file inventory');
    }
    seen.add(file.relative_path);
  }
  if (!seen.has('evidence.json')) throw new Error('Evidence inventory is missing evidence.json');
  return manifest;
}

/** Shared validation of the self-contained V1 inventory and archived bytes. */
function inspectArchive(bytes: Buffer, options: { expectedManifest?: EvidenceManifest; limits?: typeof OFFLINE_LIMITS } = {}) {
  let archive: { format?: unknown; manifest?: unknown; files?: unknown };
  try {
    const decoded = options.limits ? gunzipSync(bytes, { maxOutputLength: options.limits.inflatedBytes }) : gunzipSync(bytes);
    archive = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Evidence archive is malformed or exceeds the decompressed-size limit');
  }
  if (!archive || typeof archive !== 'object' || archive.format !== ARCHIVE_FORMAT) throw new Error('unsupported Evidence archive format');
  const manifest = validateManifest(archive.manifest, undefined, options.limits?.files, !!options.limits);
  if ((options.expectedManifest && JSON.stringify(archive.manifest) !== JSON.stringify(options.expectedManifest)) ||
      !Array.isArray(archive.files) || archive.files.length !== manifest.files.length) throw new Error('Evidence archive inventory mismatch');
  const selected = new Map<string, Buffer>();
  const needed = new Set(['evidence.json', 'task.json', 'candidate.json', 'formal/experiment.json', 'revalidation/experiment.json']);
  for (let i = 0; i < manifest.files.length; i++) {
    const expected = manifest.files[i];
    const archived = archive.files[i] as { relative_path?: unknown; base64?: unknown } | null;
    if (!archived || archived.relative_path !== expected.relative_path || typeof archived.base64 !== 'string') throw new Error('Evidence archive file mismatch');
    const decoded = Buffer.from(archived.base64, 'base64');
    if (decoded.toString('base64') !== archived.base64 || decoded.length !== expected.size_bytes || sha256(decoded) !== expected.sha256) {
      throw new Error('Evidence archive file identity mismatch');
    }
    if (needed.has(expected.relative_path)) selected.set(expected.relative_path, decoded);
  }
  return { manifest, selected };
}

function parseEvidence(bytes: Buffer): Record<string, unknown> {
  let evidence: Record<string, unknown>;
  try { evidence = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
  catch { throw new Error('Evidence contains an invalid evidence.json record'); }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.record_type !== 'OPTIMIZATION_EVIDENCE_FREEZE') {
    throw new Error('Evidence is not a frozen optimization artifact');
  }
  return evidence;
}

export function verifyFrozenEvidenceArtifact(identity: FrozenEvidenceArtifactIdentity): Record<string, unknown> {
  if (!identity.evidence_id?.trim() || !/^[0-9a-f]{64}$/.test(identity.digest) || !/^[0-9a-f]{64}$/.test(identity.archive_sha256)) {
    throw new Error('invalid frozen Evidence identity');
  }
  if (!path.isAbsolute(identity.archive_path) || !path.isAbsolute(identity.manifest_path)) throw new Error('Evidence paths must be absolute');
  const archiveBytes = fs.readFileSync(identity.archive_path);
  if (sha256(archiveBytes) !== identity.archive_sha256) throw new Error('Evidence archive SHA-256 mismatch');
  if (identity.archive_format !== undefined && identity.archive_format !== ARCHIVE_FORMAT) throw new Error('unsupported Evidence archive format');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(identity.manifest_path, 'utf8')), identity.digest);
  const root = fs.realpathSync(path.dirname(identity.manifest_path));
  for (const file of manifest.files) {
    const filePath = path.join(root, ...file.relative_path.split('/'));
    const resolved = fs.realpathSync(filePath);
    if (!resolved.startsWith(root + path.sep) || fs.lstatSync(filePath).isSymbolicLink() || !fs.statSync(resolved).isFile()) {
      throw new Error('Evidence file escapes its frozen directory');
    }
    const bytes = fs.readFileSync(resolved);
    if (bytes.length !== file.size_bytes || sha256(bytes) !== file.sha256) throw new Error(`Evidence file identity mismatch: ${file.relative_path}`);
  }
  if (identity.archive_format === ARCHIVE_FORMAT) inspectArchive(archiveBytes, { expectedManifest: manifest });
  return parseEvidence(fs.readFileSync(path.join(root, 'evidence.json')));
}

function readBoundedArchive(filename: string, maximum: number): Buffer {
  const fd = fs.openSync(filename, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('归档不是普通文件或超过当前离线核验大小上限；这不代表证据无效。');
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const read = fs.readSync(fd, result, offset, result.length - offset, offset);
      if (!read) throw new Error('归档读取过程中发生变化，请重新获取文件。');
      offset += read;
    }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, result.length)) throw new Error('归档读取过程中发生变化，请重新获取文件。');
    return result;
  } finally { fs.closeSync(fd); }
}

/** Verify an obtained V1 archive without extracting it or using a server directory. */
export function verifyFrozenEvidenceArchive(archivePath: string, expectedSha256: string, stricterLimits: Partial<typeof OFFLINE_LIMITS> = {}) {
  if (!/^[0-9a-f]{64}$/i.test(expectedSha256)) throw new Error('必须提供通过可信渠道取得的 64 位归档 SHA-256。');
  const limits = { ...OFFLINE_LIMITS, ...stricterLimits };
  for (const key of Object.keys(OFFLINE_LIMITS) as Array<keyof typeof OFFLINE_LIMITS>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > OFFLINE_LIMITS[key]) throw new Error('invalid offline Evidence verification limits');
  }
  const bytes = readBoundedArchive(archivePath, limits.archiveBytes);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256.toLowerCase()) throw new Error('Evidence archive SHA-256 mismatch');
  const { manifest, selected } = inspectArchive(bytes, { limits });
  const evidence = parseEvidence(selected.get('evidence.json')!);
  const record = (name: string): Record<string, unknown> => {
    const content = selected.get(name);
    if (!content) throw new Error('Evidence archive is missing a required identity record');
    try {
      const value: unknown = JSON.parse(content.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid record');
      return value as Record<string, unknown>;
    } catch { throw new Error('Evidence archive contains an invalid identity record'); }
  };
  const task = record('task.json'), candidate = record('candidate.json');
  const formal = record('formal/experiment.json'), repeated = record('revalidation/experiment.json');
  const source = candidate.source as Record<string, unknown> | undefined;
  const identity = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value);
  const gitObject = (value: unknown) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
  const tree = source?.tree;
  if (evidence.schema_version !== 1 || !identity(evidence.task_id) || !identity(evidence.candidate_id) ||
      !identity(evidence.first_formal_experiment_id) || !identity(evidence.revalidation_experiment_id) ||
      evidence.first_formal_experiment_id === evidence.revalidation_experiment_id ||
      !gitObject(evidence.candidate_commit) || !gitObject(tree) ||
      (evidence.candidate_tree != null && evidence.candidate_tree !== tree) ||
      task.task_id !== evidence.task_id || candidate.task_id !== evidence.task_id || candidate.candidate_id !== evidence.candidate_id ||
      !source || source.commit !== evidence.candidate_commit ||
      formal.experiment_id !== evidence.first_formal_experiment_id || repeated.experiment_id !== evidence.revalidation_experiment_id ||
      formal.type !== 'FORMAL_EVALUATION' || repeated.type !== 'REVALIDATION' ||
      [formal, repeated].some(item => item.task_id !== evidence.task_id || item.candidate_id !== evidence.candidate_id)) {
    throw new Error('Evidence archive identity records are incomplete or inconsistent');
  }
  return { format: ARCHIVE_FORMAT, archive_sha256: actualSha256, inventory_digest: manifest.digest, file_count: manifest.files.length,
    identity: { task_id: evidence.task_id, candidate_id: evidence.candidate_id, candidate_commit: evidence.candidate_commit,
      candidate_tree: tree, first_formal_experiment_id: evidence.first_formal_experiment_id,
      revalidation_experiment_id: evidence.revalidation_experiment_id },
    verified: ['archive SHA-256', 'inventory digest', 'archived file digests', 'record type', 'listed task/candidate/experiment identity links'],
    not_verified: ['archive origin or authority', 'statistical conclusions and experiment validity', 'approval or delivery', 'suitability for public release',
      ...(evidence.candidate_tree == null ? ['candidate tree was not separately recorded in evidence.json'] : [])],
    notice: '核验只说明归档与提供的摘要一致，以及所列记录之间的身份匹配；不证明来源、实验结论、人工批准、交付或公开安全。' };
}
