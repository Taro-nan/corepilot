import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { exportReviewSamples, verifyReviewSamples } from '../src/application/evidence-review-samples.js';
import { createReviewSamples, verifyReviewSamplesBytes } from '../src/application/review-samples.js';
import { evaluateStatisticalPerformance } from '../src/evaluator/performance-statistics.js';
import { validationTestpackDigest } from '../src/testpack/validation-freeze.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts, seedLegacyApprovedEvidence } from './workflow-approval-fixture.js';

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
type Archive = { manifest: { digest: string; files: Array<{ relative_path: string; size_bytes: number; sha256: string }> };
  files: Array<{ relative_path: string; base64: string }> };

function archiveTools(filename: string, root: string) {
  const base = JSON.parse(gunzipSync(fs.readFileSync(filename)).toString('utf8')) as Archive;
  const read = (archive: Archive, name: string) => JSON.parse(Buffer.from(archive.files.find(row => row.relative_path === name)!.base64, 'base64').toString('utf8'));
  const putBytes = (archive: Archive, name: string, bytes: Buffer) => {
    const i = archive.files.findIndex(row => row.relative_path === name);
    const entry = { relative_path: name, base64: bytes.toString('base64') };
    const item = { relative_path: name, size_bytes: bytes.length, sha256: hash(bytes) };
    if (i < 0) {
      archive.files.push(entry); archive.manifest.files.push(item);
      archive.files.sort((a, b) => a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0);
      archive.manifest.files.sort((a, b) => a.relative_path < b.relative_path ? -1 : a.relative_path > b.relative_path ? 1 : 0);
    } else { archive.files[i] = entry; archive.manifest.files[i] = item; }
  };
  const put = (archive: Archive, name: string, value: unknown) => putBytes(archive, name, Buffer.from(JSON.stringify(value)));
  let sequence = 0;
  const altered = (mutate: (archive: Archive) => void) => {
    const archive = structuredClone(base); mutate(archive); archive.manifest.digest = hash(JSON.stringify(archive.manifest.files));
    const bytes = gzipSync(Buffer.from(JSON.stringify(archive))), output = path.join(root, `source-${sequence++}.json.gz`);
    fs.writeFileSync(output, bytes);
    return { output, sha256: hash(bytes) };
  };
  return { base, read, put, putBytes, altered };
}

test('offline CLI emits a separately verified whitelist, preserving independent rounds and leaving the source intact', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true, twoWorkloads: true });
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const tools = archiveTools(snapshot.artifact.archive_path, f.root);
    const secrets = ['TOKEN-NEVER-EXPORT-12589', '/private/alice/source/secret.cpp', 'PRIVATE-SOURCE-CODE-24831',
      'PRIVATE-EVALUATOR-SCRIPT-38310', 'PRIVATE-COMMAND-AND-ENV-48392', 'PRIVATE-PARAMETERS-76531'];
    const source = tools.altered(archive => {
      for (const name of ['task.json', 'candidate.json', 'formal/experiment.json', 'revalidation/experiment.json']) {
        const value = tools.read(archive, name); value.private_debug = secrets[0]; tools.put(archive, name, value);
      }
      const plan = tools.read(archive, 'testpack.json');
      plan.testpack.performance.command.cwd = secrets[1]; plan.testpack.performance.command.environment = { PRIVATE_KEY: secrets[0] };
      plan.digest = validationTestpackDigest(plan.testpack); tools.put(archive, 'testpack.json', plan);
      for (const name of ['formal/measurements.json', 'revalidation/measurements.json']) {
        const rows = tools.read(archive, name);
        for (const row of rows) if (row.kind === 'PERFORMANCE_SAMPLE') row.domain_payload.parameters.private_extra = secrets[5];
        tools.put(archive, name, rows);
      }
      const commands = tools.read(archive, 'formal/commands.json'); commands[0].stdout = secrets[4];
      tools.put(archive, 'formal/commands.json', commands);
      tools.putBytes(archive, 'source/candidate.patch', Buffer.from(secrets[2]));
      tools.putBytes(archive, 'evaluator/private.sh', Buffer.from(secrets[3]));
    });
    const original = fs.readFileSync(source.output), out = path.join(f.root, 'review.json');
    const cliArgs = process.env.COREPILOT_TEST_BUILT_CLI === '1' ? [path.resolve('dist/entry.js')] :
      ['--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href, path.resolve('src/entry.ts')];
    const options = { cwd: f.root, encoding: 'utf8' as const, windowsHide: true,
      env: { ...process.env, COREPILOT_SERVER_URL: 'http://127.0.0.1:1' } };
    const exported = spawnSync(process.execPath, [...cliArgs, 'evidence', 'export-review', source.output, '--sha256', source.sha256, '--output', out, '--json'], options);
    assert.equal(exported.status, 0, exported.stderr);
    const response = JSON.parse(exported.stdout);
    assert.equal(response.ok, true); assert.equal(response.review, 'REVIEW_REQUIRED');
    assert.deepEqual(fs.readFileSync(source.output), original);
    const bytes = fs.readFileSync(out), text = bytes.toString('utf8'), pack = JSON.parse(text);
    assert.equal(response.sha256, hash(bytes));
    const evidence = tools.read(tools.base, 'evidence.json'), candidate = tools.read(tools.base, 'candidate.json');
    for (const secret of [...secrets, source.sha256, snapshot.artifact.archive_sha256, evidence.task_id, evidence.candidate_id,
      evidence.candidate_commit, candidate.source.tree, evidence.first_formal_experiment_id, evidence.revalidation_experiment_id, 'workload-1', 'workload-2']) {
      assert.equal(text.includes(secret), false, 'source identity or sensitive content leaked');
      assert.equal(exported.stdout.includes(secret), false, 'CLI leaked source identity or sensitive content');
    }
    assert.equal(pack.workloads.length, 2); assert.equal(pack.workloads[0].id, 'W001');
    assert.equal(pack.omitted.approval, 'NOT_INCLUDED'); assert.equal(pack.omitted.delivery, 'NOT_INCLUDED');
    assert.ok(Math.abs(pack.formal.result.weighted_geomean - 2) < 1e-12);
    assert.ok(Math.abs(pack.revalidation.result.weighted_geomean - 2.2) < 1e-12);
    assert.notDeepEqual(pack.formal.samples, pack.revalidation.samples);
    const verified = spawnSync(process.execPath, [...cliArgs, 'evidence', 'verify-review', out, '--sha256', response.sha256, '--json'], options);
    assert.equal(verified.status, 0, verified.stderr);
    const result = JSON.parse(verified.stdout);
    assert.equal(result.formal.weighted_geomean, pack.formal.result.weighted_geomean);
    assert.equal(result.revalidation.weighted_geomean, pack.revalidation.result.weighted_geomean);
    const badHash = spawnSync(process.execPath, [...cliArgs, 'evidence', 'verify-review', out, '--sha256', '0'.repeat(64), '--json'], options);
    assert.equal(badHash.status, 1);
    assert.equal(JSON.parse(badHash.stderr.split(/\r?\n/).find(line => line.startsWith('{'))!).code, 'EVIDENCE_REVIEW_VERIFICATION_FAILED');
    assert.equal(badHash.stderr.includes(out), false);
    const collision = spawnSync(process.execPath,
      [...cliArgs, 'evidence', 'export-review', source.output, '--sha256', source.sha256, '--output', out, '--json'], options);
    assert.equal(collision.status, 1);
    assert.equal(JSON.parse(collision.stderr.split(/\r?\n/).find(line => line.startsWith('{'))!).code, 'EVIDENCE_REVIEW_EXPORT_FAILED');
    assert.deepEqual(fs.readFileSync(out), bytes);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { await f.close(); }
});

test('source evidence inconsistencies, unsupported evidence and existing destinations never produce or replace an output', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true, twoWorkloads: true });
    const snapshot = f.service.approvals.prepare(seeded.workflowId);
    const a = archiveTools(snapshot.artifact.archive_path, f.root);
    const edited = a.altered(archive => {
      const rows = a.read(archive, 'formal/measurements.json'); rows.find((row: any) => row.kind === 'PERFORMANCE_SAMPLE').value *= 1.5;
      a.put(archive, 'formal/measurements.json', rows);
    });
    const missing = a.altered(archive => {
      const i = archive.files.findIndex(row => row.relative_path === 'formal/measurements.json');
      archive.files.splice(i, 1); archive.manifest.files.splice(i, 1);
    });
    const unsupported = a.altered(archive => {
      const plan = a.read(archive, 'testpack.json'); plan.testpack.performance.statistics.method = 'unknown-method';
      plan.digest = validationTestpackDigest(plan.testpack); a.put(archive, 'testpack.json', plan);
    });
    const costly = a.altered(archive => {
      const plan = a.read(archive, 'testpack.json'); plan.testpack.performance.sampling.samples = 1000;
      plan.testpack.performance.statistics.iterations = 20000;
      plan.digest = validationTestpackDigest(plan.testpack); a.put(archive, 'testpack.json', plan);
    });
    const out = path.join(f.root, 'should-not-exist.json');
    for (const input of [edited, missing, unsupported, costly, { output: snapshot.artifact.archive_path, sha256: '0'.repeat(64) }]) {
      assert.throws(() => exportReviewSamples(input.output, input.sha256, out)); assert.equal(fs.existsSync(out), false);
    }
    const original = fs.readFileSync(snapshot.artifact.archive_path);
    assert.throws(() => exportReviewSamples(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256, snapshot.artifact.archive_path), /已存在/);
    assert.deepEqual(fs.readFileSync(snapshot.artifact.archive_path), original);
    fs.writeFileSync(out, 'do not replace');
    assert.throws(() => exportReviewSamples(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256, out), /已存在/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'do not replace');
    assert.throws(() => exportReviewSamples(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256, path.join(f.root, 'missing-directory', 'out.json')));
    assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.corepilot-review-')), []);
  } finally { await f.close(); }

  const legacy = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(legacy, true);
    const facts = seedApprovalFacts(legacy, seeded.workflowId, { statisticalGate: false });
    const old = seedLegacyApprovedEvidence(legacy, seeded.workflowId, facts);
    const out = path.join(legacy.root, 'legacy-review.json');
    assert.throws(() => exportReviewSamples(old.artifact.archive_path, old.artifact.archive_sha256, out), /LEGACY/);
    assert.equal(fs.existsSync(out), false);
  } finally { await legacy.close(); }
});

test('review package rejects changes even with a recomputed file hash, extra content, malformed JSON and resource exhaustion', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId, { distinctRevalidation: true, twoWorkloads: true });
    const snapshot = f.service.approvals.prepare(seeded.workflowId), out = path.join(f.root, 'review.json');
    const exported = exportReviewSamples(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256, out);
    const original = fs.readFileSync(out, 'utf8'), template = JSON.parse(original);
    assert.throws(() => verifyReviewSamples(out, '0'.repeat(64)), /SHA-256/);
    let sequence = 0;
    const reject = (text: string | Buffer) => {
      const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text), file = path.join(f.root, `bad-${sequence++}.json`);
      fs.writeFileSync(file, bytes); assert.throws(() => verifyReviewSamples(file, hash(bytes)));
    };
    const mutate = (fn: (value: any) => void) => { const value = structuredClone(template); fn(value); reject(`${JSON.stringify(value, null, 2)}\n`); };
    mutate(value => { value.formal.samples[0].candidate[0] *= 2; });
    mutate(value => { value.formal.samples[0].baseline.pop(); });
    mutate(value => { value.formal.samples[0].workload_id = 'W002'; });
    mutate(value => { value.formal.samples[0].private_text = 'token'; });
    mutate(value => { value.formal.result.passed = false; });
    mutate(value => { value.formal.result.note = 'extra'; });
    mutate(value => { value.formal.result.weighted_geomean *= 1 + 1e-10; });
    mutate(value => { const { passed, verdict, ...rest } = value.formal.result; value.formal.result = { verdict, passed, ...rest }; });
    mutate(value => { const { method, ...rest } = value.policy; value.policy = { ...rest, method }; });
    mutate(value => { value.formal.samples = value.revalidation.samples; });
    mutate(value => { value.sampling.samples = 1001; });
    mutate(value => { value.sampling.samples = 1000; value.policy.iterations = 20000; });
    mutate(value => { value.workloads.push(value.workloads[0]); });
    mutate(value => { let current = value; for (let i = 0; i < 70; i++) current = current.extra = {}; });
    reject(original.replace('  "format":', '  "format": "COREPILOT_REVIEW_SAMPLES_V1",\n  "format":'));
    reject(original.replace('"weight": 1', '"weight": 1e400'));
    reject(original.slice(0, -5));
    reject(Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    assert.equal(verifyReviewSamples(out, exported.sha256).formal.passed, true);
    const rounded = structuredClone(template); rounded.formal.result.weighted_geomean *= 1 + 1e-13;
    const roundedBytes = Buffer.from(`${JSON.stringify(rounded, null, 2)}\n`), roundedPath = path.join(f.root, 'rounded.json');
    fs.writeFileSync(roundedPath, roundedBytes);
    assert.equal(verifyReviewSamples(roundedPath, hash(roundedBytes)).formal.weighted_geomean, template.formal.result.weighted_geomean);
  } finally { await f.close(); }
});

test('projection preserves distinct workload weighting, key flags, pairing and bootstrap order', () => {
  const cases = [{ case_id: 'private-a', threads: 1, weight: 1, critical: true, parameters: { secret: 'remove' } },
    { case_id: 'private-b', threads: 4, weight: 3, critical: false, parameters: { secret: 'remove' } }];
  const sampling = { warmup: 2, samples: 9, interleave_seed: 5, bootstrap_iterations: 100 };
  const policy = { method: 'paired-block-bootstrap-v1' as const, confidence_level: 0.95, iterations: 1000, seed: 42, block_length: 2, min_samples: 9 };
  const thresholds = { weighted_geomean_min: 1.01, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 };
  const performance = { cases, sampling, thresholds, statistics: policy, key_cases: ['private-b'] };
  const round = (factor: number) => cases.map((row, index) => ({ case_id: row.case_id,
    baseline_samples: Array.from({ length: 9 }, (_, i) => 100 + i * (index + 1)),
    candidate_samples: Array.from({ length: 9 }, (_, i) => (100 + i * (index + 1) + [-2, 1, 3, -3, 2, 0, 1, -1, 4][i]) / (factor + index / 10)),
    sample_indices: { baseline: Array.from({ length: 9 }, (_, i) => i), candidate: Array.from({ length: 9 }, (_, i) => i) } }));
  const first = evaluateStatisticalPerformance({ performance }, round(2)), repeated = evaluateStatisticalPerformance({ performance }, round(2.2));
  const unpaired = round(2); unpaired[0].candidate_samples.reverse();
  const withoutPairing = evaluateStatisticalPerformance({ performance }, unpaired);
  assert.equal(first.passed, true);
  assert.notDeepEqual(first.statistics!.overall_interval, withoutPairing.statistics!.overall_interval);
  const projected = createReviewSamples({ performance } as any, first, repeated);
  assert.notEqual(projected.workloads[0].weight, projected.workloads[1].weight);
  assert.equal(projected.workloads[1].key, true);
  assert.equal(projected.formal.result.weighted_geomean, first.weighted_geomean);
  assert.equal(projected.revalidation.result.weighted_geomean, repeated.weighted_geomean);
  const bytes = Buffer.from(`${JSON.stringify(projected, null, 2)}\n`);
  assert.deepEqual(verifyReviewSamplesBytes(bytes), projected);
  assert.equal(bytes.toString('utf8').includes('private-a'), false);
});
