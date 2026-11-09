import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { startWebFixture } from './web-fixture.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { evaluatorContentSha256 } from '../src/evaluator/formal-evaluator.js';
import { freezeValidationTestpack } from '../src/testpack/validation-freeze.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import type { CommandRunResult, PerformanceGateResult, ValidationCycleResult } from '../src/workspace/validation-runner.js';

/** Simulated evaluator and measurements for public API/browser tests, never hardware evidence. */
export function seedApprovalFacts(f: Awaited<ReturnType<typeof startWebFixture>>, workflowId: string, options: { omitRevalidationSamples?: boolean; omitRevalidationCandidateSample?: number; extraUnobservedWorkload?: boolean } = {}) {
  const workflow = f.service.get(workflowId)!;
  const task = f.store.getOptimizationTask(workflow.optimization_task_id!)!;
  const candidate = f.store.getCandidate(workflow.candidate_id!)!;
  const root = path.join(f.root, `evaluator-${randomUUID()}`);
  createFormalEvaluatorFixture(root);
  const manifestPath = path.join(root, 'manifest.json'), qualificationPath = path.join(root, 'qualification.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.domain.api = workflow.function_name;
  if (options.extraUnobservedWorkload) {
    const workloadPath = path.join(root, 'benchmark', 'workloads.json');
    const inventory = JSON.parse(fs.readFileSync(workloadPath, 'utf8'));
    inventory.workloads.push({ ...inventory.workloads[0], workload_id: 'workload-2' });
    manifest.performance.workload_ids.push('workload-2');
    fs.writeFileSync(workloadPath, JSON.stringify(inventory));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const digest = evaluatorContentSha256(root);
  manifest.digest = digest;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8'));
  qualification.subject_digest = digest;
  fs.writeFileSync(qualificationPath, JSON.stringify(qualification));
  const testpack = JSON.parse(fs.readFileSync(path.join(f.root, 'testpack.json'), 'utf8')) as ValidationTestpack;
  testpack.evaluator = { id: manifest.evaluator_id, version: manifest.version, owner: manifest.owner, root, sha256: digest };
  const snapshotDir = path.join(f.root, `frozen-${randomUUID()}`);
  const frozen = freezeValidationTestpack(testpack, snapshotDir);
  f.store.saveOptimizationTask({ ...task, source_baseline: { ...task.source_baseline, digest: workflow.baseline_commit },
    evaluator: { id: manifest.evaluator_id, version: manifest.version, digest } });
  const runtime = new OptimizationRuntime(f.store);
  const now = new Date().toISOString();
  const command: CommandRunResult = { command: 'fixture', args: [], cwd: f.root, start_time: now, end_time: now,
    duration_ms: 1, timeout_ms: 1000, ok: true, exit_code: 0, timed_out: false, cancelled: false, stdout: '', stderr: '' };
  const validation: ValidationCycleResult = { build: command, correctness: command,
    correctness_cases: [{ case_id: 'case-1', parameters: { n: 1 }, status: 'PASSED', error: null, command }],
    correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true }, formal_correctness_complete: true,
    performance: command, passed: true };
  const performance: PerformanceGateResult = { passed: true, weighted_geomean: 2, overall_ci_lower: 1.5, key_case_ci_lower: 1.5,
    case_ratios: { 'workload-1': 2 }, workloads: [{ case_id: 'workload-1', baseline_samples: [10, 11, 9], candidate_samples: [5, 5.5, 4.5],
      baseline_median: 10, candidate_median: 5, speedup: 2, critical: true, regression: false }], reason: 'simulated acceptance' };
  const observed = { machine: { machine_identity_sha256: 'a'.repeat(64), fixture: true }, resource_policy: { validity: 'VALID', fixture: true } };
  const first = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION' });
  runtime.completeValidationExperiment({ experimentId: first.experiment_id, validation, performance, observedContext: observed });
  const repeated = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION' });
  runtime.completeRevalidationExperiment({ experimentId: repeated.experiment_id, revalidation: { formal: validation, independent: null, performance_gate: performance, passed: true }, observedContext: observed });
  if (!options.omitRevalidationSamples) for (const [role, samples] of [['BASELINE', [10, 11, 9]], ['CANDIDATE', [5, 5.5, 4.5]]] as const) for (const [index, value] of samples.entries()) {
    if (role === 'CANDIDATE' && index === options.omitRevalidationCandidateSample) continue;
    f.store.appendMeasurement({ schema_version: 1, measurement_id: `measurement:${randomUUID()}`, experiment_id: repeated.experiment_id,
      evaluator: { id: manifest.evaluator_id, version: manifest.version, digest }, kind: 'PERFORMANCE_SAMPLE', role,
      subject_id: 'workload-1', sample_index: index, value, unit: 'ns', validity: 'VALID', domain_payload: {}, recorded_at: now });
  }
  Object.assign(workflow, { status: 'WAITING_APPROVAL', enable_performance: true, testpack_digest: frozen.digest,
    testpack_snapshot_path: path.join(snapshotDir, 'validation-testpack.json'), candidate_evaluation_feedback: null, candidate_evaluation_decision: null });
  f.store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  assert.equal(f.service.report(workflowId)?.report.summary?.verification.ready, true);
  return { workflow, candidate, first, repeated, evaluatorRoot: root };
}

export async function approveFixture(f: Awaited<ReturnType<typeof startWebFixture>>, workflowId: string) {
  const { ApiClient } = await import('../src/client/api-client.js');
  const api = new ApiClient(f.url, { token: f.token });
  const { snapshot } = await api.prepareWorkflowEvidence(workflowId);
  const { approval } = await api.approveWorkflowEvidence(workflowId, { expected_evidence_digest: snapshot.artifact.digest,
    reviewer: 'fixture reviewer', authorization_reference: 'fixture owner explicitly authorizes approval' });
  return { snapshot, approval };
}
