import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { ExperimentStateChangedError } from '../src/storage/optimization-store.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-experiment-cas-'));
  const db = path.join(root, 'state.sqlite');
  const store = new SqliteTaskStore(db); store.init();
  const other = new SqliteTaskStore(db); other.init();
  const runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({ workflowId: 'workflow:cas', target: { kind: 'kernel', name: 'fixture', scope: {} },
    sourceBaseline: { id: 'baseline' }, performanceBaseline: null, evaluator: { id: 'evaluator' }, declaredContext: {} });
  const hypothesis = proposeFixtureHypothesis(runtime, task.task_id, 'preserve concurrent terminal result');
  const workspace = { repository: root, baseline_commit: 'base', run_id: 'run', editing: root, validation: root,
    editing_created: true, validation_created: true, candidate_commit: 'commit', candidate_tree: 'tree' };
  const candidate = runtime.recordCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace,
    checkpoint: { commit: 'commit', tree: 'tree', source_archive_sha256: 'archive', files: [] }, hypothesis: 'fixture', agentIdentity: {} });
  const experiment = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' });
  return { root, store, other, runtime, experiment, close() { other.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

for (const action of ['sync', 'unknown', 'plan'] as const) {
  test(`${action} rejects a stale read rather than overwriting another connection's terminal result`, () => {
    const f = fixture();
    const get = f.store.getExperiment.bind(f.store);
    try {
      const terminal = { ...f.experiment, status: 'SUCCEEDED' as const, validity: 'VALID' as const,
        ended_at: '2026-01-01T00:00:01.000Z', evaluation: { build: 'PASSED' as const, correctness: 'PASSED' as const, performance: 'NOT_EXECUTED' as const } };
      let changed = false;
      f.store.getExperiment = id => {
        const previous = get(id);
        if (!changed && id === f.experiment.experiment_id) { changed = true; f.other.saveExperiment(terminal); }
        return previous;
      };
      const remote = { ...f.experiment, status: 'RUNNING' as const, current_step: 'BUILD' as const, cancel_requested: false, failure: null };
      assert.throws(() => action === 'sync' ? f.runtime.synchronizeRemoteExperiment(remote)
        : action === 'unknown' ? f.runtime.markRemoteStateUnknown(f.experiment.experiment_id, 'fixture disconnect')
          : f.runtime.recordRemoteExecutionPlan(f.experiment.experiment_id, { steps: [] }), ExperimentStateChangedError);
      f.store.getExperiment = get;
      assert.equal(changed, true);
      assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), terminal);
    } finally { f.store.getExperiment = get; f.close(); }
  });
}

test('an already persisted Runner plan cannot be claimed for another submission', () => {
  const f = fixture();
  try {
    f.runtime.recordRemoteExecutionPlan(f.experiment.experiment_id, { steps: [] });
    const saved = f.store.getExperiment(f.experiment.experiment_id);
    assert.throws(() => f.runtime.recordRemoteExecutionPlan(f.experiment.experiment_id, { steps: [] }), ExperimentStateChangedError);
    assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), saved);
  } finally { f.close(); }
});
