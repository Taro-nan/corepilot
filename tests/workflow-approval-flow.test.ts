import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ApiClient } from '../src/client/api-client.js';
import { startWebFixture, runFixtureCli } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts } from './workflow-approval-fixture.js';
import { freezeEvidenceFiles } from '../src/workspace/freeze-evidence.js';

test('HTTP and CLI freeze real persisted fixture facts, require explicit approval, then deliver the approved tree', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const api = new ApiClient(f.url, { token: f.token });
    const baseline = f.git('rev-parse', 'HEAD');
    await assert.rejects(api.requestWorkflowApprove(seeded.workflowId, { commit_message: 'fixture delivery' }), /人工明确批准/);
    assert.equal(f.git('rev-parse', 'HEAD'), baseline);
    assert.equal((await api.getOptimizationReport(seeded.workflowId)).report.summary?.state, 'READY_FOR_REVIEW');
    const prepared = await runFixtureCli(f.url, f.token, ['workflow', 'evidence', seeded.workflowId, '--prepare', '--json']);
    assert.equal(prepared.code, 0, prepared.stderr);
    const snapshot = JSON.parse(prepared.stdout).snapshot;
    const repeated = await api.prepareWorkflowEvidence(seeded.workflowId);
    assert.equal(repeated.snapshot.artifact.digest, snapshot.artifact.digest);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
    const archive = JSON.parse(gunzipSync(await api.downloadWorkflowEvidence(seeded.workflowId)).toString('utf8'));
    assert.equal(archive.format, 'COREPILOT_EVIDENCE_JSON_GZIP_V1');
    assert.ok(archive.files.some((item: { relative_path: string }) => item.relative_path === 'formal/measurements.json'));
    assert.ok(archive.files.some((item: { relative_path: string }) => item.relative_path === 'evaluator/qualification.json'));
    const patch = archive.files.find((item: { relative_path: string }) => item.relative_path === 'source/candidate.patch');
    assert.match(Buffer.from(patch.base64, 'base64').toString('utf8'), /return 2/);
    assert.equal((await api.getWorkflowEvidence(seeded.workflowId)).evidence.candidate_commit, seeded.checkpoint.commit);
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: '0'.repeat(64), reviewer: 'Fixture', authorization_reference: 'explicit' }), /证据已变化/);
    const original = f.store.getExperiment(facts.repeated.experiment_id)!;
    f.store.saveExperiment({ ...original, declared_context: { ...original.declared_context, modified_fixture: true } });
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest, reviewer: 'Fixture', authorization_reference: 'explicit' }), /实验事实或冻结测试方案已变化/);
    f.store.saveExperiment(original);
    const approved = await runFixtureCli(f.url, f.token, ['workflow', 'human-approve', seeded.workflowId, '--reviewer', 'Fixture Reviewer',
      '--authorization-reference', 'Owner explicitly authorizes this fixture', '--evidence-digest', snapshot.artifact.digest, '--json']);
    assert.equal(approved.code, 0, approved.stderr);
    const approval = JSON.parse(approved.stdout).approval;
    assert.equal(approval.evidence_artifact_identity.digest, snapshot.artifact.digest);
    assert.equal(approval.candidate_commit, seeded.checkpoint.commit);
    assert.equal(approval.reviewer, 'Fixture Reviewer');
    assert.equal(f.git('rev-parse', 'HEAD'), baseline, 'approval must not deliver source');
    assert.equal(f.store.getCandidate(seeded.candidate.candidate_id)?.status, 'APPROVED');
    assert.equal((await api.getOptimizationReport(seeded.workflowId)).report.summary?.state, 'READY_FOR_DELIVERY');
    const same = await api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'Owner explicitly authorizes this fixture' });
    assert.equal(same.approval.approval_id, approval.approval_id);
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'different authorization' }), /cannot change/);
    const delivered = await runFixtureCli(f.url, f.token, ['workflow', 'deliver', seeded.workflowId, '--commit-message', 'fixture delivery', '--json']);
    assert.equal(delivered.code, 0, delivered.stderr);
    assert.equal(f.git('rev-parse', 'HEAD^{tree}'), seeded.checkpoint.tree);
    const completed = f.service.get(seeded.workflowId)!;
    assert.equal(completed.delivery?.approval_id, approval.approval_id);
    assert.equal(completed.delivery?.evidence_id, snapshot.artifact.evidence_id);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});

test('incomplete sample inventories or duplicate correctness records cannot be frozen as approval evidence', async () => {
  for (const mode of ['missing-one-sample', 'missing-whole-workload', 'duplicate-correctness'] as const) {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f, true);
      const facts = seedApprovalFacts(f, seeded.workflowId, { omitRevalidationCandidateSample: mode === 'missing-one-sample' ? 1 : undefined,
        extraUnobservedWorkload: mode === 'missing-whole-workload' });
      if (mode === 'duplicate-correctness') {
        const row = f.store.listMeasurements(facts.repeated.experiment_id).find(item => item.kind === 'CORRECTNESS_CASE');
        assert.ok(row);
        f.store.appendMeasurement({ ...row, measurement_id: `measurement:${randomUUID()}` });
      }
      const api = new ApiClient(f.url, { token: f.token });
      await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /缺少完整的原始正确性记录|原始记录不完整/);
      assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
      assert.equal(f.git('rev-parse', 'HEAD'), seeded.workspace.baseline_commit);
    } finally { await f.close(); }
  }
});

test('new approval evidence recomputes each gate from its own persisted samples', async () => {
  for (const statisticalGate of [false, true]) {
    const f = await startWebFixture();
    let db: DatabaseSync | undefined;
    try {
      const seeded = await seedBlockedValidation(f, true);
      const facts = seedApprovalFacts(f, seeded.workflowId, { statisticalGate, distinctRevalidation: true });
      const api = new ApiClient(f.url, { token: f.token });
      const first = f.store.listMeasurements(facts.first.experiment_id).filter(row => row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'CANDIDATE');
      const repeated = f.store.listMeasurements(facts.repeated.experiment_id).filter(row => row.kind === 'PERFORMANCE_SAMPLE' && row.role === 'CANDIDATE');
      db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
      const update = db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?');
      if (statisticalGate) {
        // Mixing in the other round's values keeps the inventory complete and
        // passing, but must not be accepted as this round's statistical evidence.
        for (const row of repeated) {
          const other = first.find(item => item.sample_index === row.sample_index)!;
          update.run(JSON.stringify({ ...row, value: other.value }), row.measurement_id);
        }
      } else {
        // A single positive replacement remains a passing point estimate but is
        // no longer the data which produced the saved result.
        const row = first[0];
        update.run(JSON.stringify({ ...row, value: (row.value as number) + 0.125 }), row.measurement_id);
      }
      await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /原始性能样本.*不一致/);
      const cli = await runFixtureCli(f.url, f.token, ['workflow', 'evidence', seeded.workflowId, '--prepare', '--json']);
      assert.notEqual(cli.code, 0);
      assert.match(cli.stderr, /原始性能样本.*不一致/);
      assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);

      for (const row of statisticalGate ? repeated : first) update.run(JSON.stringify(row), row.measurement_id);
      if (statisticalGate) {
        const original = f.store.getExperiment(facts.repeated.experiment_id)!;
        const modified = structuredClone(original);
        const gate = modified.evaluation!.details!.performance_gate as { statistics: { sample_digest: string } };
        gate.statistics.sample_digest = '0'.repeat(64);
        f.store.saveExperiment(modified);
        await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /原始性能样本.*不一致/);
        f.store.saveExperiment(original);
      }
      const snapshot = (await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot;
      assert.equal(snapshot.first_formal_experiment_id, facts.first.experiment_id);
      assert.equal(snapshot.revalidation_experiment_id, facts.repeated.experiment_id);
      assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
    } finally { db?.close(); await f.close(); }
  }
});

test('an older frozen archive cannot bypass sample verification when approved directly', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const api = new ApiClient(f.url, { token: f.token });
    const current = (await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot;
    const row = f.store.listMeasurements(facts.first.experiment_id).find(item => item.kind === 'PERFORMANCE_SAMPLE' && item.role === 'CANDIDATE')!;
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    db.prepare('UPDATE optimization_measurements SET record_json = ? WHERE measurement_id = ?')
      .run(JSON.stringify({ ...row, value: (row.value as number) + 0.125 }), row.measurement_id);

    // Simulate an archive generated by the old freeze path after the bad row
    // was persisted: its bytes and inventory are intact, but its claim is wrong.
    const root = path.dirname(current.artifact.manifest_path);
    const manifest = JSON.parse(fs.readFileSync(current.artifact.manifest_path, 'utf8')) as { files: Array<{ relative_path: string }> };
    const files = new Map(manifest.files.map(({ relative_path }) => [relative_path, fs.readFileSync(path.join(root, ...relative_path.split('/')))]));
    files.set('formal/measurements.json', Buffer.from(JSON.stringify(f.store.listMeasurements(facts.first.experiment_id), null, 2) + '\n'));
    const artifact = freezeEvidenceFiles(path.join(f.root, 'old-evidence'), files);
    const workflow = f.service.get(seeded.workflowId)!;
    f.store.saveOptimizationWorkflowJson(seeded.workflowId, JSON.stringify({ ...workflow, review_evidence: { ...current, artifact } }));
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'fixture' }), /原始性能样本.*不一致/);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { db?.close(); await f.close(); }
});

test('complete evaluator samples cannot conceal a workload missing from the frozen gate', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId, { extraUnobservedWorkload: true });
    for (const experiment of [facts.first, facts.repeated]) {
      const samples = f.store.listMeasurements(experiment.experiment_id).filter(row => row.kind === 'PERFORMANCE_SAMPLE');
      for (const row of samples) f.store.appendMeasurement({ ...row, measurement_id: `measurement:${randomUUID()}`, subject_id: 'workload-2' });
    }
    const api = new ApiClient(f.url, { token: f.token });
    await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /冻结测试方案与评价器负载/);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { await f.close(); }
});

test('unplanned samples and mixed revalidation prefixes cannot be ignored during freeze', async () => {
  const f = await startWebFixture();
  let db: DatabaseSync | undefined;
  try {
    const seeded = await seedBlockedValidation(f, true);
    const facts = seedApprovalFacts(f, seeded.workflowId);
    const sample = f.store.listMeasurements(facts.repeated.experiment_id).find(row => row.kind === 'PERFORMANCE_SAMPLE')!;
    const api = new ApiClient(f.url, { token: f.token });
    db = new DatabaseSync(path.join(f.root, 'db.sqlite'));
    for (const extra of [{ subject_id: 'unplanned-workload' }, { subject_id: `formal.${sample.subject_id}` }, { role: 'EVALUATOR' as const }]) {
      const measurement_id = `measurement:${randomUUID()}`;
      f.store.appendMeasurement({ ...sample, ...extra, measurement_id });
      await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /原始性能样本.*不一致/);
      db.prepare('DELETE FROM optimization_measurements WHERE measurement_id = ?').run(measurement_id);
    }
    // A complete legacy revalidation uses one consistent formal. prefix.
    for (const row of f.store.listMeasurements(facts.repeated.experiment_id).filter(item => item.kind === 'PERFORMANCE_SAMPLE')) {
      const subject_id = `formal.${row.subject_id}`;
      db.prepare('UPDATE optimization_measurements SET name = ?, record_json = ? WHERE measurement_id = ?')
        .run(subject_id, JSON.stringify({ ...row, subject_id }), row.measurement_id);
    }
    assert.ok((await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot);
  } finally { db?.close(); await f.close(); }
});

test('missing raw samples, modified evidence and revoked evaluator qualification block approval or delivery', async () => {
  for (const mode of ['missing-samples', 'modified-evidence', 'qualification-revoked', 'qualification-revoked-after-approval', 'raw-facts-changed-after-approval'] as const) {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f, true);
      const facts = seedApprovalFacts(f, seeded.workflowId, { omitRevalidationSamples: mode === 'missing-samples' });
      const api = new ApiClient(f.url, { token: f.token });
      if (mode === 'missing-samples') {
        await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /缺少完整的原始正确性记录/);
      } else {
        const snapshot = (await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot;
        if (mode === 'modified-evidence') {
          fs.appendFileSync(path.join(path.dirname(snapshot.artifact.manifest_path), 'formal', 'measurements.json'), 'tampered');
          await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
            reviewer: 'Fixture', authorization_reference: 'owner fixture' }), /identity mismatch/);
        } else if (mode === 'qualification-revoked') {
          const qualificationPath = path.join(facts.evaluatorRoot, 'qualification.json');
          const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
          qualification.status = 'QUALIFICATION_PENDING';
          fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
          await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
            reviewer: 'Fixture', authorization_reference: 'owner fixture' }), /QUALIFIED|qualification/i);
        } else {
          await api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
            reviewer: 'Fixture', authorization_reference: 'owner fixture' });
          if (mode === 'qualification-revoked-after-approval') {
            const qualificationPath = path.join(facts.evaluatorRoot, 'qualification.json');
            const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
            qualification.status = 'QUALIFICATION_PENDING';
            fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
          } else {
            const original = f.store.getExperiment(facts.repeated.experiment_id)!;
            f.store.saveExperiment({ ...original, declared_context: { ...original.declared_context, changed_after_approval: true } });
          }
          await assert.rejects(api.requestWorkflowApprove(seeded.workflowId, { commit_message: 'fixture delivery' }));
        }
      }
      assert.equal(!!f.store.getCandidateApproval(seeded.candidate.candidate_id), mode.endsWith('after-approval'));
      assert.equal(f.git('rev-parse', 'HEAD'), seeded.workspace.baseline_commit);
    } finally { await f.close(); }
  }
});

test('a lost workflow refresh after approval is recovered by retrying the same human decision', async () => {
  const f = await startWebFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    const seeded = await seedBlockedValidation(f, true);
    seedApprovalFacts(f, seeded.workflowId);
    const api = new ApiClient(f.url, { token: f.token });
    const snapshot = (await api.prepareWorkflowEvidence(seeded.workflowId)).snapshot;
    const input = { expected_evidence_digest: snapshot.artifact.digest, reviewer: 'Fixture', authorization_reference: 'owner reviewed fixture' };
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('fixture projection write failed'); };
    await assert.rejects(api.approveWorkflowEvidence(seeded.workflowId, input), /projection write failed/);
    const original = f.store.getCandidateApproval(seeded.candidate.candidate_id);
    assert.ok(original);
    assert.equal(f.git('rev-parse', 'HEAD'), seeded.workspace.baseline_commit);
    f.store.saveOptimizationWorkflowJson = save;
    const retried = await api.approveWorkflowEvidence(seeded.workflowId, input);
    assert.equal(retried.approval.approval_id, original.approval_id);
    assert.equal((await api.getOptimizationReport(seeded.workflowId)).report.summary?.state, 'READY_FOR_DELIVERY');
  } finally { f.store.saveOptimizationWorkflowJson = save; await f.close(); }
});
