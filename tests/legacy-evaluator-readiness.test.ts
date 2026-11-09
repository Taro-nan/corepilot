import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/client/api-client.js';
import type { ProjectSetup } from '../src/contracts/project-setup.js';
import type { ValidationReview } from '../src/contracts/validation-review.js';
import { VALIDATION_PYTHON_HARNESS } from '../src/application/validation-python-harness.js';
import { packageValidationTestpack } from '../src/library-package/task-definition.js';
import { startWebFixture } from './web-fixture.js';
import { prepareReviewFixture } from './validation-review-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { seedApprovalFacts, seedLegacyApprovedEvidence } from './workflow-approval-fixture.js';
import { seedHistoricalQualification, seedLegacyDraft } from './legacy-evaluator-fixture.js';

test('an unqualified old draft can update its adapter without creating a new plan', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const draft = seedLegacyDraft(f, r);
    const preview = await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target);
    assert.match(preview.formal_execution_blocker ?? '', /当前草稿重新生成/);
    assert.doesNotMatch(preview.formal_execution_blocker ?? '', /新建测试方案/);
    const updated = f.projects.validationAssets.save(r.project, r.pkg, r.version, r.target, { ...draft, source: 'edited', expected_digest: draft.evaluator_digest,
      supporting_files: draft.supporting_files.map(file => file.path === 'support/corepilot_test.py' ? { ...file, content: VALIDATION_PYTHON_HARNESS } : file) });
    assert.equal(updated.qualification, 'DRAFT');
    assert.equal((await f.projects.validationReview.preview(r.project, r.pkg, r.version, r.target)).formal_execution_blocker, undefined);
  } finally { await r.close(); await f.close(); }
});

test('a historical qualified adapter is explained and blocked before a new verified task, while history and source-only remain available', async () => {
  const f = await startWebFixture();
  // An unrelated old candidate approval must stay readable and idempotent.
  const seeded = await seedBlockedValidation(f, true);
  const facts = seedApprovalFacts(f, seeded.workflowId, { statisticalGate: false });
  const historical = seedLegacyApprovedEvidence(f, seeded.workflowId, facts);
  const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const seededPlan = seedHistoricalQualification(f, r, true);
    const beforeQualification = fs.readFileSync(seededPlan.qualificationPath);
    const beforePackage = fs.readFileSync(seededPlan.packagePath);
    const api = new ApiClient(f.url, { token: f.token });
    const review = await api.projectAction(r.project.project_id, r.endpoint) as ValidationReview;
    assert.equal(review.state, 'QUALIFIED');
    assert.equal(review.approval?.reviewer, 'Historical fixture reviewer');
    assert.match(review.formal_execution_blocker ?? '', /旧版生成适配器.*新建测试方案.*旧条件不会自动复制/);
    const setup = await api.projectAction(r.project.project_id, 'setup') as ProjectSetup;
    assert.equal(setup.validation?.evaluator_status, 'QUALIFIED');
    assert.equal(setup.validation?.formal_execution_blocker, review.formal_execution_blocker);
    assert.equal(setup.checks.find(check => check.id === 'evaluator')?.state, 'NEEDS_REVIEW');
    assert.ok(setup.next_steps.some(message => message.includes('旧版生成适配器')));
    await assert.rejects(api.projectAction(r.project.project_id, 'check', { function_name: 'kernel' }), /旧版生成适配器.*新建测试方案/);
    const count = f.service.list().length;
    await assert.rejects(api.submitOptimizationWorkflow({ project_id: r.project.project_id, function_name: 'kernel',
      verification_mode: 'verified', enable_performance: true }), /旧版生成适配器.*新建测试方案/);
    assert.equal(f.service.list().length, count, 'no workflow is persisted for the blocked request');
    assert.equal(f.modelRequests.inference, 0, 'no optimization Agent is started');
    const source = await api.submitOptimizationWorkflow({ project_id: r.project.project_id, function_name: 'kernel',
      verification_mode: 'source_only', enable_performance: false, candidate_scope: { include: ['kernel.c'], exclude: [] } }) as { workflow_id: string };
    assert.equal(f.service.get(source.workflow_id)?.verification_mode, 'source_only');
    const old = await api.approveWorkflowEvidence(seeded.workflowId, { expected_evidence_digest: historical.artifact.digest,
      reviewer: 'Fixture Reviewer', authorization_reference: 'legacy fixture' });
    assert.equal(old.approval.approval_id, historical.approval.approval_id);
    assert.deepEqual(fs.readFileSync(seededPlan.qualificationPath), beforeQualification);
    assert.deepEqual(fs.readFileSync(seededPlan.packagePath), beforePackage);
  } finally { await r.close(); await f.close(); }
});

test('a regular qualified plan remains eligible; a testpack pointing to an old adapter is checked too', async () => {
  const f = await startWebFixture(); const r = await prepareReviewFixture(f).catch(async error => { await f.close(); throw error; });
  try {
    const current = seedHistoricalQualification(f, r, false);
    const api = new ApiClient(f.url, { token: f.token });
    const review = await api.projectAction(r.project.project_id, r.endpoint) as ValidationReview;
    assert.equal(review.state, 'QUALIFIED');
    assert.equal(review.formal_execution_blocker, undefined);
    const ready = await api.projectAction(r.project.project_id, 'setup') as ProjectSetup;
    assert.equal(ready.checks.find(check => check.id === 'evaluator')?.state, 'CONFIGURED');
    assert.equal((await api.projectAction(r.project.project_id, 'check', { function_name: 'kernel' }) as { function_name: string }).function_name, 'kernel');
    const created = await api.submitOptimizationWorkflow({ project_id: r.project.project_id, function_name: 'kernel',
      verification_mode: 'verified', enable_performance: true }) as { workflow_id: string };
    assert.equal(f.service.get(created.workflow_id)?.function_name, 'kernel');
    assert.equal(f.modelRequests.inference, 0);

    // A separate synthetic historical asset checks the non-Package path.
    const other = await prepareReviewFixture(f);
    try {
      const legacy = seedHistoricalQualification(f, other, true);
      const baseline = f.projects.config(other.project.project_id).validation.baseline_artifact!;
      const testpack = packageValidationTestpack(legacy.resolved, baseline).testpack;
      testpack.performance.key_cases = [testpack.performance.cases[0].case_id];
      const filename = path.join(f.root, 'legacy-evaluator-testpack.json');
      fs.writeFileSync(filename, JSON.stringify(testpack));
      f.projects.saveConfig(other.project.project_id, { ...f.projects.config(other.project.project_id), build: legacy.resolved.build, validation: { testpack: filename } });
      const setup = await api.projectAction(other.project.project_id, 'setup') as ProjectSetup;
      assert.match(setup.validation?.formal_execution_blocker ?? '', /旧版生成适配器/, JSON.stringify(setup));
      await assert.rejects(api.submitOptimizationWorkflow({ project_id: other.project.project_id, function_name: 'kernel',
        verification_mode: 'verified' }), /旧版生成适配器/);
      f.projects.saveConfig(other.project.project_id, { ...f.projects.config(other.project.project_id), runner: { mode: 'legacy' } });
      await assert.rejects(api.submitOptimizationWorkflow({ project_id: other.project.project_id, function_name: 'kernel',
        verification_mode: 'verified' }), /旧版生成适配器/);
    } finally { await other.close(); }
    assert.equal(current.resolved.bundle.qualification.status, 'QUALIFIED');
  } finally { await r.close(); await f.close(); }
});
