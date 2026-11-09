import test from 'node:test';
import assert from 'node:assert/strict';
import { customerSummary } from '../src/report/customer-summary.js';
import type { OptimizationReport } from '../src/contracts/optimization-report.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';

function report(): OptimizationReport {
  const workflow = initialOptimizationWorkflowRecord('workflow:customer', { functionName: 'kernel', entryFile: null, configPath: '/fixture', repositoryRoot: '/source', enablePerformance: true });
  workflow.candidate_id = 'candidate:current'; workflow.optimization_task_id = 'task:current'; workflow.status = 'WAITING_APPROVAL';
  workflow.candidate_commit = 'frozen'; workflow.candidate_tree = 'tree'; workflow.baseline_commit = 'base-source';
  const fact = (id: string, type: string, ratio: number) => ({ experiment: {
    experiment_id: id, type, task_id: workflow.optimization_task_id, candidate_id: workflow.candidate_id, status: 'SUCCEEDED', validity: 'VALID', evaluator: { id: 'e', version: '1', digest: 'e'.repeat(64) },
    failure_category: null, baseline: { id: 'baseline', digest: 'b'.repeat(64) }, observed_context: { machine: { machine_identity_sha256: 'a'.repeat(64) }, runner_queue: { wait_ms: 100 }, resource_policy: { validity: 'VALID' } },
    evaluation: { build: 'PASSED', correctness: 'PASSED', performance: 'PASSED', correctness_coverage: { planned: 4, executed: 4, passed: 4, failed: 0, complete: true },
      details: { performance_gate: { weighted_geomean: ratio } }, performance_workloads: [{ workload_id: 'large-t1', speedup: ratio, regression: false }] },
  }, commands: [], measurements: [] });
  return { schema_version: 1, generated_at: '', workflow, task: { task_id: workflow.optimization_task_id, workflow_id: workflow.workflow_id,
    evaluator: { id: 'e', version: '1', digest: 'e'.repeat(64) }, source_baseline: { id: 'source', digest: 'base-source' }, performance_baseline: { id: 'baseline', digest: 'b'.repeat(64) }, declared_context: { correctness_scope: {
    cases: [{ case_id: 'boundary-t1', execution: { input_id: 'boundary' } }, { case_id: 'boundary-t4', execution: { input_id: 'boundary' } },
      { case_id: 'wide-t1', execution: { input_id: 'wide' } }, { case_id: 'wide-t4', execution: { input_id: 'wide' } }] },
    workload_inventory: [{ workload_id: 'large-t1', threads: 1, parameters: { n: 4096 }, weight: 1, execution: { profile_id: 'numa0' } }] } },
    candidates: [{ candidate: { candidate_id: workflow.candidate_id, task_id: workflow.optimization_task_id, source: { commit: 'frozen', tree: 'tree' } }, approval: null }],
    experiments: [fact('formal', 'FORMAL_EVALUATION', 2), fact('revalidation', 'REVALIDATION', 1.8)], hypotheses: [], outcomes: [], notices: [],
  } as unknown as OptimizationReport;
}

test('customer report separates logical coverage, execution matrix, first run, revalidation and descriptive groups', () => {
  const result = customerSummary(report());
  assert.equal(result.state, 'READY_FOR_REVIEW'); assert.equal(result.logical_inputs, 2); assert.equal(result.correctness_executions, 4);
  assert.equal(result.verification.ready, true);
  assert.equal(result.formal_speedup, 2); assert.equal(result.revalidation_speedup, 1.8); assert.equal(result.overall_interval, null);
  assert.equal(result.groups.find(row => row.dimension === 'n')?.weighted_speedup, 2);
  assert.equal(result.resource_wait_ms, 200);
  assert.ok(result.limits.some(row => row.includes('点估计')));
});

test('missing, invalid, incomplete or mismatched independent evidence cannot recommend delivery', () => {
  for (const mutate of [
    (r: OptimizationReport) => { r.experiments.pop(); },
    (r: OptimizationReport) => { r.experiments[1].experiment.validity = 'INVALID'; },
    (r: OptimizationReport) => { r.experiments[1].experiment.evaluation!.correctness_coverage!.complete = false; },
    (r: OptimizationReport) => { r.experiments[1].experiment.evaluation!.correctness_coverage!.executed = 3; },
    (r: OptimizationReport) => { r.experiments[1].experiment.evaluator.digest = 'other'; },
    (r: OptimizationReport) => { r.experiments[1].experiment.baseline.digest = 'other'; },
    (r: OptimizationReport) => { r.experiments[1].experiment.evaluation!.build = 'FAILED'; },
    (r: OptimizationReport) => { r.experiments[1].experiment.observed_context!.resource_policy = { validity: 'NOT_ENFORCED' }; },
    (r: OptimizationReport) => { r.experiments[1].experiment.observed_context = { machine: { machine_identity_sha256: 'other' } }; },
    (r: OptimizationReport) => { r.workflow.candidate_tree = 'different-tree'; },
    (r: OptimizationReport) => { r.task!.evaluator.digest = 'different-evaluator'; },
    (r: OptimizationReport) => { r.task!.performance_baseline!.digest = 'different-baseline'; },
  ]) {
    const r = report(); mutate(r);
    const summary = customerSummary(r);
    assert.equal(summary.state, 'NO_VERIFIED_RESULT');
    assert.equal(summary.verification.ready, false);
    assert.ok(summary.verification.issues.length > 0);
  }
});

test('latest failed independent run overrides a previous pass while preserving approval and delivery facts', () => {
  const r = report(); r.workflow.status = 'DELIVERABLE';
  r.workflow.delivery = { commit: 'delivery', tree: 'tree', candidate_id: 'candidate:current', commit_message: 'human delivery', approved_at: '2026-10-30T00:00:00Z' };
  assert.equal(customerSummary(r).state, 'DELIVERED');
  const failed = structuredClone(r.experiments[1]); failed.experiment.experiment_id = 'new-failed'; failed.experiment.status = 'FAILED';
  r.experiments.push(failed);
  assert.equal(customerSummary(r).state, 'NO_VERIFIED_RESULT');
  assert.equal(r.workflow.delivery.commit, 'delivery'); assert.equal(r.experiments.length, 3);
});

test('legacy delivery without a matching identity asks for reconciliation instead of another approval or merge', () => {
  const r = report(); r.workflow.status = 'DELIVERABLE';
  for (const delivery of [undefined, { commit: 'other', tree: 'other-tree', candidate_id: 'candidate:other', commit_message: 'previous delivery', approved_at: '2026-10-30T00:00:00Z' }]) {
    r.workflow.delivery = delivery;
    const result = customerSummary(r);
    assert.equal(result.state, 'DELIVERY_UNVERIFIED');
    assert.equal(result.next_step.kind, 'INSPECT');
    assert.match(result.next_step.message, /不应再次批准或重复合并/);
    assert.equal(r.workflow.status, 'DELIVERABLE');
  }
});
