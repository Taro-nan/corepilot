import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { freezeEvidenceFiles } from '../src/workspace/freeze-evidence.js';
import { verifyFrozenEvidenceArchive, verifyFrozenEvidenceArtifact } from '../src/workspace/frozen-evidence.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts } from './workflow-approval-fixture.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-evidence-verifier-'));
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
  const evidence = { record_type: 'OPTIMIZATION_EVIDENCE_FREEZE', schema_version: 1, task_id: 'task:fixture', candidate_id: 'candidate:fixture',
    candidate_commit: commit, candidate_tree: tree, first_formal_experiment_id: 'experiment:formal', revalidation_experiment_id: 'experiment:repeat' };
  const task = { task_id: evidence.task_id, fixture_private_value: 'private fixture credential' };
  const candidate = { task_id: evidence.task_id, candidate_id: evidence.candidate_id, source: { commit, tree } };
  const formal = { experiment_id: evidence.first_formal_experiment_id, task_id: evidence.task_id, candidate_id: evidence.candidate_id, type: 'FORMAL_EVALUATION' };
  const repeated = { experiment_id: evidence.revalidation_experiment_id, task_id: evidence.task_id, candidate_id: evidence.candidate_id, type: 'REVALIDATION' };
  const files = new Map([['evidence.json', json(evidence)], ['task.json', json(task)], ['candidate.json', json(candidate)],
    ['formal/experiment.json', json(formal)], ['revalidation/experiment.json', json(repeated)],
    ['source/candidate.patch', Buffer.from('private source contents')]]);
  const artifact = freezeEvidenceFiles(path.join(root, 'original'), files);
  const archive = path.join(root, 'obtained.json.gz'); fs.copyFileSync(artifact.archive_path, archive);
  const base = JSON.parse(gunzipSync(fs.readFileSync(archive)).toString('utf8')) as {
    format: string; manifest: { digest: string; files: Array<{ relative_path: string; sha256: string; size_bytes: number }> };
    files: Array<{ relative_path: string; base64: string }>;
  };
  function altered(change: (value: typeof base) => void) {
    const value = structuredClone(base); change(value);
    const bytes = gzipSync(json(value)); const filename = path.join(root, `altered-${Math.random()}.gz`); fs.writeFileSync(filename, bytes);
    return { filename, sha256: hash(bytes) };
  }
  function replace(value: typeof base, filename: string, data: Buffer) {
    const i = value.manifest.files.findIndex(item => item.relative_path === filename);
    value.files[i].base64 = data.toString('base64');
    value.manifest.files[i].sha256 = hash(data); value.manifest.files[i].size_bytes = data.length;
    value.manifest.digest = hash(JSON.stringify(value.manifest.files));
  }
  const cli = (args: string[]) => spawnSync(process.execPath,
    ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('src/entry.ts'), 'evidence', 'verify', archive, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, COREPILOT_SERVER_URL: 'http://127.0.0.1:1' } });
  function close() {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('corepilot-evidence-verifier-')) throw new Error('unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, artifact, archive, base, altered, replace, cli, close };
}

test('offline CLI verifies an obtained archive without its original directory and reports only limited identities', () => {
  const f = fixture();
  try {
    assert.equal(verifyFrozenEvidenceArtifact(f.artifact).record_type, 'OPTIMIZATION_EVIDENCE_FREEZE');
    const original = path.resolve(path.dirname(f.artifact.manifest_path));
    assert.equal(path.dirname(original), path.join(f.root, 'original'));
    assert.ok(path.basename(original).startsWith('evidence-'));
    fs.rmSync(original, { recursive: true, force: true });
    const result = f.cli(['--sha256', f.artifact.archive_sha256, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.archive_sha256, f.artifact.archive_sha256);
    assert.equal(output.file_count, f.base.manifest.files.length);
    assert.equal(output.identity.candidate_id, 'candidate:fixture');
    assert.match(output.not_verified.join(' '), /statistical conclusions/);
    assert.doesNotMatch(result.stdout, /private source contents/);
    assert.doesNotMatch(result.stdout, /private fixture credential/);
    const missingDigest = f.cli(['--json']);
    assert.notEqual(missingDigest.status, 0, 'an externally supplied SHA-256 is mandatory');
    assert.equal(JSON.parse(missingDigest.stderr).code, 'EVIDENCE_VERIFICATION_FAILED');
    assert.notEqual(f.cli(['--sha256', '0'.repeat(64)]).status, 0);
  } finally { f.close(); }
});

test('rejects corrupted archive, inventory, archived file, unsafe paths, and duplicate entries', () => {
  const f = fixture();
  try {
    const malformed = path.join(f.root, 'invalid.gz'); fs.writeFileSync(malformed, 'not gzip');
    assert.throws(() => verifyFrozenEvidenceArchive(malformed, hash('not gzip')), /malformed/);
    const cases: Array<[string, (archive: typeof f.base) => void, RegExp]> = [
      ['inventory', value => { value.manifest.digest = '0'.repeat(64); }, /inventory digest/],
      ['file bytes', value => { value.files[0].base64 = Buffer.from('different bytes').toString('base64'); }, /file identity/],
      ['base64', value => { value.files[0].base64 += '!'; }, /file identity/],
      ['path escape', value => { value.manifest.files[0].relative_path = '../escape'; value.files[0].relative_path = '../escape'; value.manifest.digest = hash(JSON.stringify(value.manifest.files)); }, /invalid Evidence file inventory/],
      ['duplicates', value => { value.manifest.files.push({ ...value.manifest.files[0] }); value.files.push({ ...value.files[0] }); value.manifest.digest = hash(JSON.stringify(value.manifest.files)); }, /invalid Evidence file inventory/],
      ['file count', value => { value.manifest.files = Array.from({ length: 25_001 }, () => value.manifest.files[0]); value.manifest.digest = hash(JSON.stringify(value.manifest.files)); }, /file-count limit/],
      ['identity', value => { f.replace(value, 'candidate.json', json({ candidate_id: 'candidate:other', task_id: 'task:fixture', source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) } })); }, /identity records/],
      ['record type', value => { f.replace(value, 'evidence.json', json({ record_type: 'INVALID' })); }, /not a frozen optimization artifact/],
      ['malformed record', value => { f.replace(value, 'evidence.json', Buffer.from('private-fixture-secret not json')); }, /invalid evidence.json/],
    ];
    for (const [name, change, error] of cases) {
      const item = f.altered(change);
      assert.throws(() => verifyFrozenEvidenceArchive(item.filename, item.sha256), error, name);
    }
    const secret = f.altered(value => f.replace(value, 'evidence.json', Buffer.from('private-fixture-secret not json')));
    assert.throws(() => verifyFrozenEvidenceArchive(secret.filename, secret.sha256), error => error instanceof Error && !error.message.includes('private-fixture-secret'));
    assert.throws(() => verifyFrozenEvidenceArchive(f.archive, ''), /可信渠道/);
  } finally { f.close(); }
});

test('offline verifier accepts the V1 archive produced by the shared evidence preparation path', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId);
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const result = verifyFrozenEvidenceArchive(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256);
    assert.equal(result.identity.candidate_commit, seeded.checkpoint.commit);
    assert.equal(result.identity.candidate_tree, seeded.checkpoint.tree);
    assert.equal(result.identity.candidate_id, seeded.candidate.candidate_id);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { await f.close(); }
});

test('legacy V1 archives lacking a repeated tree field remain inspectable without inventing it', () => {
  const f = fixture();
  try {
    const original = JSON.parse(Buffer.from(f.base.files.find(file => file.relative_path === 'evidence.json')!.base64, 'base64').toString('utf8'));
    delete original.candidate_tree;
    const item = f.altered(value => f.replace(value, 'evidence.json', json(original)));
    const result = verifyFrozenEvidenceArchive(item.filename, item.sha256);
    assert.ok(result.not_verified.some(message => message.includes('not separately recorded')));
    assert.equal(result.identity.candidate_tree, 'b'.repeat(40));
  } finally { f.close(); }
});

test('compressed size, decompressed size and file count are bounded before verification', () => {
  const f = fixture();
  try {
    const bytes = fs.readFileSync(f.archive);
    const inflated = gunzipSync(bytes);
    assert.throws(() => verifyFrozenEvidenceArchive(f.archive, f.artifact.archive_sha256, { archiveBytes: bytes.length - 1 }), /大小上限/);
    assert.throws(() => verifyFrozenEvidenceArchive(f.archive, f.artifact.archive_sha256, { inflatedBytes: inflated.length - 1 }), /decompressed-size limit/);
    assert.throws(() => verifyFrozenEvidenceArchive(f.archive, f.artifact.archive_sha256, { files: f.base.files.length - 1 }), /file-count limit/);
    assert.throws(() => verifyFrozenEvidenceArchive(f.archive, f.artifact.archive_sha256, { archiveBytes: 256 * 1024 * 1024 + 1 }), /invalid offline Evidence verification limits/);
  } finally { f.close(); }
});
