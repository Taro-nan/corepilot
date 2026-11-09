import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

function candidateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-candidate-atomic-'));
  const filename = path.join(root, 'state.sqlite');
  const store = new SqliteTaskStore(filename); store.init();
  const runtime = new OptimizationRuntime(store);
  const workflowId = 'workflow:checkpoint';
  const task = runtime.createTask({ workflowId, target: { kind: 'function', name: 'kernel', scope: {} },
    sourceBaseline: { id: 'baseline' }, performanceBaseline: null, evaluator: { id: 'fixture' }, declaredContext: {} });
  runtime.setTaskStatus(task.task_id, 'RUNNING');
  const workflow = initialOptimizationWorkflowRecord(workflowId, { functionName: 'kernel', entryFile: null,
    configPath: path.join(root, 'config.yaml'), repositoryRoot: root, enablePerformance: false });
  workflow.optimization_task_id = task.task_id; workflow.status = 'GENERATING';
  store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  const hypothesis = runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null,
    proposal: hypothesisProposal('Preserve candidate identity'), agentIdentity: {} });
  const workspace = { repository: root, baseline_commit: 'baseline', run_id: 'fixture', editing: root, validation: root,
    editing_created: true, validation_created: true, candidate_commit: 'commit-1', candidate_tree: 'tree-1' };
  const prepare = (commit = 'commit-1', tree = 'tree-1') => runtime.prepareCandidate({ taskId: task.task_id,
    hypothesisId: hypothesis.hypothesis_id, workspace, checkpoint: { commit, tree, source_archive_sha256: 'a'.repeat(64),
      files: [{ path: 'kernel.c', before_sha256: 'b'.repeat(64), after_sha256: 'c'.repeat(64) }] }, hypothesis: null, agentIdentity: {} });
  return { root, filename, store, runtime, workflowId, task, prepare,
    close() { store.close(); assert.ok(root.startsWith(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('candidate insertion and workflow link commit together; a failed link leaves neither', () => {
  const f = candidateFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    const candidate = f.prepare();
    const old = f.store.getOptimizationWorkflowJson(f.workflowId);
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('injected workflow write failure'); };
    assert.throws(() => f.store.attachOptimizationCandidate(f.workflowId, candidate), /injected workflow write failure/);
    assert.equal(f.store.listCandidates(f.task.task_id).length, 0);
    assert.equal(f.store.getOptimizationWorkflowJson(f.workflowId), old);
    f.store.saveOptimizationWorkflowJson = save;
    assert.equal(f.store.attachOptimizationCandidate(f.workflowId, candidate).candidate_id, candidate.candidate_id);
    assert.equal(JSON.parse(f.store.getOptimizationWorkflowJson(f.workflowId)!).candidate_id, candidate.candidate_id);
  } finally { f.store.saveOptimizationWorkflowJson = save; f.close(); }
});

test('stale concurrent checkpoints cannot fork lineage; exact replay reuses only the same source identity', () => {
  const f = candidateFixture();
  const secondConnection = new SqliteTaskStore(f.filename); secondConnection.init();
  try {
    const first = f.prepare(), replay = f.prepare(), competing = f.prepare('commit-competitor', 'tree-competitor');
    assert.equal(f.store.attachOptimizationCandidate(f.workflowId, first).candidate_id, first.candidate_id);
    const reordered = { ...replay, source: { tree: replay.source.tree, commit: replay.source.commit, repository: replay.source.repository,
      changed_files: replay.source.changed_files, archive_sha256: replay.source.archive_sha256 } };
    assert.equal(secondConnection.attachOptimizationCandidate(f.workflowId, reordered).candidate_id, first.candidate_id);
    assert.equal(f.store.listCandidates(f.task.task_id).length, 1);
    assert.throws(() => secondConnection.attachOptimizationCandidate(f.workflowId, competing), /谱系|引用/);
    const conflicts = [
      { ...replay, source: { ...replay.source, tree: 'different-tree' } },
      { ...replay, source: { ...replay.source, archive_sha256: 'd'.repeat(64) } },
      { ...replay, source: { ...replay.source, changed_files: [{ ...replay.source.changed_files[0], after_sha256: 'e'.repeat(64) }] } },
      { ...replay, hypothesis_id: 'hypothesis:other' },
    ];
    for (const wrong of conflicts) assert.throws(() => secondConnection.attachOptimizationCandidate(f.workflowId, wrong), /不一致/);
    const sameTreeNewCommit = f.prepare('commit-2', 'tree-1');
    const second = f.store.attachOptimizationCandidate(f.workflowId, sameTreeNewCommit);
    assert.notEqual(second.candidate_id, first.candidate_id, 'same tree with a new commit is not collapsed');
    assert.equal(second.parent_candidate_id, first.candidate_id);
    assert.throws(() => secondConnection.attachOptimizationCandidate(f.workflowId, replay), /不一致/);
    assert.deepEqual(f.store.listCandidates(f.task.task_id).map(item => item.candidate_id), [first.candidate_id, second.candidate_id]);
  } finally { secondConnection.close(); f.close(); }
});

test('a replay cannot create another experiment when the candidate already has one', () => {
  const f = candidateFixture();
  try {
    const first = f.prepare(), replay = f.prepare();
    f.store.attachOptimizationCandidate(f.workflowId, first);
    const experiment = f.runtime.startExperiment({ taskId: f.task.task_id, candidateId: first.candidate_id,
      type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' });
    assert.throws(() => f.store.attachOptimizationCandidate(f.workflowId, replay), /已有实验/);
    assert.deepEqual(f.store.listExperiments(f.task.task_id).map(item => item.experiment_id), [experiment.experiment_id]);
    assert.equal(f.store.listCandidates(f.task.task_id).length, 1);
  } finally { f.close(); }
});
