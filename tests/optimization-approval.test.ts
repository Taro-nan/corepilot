import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OptimizationRuntime, type ApproveOptimizationCandidateInput } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { CommandRunResult, ValidationCycleResult, PerformanceGateResult } from '../src/workspace/validation-runner.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';

function hash(bytes: string | Buffer) { return createHash('sha256').update(bytes).digest('hex'); }

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-human-approval-'));
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite'));
  store.init();
  const runtime = new OptimizationRuntime(store, { now: () => new Date('2026-10-14T08:00:00.000Z') });
  const evaluatorRoot = path.join(root, 'evaluator');
  const evaluator = createFormalEvaluatorFixture(evaluatorRoot);
  const task = runtime.createTask({ workflowId: 'workflow:approval', target: { kind: 'function', name: 'fixture', scope: {} }, sourceBaseline: { id: 'git:baseline', digest: 'a'.repeat(40) }, performanceBaseline: { id: 'baseline:binary', version: '1', digest: 'b'.repeat(64) }, evaluator: { id: evaluator.manifest.evaluator_id, version: evaluator.manifest.version, digest: evaluator.digest }, declaredContext: {} });
  const hypothesis = runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null, proposal: { description: 'reduce repeated work', motivation: 'source evidence', evidence: [{ kind: 'SOURCE_INSPECTION', summary: 'repeated loads' }], expected_effect: 'lower latency', risk: 'boundaries', affected_scope: ['kernel.c'] }, agentIdentity: { model: 'fixture' } });
  const candidate = runtime.recordCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace: { repository: root, baseline_commit: 'base', run_id: 'fixture', editing: root, validation: root, editing_created: true, validation_created: true, candidate_commit: 'candidate', candidate_tree: 'tree' }, checkpoint: { commit: 'candidate', tree: 'tree', source_archive_sha256: 'c'.repeat(64), files: [{ path: 'kernel.c', before_sha256: 'd'.repeat(64), after_sha256: 'e'.repeat(64) }] }, hypothesis: null, agentIdentity: { model: 'fixture' } });
  const command: CommandRunResult = { command: 'fixture', args: [], cwd: root, start_time: task.created_at, end_time: task.created_at, duration_ms: 1, timeout_ms: 1000, ok: true, exit_code: 0, timed_out: false, cancelled: false, stdout: '', stderr: '' };
  const validation: ValidationCycleResult = { build: command, correctness: command, correctness_cases: [{ case_id: 'case-1', parameters: {}, status: 'PASSED', error: null, command }], correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true }, formal_correctness_complete: true, performance: command, passed: true };
  const performance: PerformanceGateResult = { passed: true, weighted_geomean: 1.2, overall_ci_lower: 1.1, key_case_ci_lower: 1.1, case_ratios: {}, workloads: [], reason: 'thresholds satisfied' };
  const observed = { machine: { machine_identity_sha256: 'f'.repeat(64) }, resource_policy: { validity: 'VALID' } };
  const first = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION' });
  runtime.completeValidationExperiment({ experimentId: first.experiment_id, validation, performance, observedContext: observed });
  const repeated = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION' });
  runtime.completeRevalidationExperiment({ experimentId: repeated.experiment_id, revalidation: { formal: validation, independent: null, performance_gate: performance, passed: true }, observedContext: observed });
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(evidenceRoot);
  const body = { record_type: 'OPTIMIZATION_EVIDENCE_FREEZE', task_id: task.task_id, workflow_id: task.workflow_id, candidate_id: candidate.candidate_id, candidate_commit: candidate.source.commit, hypothesis_id: candidate.hypothesis_id, baseline: task.performance_baseline, evaluator: task.evaluator, machine_identity_sha256: 'f'.repeat(64), first_formal_experiment_id: first.experiment_id, revalidation_experiment_id: repeated.experiment_id, acceptance_decision: { decision: 'PASS' }, claim_scope: { operation: 'fixture' } };
  function freeze(bodyOverride = body) {
    const payload = JSON.stringify(bodyOverride);
    fs.writeFileSync(path.join(evidenceRoot, 'evidence.json'), payload);
    const files = [{ relative_path: 'evidence.json', size_bytes: Buffer.byteLength(payload), sha256: hash(payload) }];
    const digest = hash(JSON.stringify(files));
    const manifestPath = path.join(evidenceRoot, 'evidence-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ digest_algorithm: 'sha256-sorted-file-inventory-json', digest, files }));
    const archivePath = path.join(evidenceRoot, 'evidence.payload');
    fs.writeFileSync(archivePath, payload);
    return { evidence_id: `evidence:${digest}`, digest, archive_path: archivePath, archive_sha256: hash(payload), manifest_path: manifestPath };
  }
  const input: ApproveOptimizationCandidateInput = { taskId: task.task_id, candidateId: candidate.candidate_id, firstFormalExperimentId: first.experiment_id, revalidationExperimentId: repeated.experiment_id, evaluatorRoot, evidence: freeze(), reviewer: 'owner:fixture', authorization: { kind: 'EXPLICIT_OWNER_DIRECTIVE', reference: 'owner explicitly approves this fixture' } };
  return { root, store, runtime, task, candidate, first, repeated, input, body, freeze, close: () => { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('Human Approval atomically approves Candidate and Evidence while preserving experiments, measurements and lineage', () => {
  const prepared = fixture();
  try {
    const candidateBefore = prepared.runtime.getCandidate(prepared.candidate.candidate_id);
    const experimentsBefore = prepared.store.listExperiments(prepared.task.task_id);
    const measurementsBefore = experimentsBefore.flatMap(item => prepared.store.listMeasurements(item.experiment_id));
    const bytesBefore = fs.readFileSync(prepared.input.evidence.archive_path);
    const record = prepared.runtime.approveCandidate(prepared.input);
    assert.equal(record.approval_status, 'APPROVED');
    assert.equal(record.evidence_status, 'APPROVED');
    assert.equal(record.approved_at, '2026-10-14T08:00:00.000Z');
    assert.deepEqual(record.candidate_before, candidateBefore);
    assert.deepEqual(prepared.runtime.getCandidate(candidateBefore.candidate_id), { ...candidateBefore, status: 'APPROVED' });
    assert.deepEqual(prepared.store.listExperiments(prepared.task.task_id), experimentsBefore);
    assert.deepEqual(experimentsBefore.flatMap(item => prepared.store.listMeasurements(item.experiment_id)), measurementsBefore);
    assert.deepEqual(fs.readFileSync(prepared.input.evidence.archive_path), bytesBefore);
    assert.deepEqual(prepared.runtime.approveCandidate(prepared.input), record);
    assert.throws(() => prepared.runtime.approveCandidate({ ...prepared.input, reviewer: 'different-owner' }), /cannot change/);
    const reopened = new SqliteTaskStore(path.join(prepared.root, 'control.sqlite'));
    reopened.init();
    try {
      assert.deepEqual(reopened.getCandidateApproval(candidateBefore.candidate_id), record);
      assert.equal(reopened.getEvidenceApproval(prepared.input.evidence.evidence_id)?.evidence_status, 'APPROVED');
      assert.equal(reopened.getCandidate(candidateBefore.candidate_id)?.status, 'APPROVED');
      assert.throws(() => reopened.recordCandidateApproval({ ...record, reviewer: 'different-owner' }), /cannot change/);
    } finally { reopened.close(); }
  } finally { prepared.close(); }
});

test('Approval rejects missing Owner authorization, reused revalidation, failed evaluation and machine drift', () => {
  for (const mode of ['authorization', 'reviewer', 'reused', 'failed', 'policy', 'resources', 'machine'] as const) {
    const prepared = fixture();
    try {
      let input = prepared.input;
      if (mode === 'authorization') input = { ...input, authorization: { kind: 'EXPLICIT_OWNER_DIRECTIVE', reference: '' } };
      if (mode === 'reviewer') input = { ...input, reviewer: '' };
      if (mode === 'reused') input = { ...input, revalidationExperimentId: input.firstFormalExperimentId };
      if (mode === 'failed') prepared.store.saveExperiment({ ...prepared.runtime.getExperiment(prepared.repeated.experiment_id), validity: 'INVALID' });
      if (mode === 'policy') prepared.store.saveExperiment({ ...prepared.runtime.getExperiment(prepared.repeated.experiment_id), evaluation: { build: 'PASSED', correctness: 'PASSED', performance: 'FAILED' } });
      if (mode === 'resources') prepared.store.saveExperiment({ ...prepared.runtime.getExperiment(prepared.repeated.experiment_id), observed_context: { machine: { machine_identity_sha256: 'f'.repeat(64) }, resource_policy: { validity: 'INVALID' } } });
      if (mode === 'machine') prepared.store.saveExperiment({ ...prepared.runtime.getExperiment(prepared.repeated.experiment_id), observed_context: { machine: { machine_identity_sha256: '0'.repeat(64) } } });
      assert.throws(() => prepared.runtime.approveCandidate(input));
      assert.equal(prepared.runtime.getCandidate(prepared.candidate.candidate_id).status, 'FROZEN');
      assert.equal(prepared.store.getCandidateApproval(prepared.candidate.candidate_id), null);
    } finally { prepared.close(); }
  }
});

test('Approval rejects modified Evidence, mismatched scope identities and evaluator qualification revocation', () => {
  for (const mode of ['archive', 'payload', 'candidate', 'baseline', 'qualification'] as const) {
    const prepared = fixture();
    try {
      let input = prepared.input;
      if (mode === 'archive') fs.appendFileSync(input.evidence.archive_path, 'tampered');
      if (mode === 'payload') fs.appendFileSync(path.join(path.dirname(input.evidence.manifest_path), 'evidence.json'), 'tampered');
      if (mode === 'candidate') input = { ...input, evidence: prepared.freeze({ ...prepared.body, candidate_id: 'candidate:other' }) };
      if (mode === 'baseline') input = { ...input, evidence: prepared.freeze({ ...prepared.body, baseline: { ...prepared.body.baseline!, digest: '0'.repeat(64) } }) };
      if (mode === 'qualification') {
        const qualificationPath = path.join(input.evaluatorRoot, 'qualification.json');
        const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
        qualification.status = 'QUALIFICATION_PENDING';
        fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
      }
      assert.throws(() => prepared.runtime.approveCandidate(input));
      assert.equal(prepared.store.getEvidenceApproval(input.evidence.evidence_id), null);
      assert.equal(prepared.runtime.getCandidate(prepared.candidate.candidate_id).status, 'FROZEN');
    } finally { prepared.close(); }
  }
});

test('Approval transaction rejects stale Candidate snapshots without partially recording approval', () => {
  const prepared = fixture();
  try {
    const record = prepared.runtime.approveCandidate(prepared.input);
    assert.throws(() => prepared.store.recordCandidateApproval({ ...record, candidate_id: 'candidate:missing', candidate_before: { ...record.candidate_before, candidate_id: 'candidate:missing' } }), /Candidate changed/);
    assert.equal(prepared.store.getCandidateApproval('candidate:missing'), null);
    assert.deepEqual(prepared.store.getEvidenceApproval(prepared.input.evidence.evidence_id), record);
  } finally { prepared.close(); }
});
