import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';
import type { CommandRunResult, PerformanceGateResult, ValidationCycleResult } from '../src/workspace/validation-runner.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-terminal-facts-'));
  const store = new SqliteTaskStore(path.join(root, 'state.sqlite')); store.init();
  const runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({ workflowId: 'workflow:terminal', target: { kind: 'kernel', name: 'fixture', scope: {} },
    sourceBaseline: { id: 'baseline' }, performanceBaseline: null, evaluator: { id: 'evaluator' }, declaredContext: {} });
  const hypothesis = proposeFixtureHypothesis(runtime, task.task_id, 'retain Runner terminal facts');
  const workspace = { repository: root, baseline_commit: 'base', run_id: 'run', editing: root, validation: root,
    editing_created: true, validation_created: true, candidate_commit: 'commit', candidate_tree: 'tree' };
  const candidate = runtime.recordCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace,
    checkpoint: { commit: 'commit', tree: 'tree', source_archive_sha256: 'archive', files: [] }, hypothesis: 'fixture', agentIdentity: {} });
  const experiment = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'PENDING' });
  const remote: ExperimentStatusResponse = { ...experiment, status: 'SUCCEEDED', validity: 'UNKNOWN', failure_category: null,
    observed_context: { resource_policy: { validity: 'VALID', cpu_set: '0' }, machine: { architecture: 'aarch64' } },
    started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z',
    current_step: null, cancel_requested: false, failure: null };
  return { root, store, runtime, task, experiment, remote, close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('identical Runner terminal reports replay without rewriting the saved record', () => {
  const f = fixture();
  try {
    const first = f.runtime.synchronizeRemoteExperiment(f.remote);
    assert.equal(first.runner_terminal_facts?.validity, 'UNKNOWN');
    const again = f.runtime.synchronizeRemoteExperiment({ ...f.remote, updated_at: '2026-01-01T00:00:02.000Z',
      observed_context: { machine: { architecture: 'aarch64' }, resource_policy: { cpu_set: '0', validity: 'VALID' } } });
    assert.deepEqual(again, first);
    assert.deepEqual(f.store.getExperiment(first.experiment_id), first);
    const reopened = new SqliteTaskStore(path.join(f.root, 'state.sqlite')); reopened.init();
    try { assert.deepEqual(new OptimizationRuntime(reopened).synchronizeRemoteExperiment(f.remote), first); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('replaying the Runner report preserves the independently derived revalidation result', () => {
  const f = fixture();
  try {
    f.runtime.synchronizeRemoteExperiment(f.remote);
    const command: CommandRunResult = { command: 'fixture', args: [], cwd: f.root, start_time: f.remote.started_at!,
      end_time: f.remote.ended_at!, timeout_ms: 1000, duration_ms: 1, ok: true, exit_code: 0,
      timed_out: false, cancelled: false, stdout: '', stderr: '' };
    const validation: ValidationCycleResult = { build: command, correctness: command, correctness_cases: [{ case_id: 'case',
      parameters: {}, status: 'PASSED', error: null, command }], correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true },
      formal_correctness_complete: true, performance: command, passed: true, runner_status: f.remote };
    const gate: PerformanceGateResult = { passed: false, weighted_geomean: 0.8, overall_ci_lower: 0.8, key_case_ci_lower: 0.8,
      case_ratios: { workload: 0.8 }, workloads: [{ case_id: 'workload', baseline_samples: [10], candidate_samples: [12.5],
        baseline_median: 10, candidate_median: 12.5, speedup: 0.8, critical: true, regression: true }], reason: 'fixture regression' };
    const derived = f.runtime.completeRevalidationExperiment({ experimentId: f.experiment.experiment_id,
      revalidation: { formal: validation, independent: null, performance_gate: gate, passed: false }, factsAlreadyPersisted: true });
    assert.equal(derived.validity, 'VALID');
    assert.equal(derived.failure_category, 'PERFORMANCE_REGRESSION');
    assert.equal(derived.evaluation?.performance, 'FAILED');
    const outcome = f.store.listHypothesisOutcomes(f.task.task_id);
    assert.deepEqual(f.runtime.synchronizeRemoteExperiment(f.remote), derived);
    assert.deepEqual(f.store.getExperiment(derived.experiment_id), derived);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), outcome);
  } finally { f.close(); }
});

test('changed Runner terminal facts fail without overwriting an existing result', () => {
  const f = fixture();
  try {
    const saved = f.runtime.synchronizeRemoteExperiment(f.remote);
    const conflicts: ExperimentStatusResponse[] = [
      { ...f.remote, validity: 'VALID' },
      { ...f.remote, failure_category: 'PERFORMANCE_REGRESSION' },
      { ...f.remote, failure: { code: 'EXECUTION_ERROR', message: 'changed', step: null, command_execution_id: null } },
      { ...f.remote, observed_context: { resource_policy: { validity: 'VALID', cpu_set: '1' } } },
      { ...f.remote, started_at: '2026-01-01T00:00:02.000Z' },
      { ...f.remote, ended_at: '2026-01-01T00:00:02.000Z' },
    ];
    for (const conflict of conflicts) {
      assert.throws(() => f.runtime.synchronizeRemoteExperiment(conflict), /conflicting Runner terminal facts/);
      assert.deepEqual(f.store.getExperiment(saved.experiment_id), saved);
    }
  } finally { f.close(); }
});

test('historical terminal records retain derived fields without inventing a Runner snapshot', () => {
  const f = fixture();
  try {
    const historical = { ...f.experiment, status: 'SUCCEEDED' as const, validity: 'VALID' as const,
      failure_category: 'PERFORMANCE_REGRESSION' as const, evaluation: { build: 'PASSED' as const, correctness: 'PASSED' as const, performance: 'FAILED' as const },
      started_at: f.remote.started_at, ended_at: f.remote.ended_at, observed_context: f.remote.observed_context };
    f.store.saveExperiment(historical);
    assert.deepEqual(f.runtime.synchronizeRemoteExperiment(f.remote), historical);
    assert.deepEqual(f.runtime.synchronizeRemoteExperiment({ ...f.remote, observed_context: null }), historical);
    assert.equal(f.store.getExperiment(historical.experiment_id)?.runner_terminal_facts, undefined);
    assert.throws(() => f.runtime.synchronizeRemoteExperiment({ ...f.remote, ended_at: '2026-02-01T00:00:00.000Z' }), /conflicting historical Runner ended_at/);
    assert.deepEqual(f.store.getExperiment(historical.experiment_id), historical);
  } finally { f.close(); }
});
