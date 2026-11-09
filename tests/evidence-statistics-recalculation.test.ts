import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { validationTestpackDigest } from '../src/testpack/validation-freeze.js';
import { recalculateFrozenEvidenceArchive } from '../src/application/evidence-statistics-recalculation.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts, seedLegacyApprovedEvidence } from './workflow-approval-fixture.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
type Archive = { format: string; manifest: { digest: string; files: Array<{ relative_path: string; size_bytes: number; sha256: string }> };
  files: Array<{ relative_path: string; base64: string }> };

function archiveTools(filename: string, root: string) {
  const base = JSON.parse(gunzipSync(fs.readFileSync(filename)).toString('utf8')) as Archive;
  const read = (archive: Archive, name: string) => JSON.parse(Buffer.from(archive.files.find(row => row.relative_path === name)!.base64, 'base64').toString('utf8'));
  const put = (archive: Archive, name: string, value: unknown) => {
    const bytes = json(value), i = archive.files.findIndex(row => row.relative_path === name);
    assert.notEqual(i, -1);
    archive.files[i].base64 = bytes.toString('base64');
    Object.assign(archive.manifest.files[i], { size_bytes: bytes.length, sha256: hash(bytes) });
  };
  const testpack = (archive: Archive, mutate: (value: any) => void) => {
    const value = read(archive, 'testpack.json'); mutate(value.testpack); value.digest = validationTestpackDigest(value.testpack); put(archive, 'testpack.json', value);
  };
  let sequence = 0;
  const altered = (mutate: (archive: Archive) => void) => {
    const archive = structuredClone(base); mutate(archive); archive.manifest.digest = hash(JSON.stringify(archive.manifest.files));
    const bytes = gzipSync(json(archive)), output = path.join(root, `offline-recalculation-${sequence++}.json.gz`); fs.writeFileSync(output, bytes);
    return { output, sha256: hash(bytes) };
  };
  const recalculate = (item: { output: string; sha256: string }) => recalculateFrozenEvidenceArchive(item.output, item.sha256).performance_recalculation;
  return { base, read, put, testpack, altered, recalculate };
}

test('offline CLI separately recalculates original and revalidation measurements after integrity verification', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true, twoWorkloads: true });
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const result = recalculateFrozenEvidenceArchive(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256);
    assert.equal(result.performance_recalculation?.status, 'MATCH');
    assert.equal(result.performance_recalculation?.formal?.status, 'MATCH');
    assert.equal(result.performance_recalculation?.revalidation?.status, 'MATCH');
    assert.equal(result.performance_recalculation?.formal?.workload_count, 2);
    assert.ok(Math.abs(result.performance_recalculation!.formal!.weighted_geomean! - 2) < 1e-12);
    assert.ok(Math.abs(result.performance_recalculation!.revalidation!.weighted_geomean! - 2.2) < 1e-12);
    assert.notEqual(result.performance_recalculation!.formal!.recomputed_sample_digest, result.performance_recalculation!.revalidation!.recomputed_sample_digest);
    assert.match(result.not_verified.join(' '), /experiment authenticity.*statistical assumptions/);
    assert.match(result.not_verified.join(' '), /correctness and evaluator qualification/);

    const marker = path.join(f.root, 'must-not-run');
    const a = archiveTools(snapshot.artifact.archive_path, f.root);
    const untrusted = a.altered(archive => {
      const bytes = Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');`);
      const entry = { relative_path: 'evaluator/suspicious.js', base64: bytes.toString('base64') };
      const manifest = { relative_path: entry.relative_path, size_bytes: bytes.length, sha256: hash(bytes) };
      const i = archive.files.findIndex(row => row.relative_path > entry.relative_path);
      archive.files.splice(i, 0, entry); archive.manifest.files.splice(i, 0, manifest);
    });
    const cli = spawnSync(process.execPath,
      ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('src/entry.ts'), 'evidence', 'verify', untrusted.output,
        '--sha256', untrusted.sha256, '--recalculate-performance', '--json'],
      { cwd: f.root, encoding: 'utf8', windowsHide: true, env: { ...process.env, COREPILOT_SERVER_URL: 'http://127.0.0.1:1' } });
    assert.equal(cli.status, 0, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.equal(output.ok, true); assert.equal(output.performance_recalculation.status, 'MATCH');
    assert.equal(fs.existsSync(marker), false);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { await f.close(); }
});

test('offline recalculation refuses modified samples, swapped rounds, parameters and untrusted/missing inputs even when archive hashes are recomputed', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true });
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const a = archiveTools(snapshot.artifact.archive_path, f.root);
    const sample = a.altered(archive => {
      const rows = a.read(archive, 'formal/measurements.json'); rows.find((row: any) => row.kind === 'PERFORMANCE_SAMPLE').value *= 1.5;
      a.put(archive, 'formal/measurements.json', rows);
    });
    assert.equal(a.recalculate(sample).formal?.status, 'INCONSISTENT');
    assert.equal(a.recalculate(sample).revalidation?.status, 'MATCH');
    const swapped = a.altered(archive => a.put(archive, 'formal/measurements.json', a.read(archive, 'revalidation/measurements.json')));
    assert.equal(a.recalculate(swapped).formal?.status, 'INVALID');
    const relabelled = a.altered(archive => {
      const formal = a.read(archive, 'formal/experiment.json'), rows = a.read(archive, 'revalidation/measurements.json');
      for (const row of rows) row.experiment_id = formal.experiment_id;
      a.put(archive, 'formal/measurements.json', rows);
    });
    assert.equal(a.recalculate(relabelled).formal?.status, 'INCONSISTENT');
    const parameters = a.altered(archive => a.testpack(archive, value => { value.performance.cases[0].parameters.m += 1; }));
    assert.equal(a.recalculate(parameters).formal?.status, 'INCONSISTENT');
    const wrongThreads = a.altered(archive => {
      const rows = a.read(archive, 'formal/measurements.json'); rows.find((row: any) => row.kind === 'PERFORMANCE_SAMPLE').domain_payload.parameters.threads = 999;
      a.put(archive, 'formal/measurements.json', rows);
    });
    assert.equal(a.recalculate(wrongThreads).formal?.status, 'INCONSISTENT');
    const wrongUnit = a.altered(archive => {
      const rows = a.read(archive, 'formal/measurements.json'); rows.find((row: any) => row.kind === 'PERFORMANCE_SAMPLE').unit = 'milliseconds';
      a.put(archive, 'formal/measurements.json', rows);
    });
    assert.equal(a.recalculate(wrongUnit).formal?.status, 'INVALID');
    const missing = a.altered(archive => {
      const i = archive.files.findIndex(row => row.relative_path === 'formal/measurements.json');
      archive.files.splice(i, 1); archive.manifest.files.splice(i, 1);
    });
    assert.equal(a.recalculate(missing).formal?.status, 'MISSING');
    const wrongDigest = a.altered(archive => { const plan = a.read(archive, 'testpack.json'); plan.digest = '0'.repeat(64); a.put(archive, 'testpack.json', plan); });
    assert.equal(a.recalculate(wrongDigest).status, 'INVALID');
    const evaluator = a.altered(archive => { const task = a.read(archive, 'task.json'); task.evaluator.digest = '0'.repeat(64); a.put(archive, 'task.json', task); });
    assert.equal(a.recalculate(evaluator).status, 'INCONSISTENT');
    assert.throws(() => recalculateFrozenEvidenceArchive(sample.output, '0'.repeat(64)), /archive SHA-256 mismatch/);
    const cli = spawnSync(process.execPath,
      ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('src/entry.ts'), 'evidence', 'verify', sample.output,
        '--sha256', sample.sha256, '--recalculate-performance', '--json'], { cwd: f.root, encoding: 'utf8', windowsHide: true });
    assert.equal(cli.status, 2, cli.stderr); assert.equal(JSON.parse(cli.stdout).ok, false);
  } finally { await f.close(); }
});

test('offline recalculation distinguishes historical, unsupported, invalid and bounded computation', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId);
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const a = archiveTools(snapshot.artifact.archive_path, f.root);
    const unsupported = a.altered(archive => a.testpack(archive, value => { value.performance.statistics.method = 'future-method'; }));
    assert.equal(a.recalculate(unsupported).status, 'UNSUPPORTED');
    const invalid = a.altered(archive => a.testpack(archive, value => { value.performance.statistics.seed = -1; }));
    assert.equal(a.recalculate(invalid).status, 'INVALID');
    const invalidThreshold = a.altered(archive => a.testpack(archive, value => { value.performance.thresholds.weighted_geomean_min = -1; }));
    assert.equal(a.recalculate(invalidThreshold).status, 'INVALID');
    const invalidConfidence = a.altered(archive => a.testpack(archive, value => { value.performance.thresholds.confidence_level = 1; }));
    assert.equal(a.recalculate(invalidConfidence).status, 'INVALID');
    const zeroWeight = a.altered(archive => a.testpack(archive, value => { value.performance.cases[0].weight = 0; }));
    assert.equal(a.recalculate(zeroWeight).status, 'INVALID');
    const duplicate = a.altered(archive => a.testpack(archive, value => { value.performance.cases.push({ ...value.performance.cases[0] }); }));
    assert.equal(a.recalculate(duplicate).status, 'INVALID');
    const tooMany = a.altered(archive => a.testpack(archive, value => { value.performance.sampling.samples = 1001; }));
    assert.equal(a.recalculate(tooMany).status, 'LIMIT_EXCEEDED');
    const costly = a.altered(archive => a.testpack(archive, value => { value.performance.sampling.samples = 1000; value.performance.statistics.iterations = 20000; }));
    assert.equal(a.recalculate(costly).status, 'LIMIT_EXCEEDED');
    const unusualKey = a.altered(archive => {
      const value = a.read(archive, 'testpack.json');
      Object.defineProperty(value.testpack, '__proto__', { value: { injected: true }, enumerable: true });
      a.put(archive, 'testpack.json', value);
    });
    assert.equal(a.recalculate(unusualKey).status, 'INVALID');
    const tooDeep = a.altered(archive => a.testpack(archive, value => {
      let next = value;
      for (let i = 0; i < 70; i++) { next.extra = {}; next = next.extra; }
    }));
    assert.equal(a.recalculate(tooDeep).status, 'LIMIT_EXCEEDED');
  } finally { await f.close(); }

  const legacy = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(legacy, true);
    const facts = seedApprovalFacts(legacy, seeded.workflowId, { statisticalGate: false });
    const historical = seedLegacyApprovedEvidence(legacy, seeded.workflowId, facts);
    const result = recalculateFrozenEvidenceArchive(historical.artifact.archive_path, historical.artifact.archive_sha256);
    assert.equal(result.performance_recalculation?.status, 'LEGACY');
    assert.match(result.performance_recalculation!.message, /外部下界/);
  } finally { await legacy.close(); }
});
