import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import { recalculateFrozenEvidenceArchive } from '../src/application/evidence-statistics-recalculation.js';
import { exportReviewSamples, verifyReviewSamples } from '../src/application/evidence-review-samples.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts } from './workflow-approval-fixture.js';

for (const method of ['paired-block-bootstrap-v1', 'paired-block-bootstrap-v2'] as const) {
  test(`${method} keeps both rounds, offline recalculation, review export and explicit approval bound to its own gate`, async () => {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f, true);
      const facts = seedApprovalFacts(f, seeded.workflowId, { statisticsMethod: method, distinctRevalidation: true, twoWorkloads: true });
      const api = new ApiClient(f.url, { token: f.token });
      const expectedVersion = method === 'paired-block-bootstrap-v1' ? 3 : 4;
      for (const experimentId of [facts.first.experiment_id, facts.repeated.experiment_id]) {
        const experiment = f.store.getExperiment(experimentId)!;
        const gate = experiment.evaluation!.details!.performance_gate as { gate_version: number; statistics: { policy: { method: string }; comparison?: string } };
        assert.equal(gate.gate_version, expectedVersion);
        assert.equal(gate.statistics.policy.method, method);
        assert.equal(gate.statistics.comparison, expectedVersion === 4 ? 'IMPROVED' : undefined);
      }
      assert.equal((await api.getOptimizationReport(seeded.workflowId)).report.summary?.state, 'READY_FOR_REVIEW');
      const original = f.store.getExperiment(facts.first.experiment_id)!;
      const wrongVersion = structuredClone(original);
      (wrongVersion.evaluation!.details!.performance_gate as { gate_version: number }).gate_version = expectedVersion === 4 ? 3 : 4;
      f.store.saveExperiment(wrongVersion);
      await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId));
      f.store.saveExperiment(original);
      if (expectedVersion === 4) {
        const changed = structuredClone(original);
        (changed.evaluation!.details!.performance_gate as { statistics: { comparison: string } }).statistics.comparison = 'REGRESSED';
        f.store.saveExperiment(changed);
        await assert.rejects(api.prepareWorkflowEvidence(seeded.workflowId), /不一致/);
        f.store.saveExperiment(original);
      }
      const { snapshot } = await api.prepareWorkflowEvidence(seeded.workflowId);
      const result = recalculateFrozenEvidenceArchive(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256);
      assert.equal(result.performance_recalculation.status, 'MATCH');
      assert.equal(result.performance_recalculation.formal?.status, 'MATCH');
      assert.equal(result.performance_recalculation.revalidation?.status, 'MATCH');
      const filename = path.join(f.root, 'review.json');
      const review = exportReviewSamples(snapshot.artifact.archive_path, snapshot.artifact.archive_sha256, filename);
      const projected = JSON.parse(fs.readFileSync(filename, 'utf8'));
      assert.equal(projected.policy.method, method);
      assert.equal(projected.format, expectedVersion === 4 ? 'COREPILOT_REVIEW_SAMPLES_V2' : 'COREPILOT_REVIEW_SAMPLES_V1');
      assert.equal(projected.formal.result.comparison, expectedVersion === 4 ? 'IMPROVED' : undefined);
      const verified = verifyReviewSamples(filename, review.sha256);
      assert.equal(verified.formal.passed, true); assert.equal(verified.revalidation.passed, true);
      if (expectedVersion === 4) {
        const modified = structuredClone(projected); modified.formal.result.comparison = 'REGRESSED';
        fs.writeFileSync(filename, JSON.stringify(modified, null, 2) + '\n');
        const crypto = await import('node:crypto');
        const sha = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
        assert.throws(() => verifyReviewSamples(filename, sha));
      }
      const approval = await api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: snapshot.artifact.digest,
        reviewer: 'Fixture reviewer', authorization_reference: 'Explicit fixture approval for version compatibility' });
      assert.equal(approval.approval.candidate_commit, seeded.checkpoint.commit);
      assert.equal((await api.getOptimizationReport(seeded.workflowId)).report.summary?.state, 'READY_FOR_DELIVERY');
      assert.equal(f.modelRequests.inference, 0);
    } finally { await f.close(); }
  });
}
