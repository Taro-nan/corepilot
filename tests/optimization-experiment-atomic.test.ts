import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExperimentStatus } from '../src/contracts/optimization-domain.js';
import type { WorkflowExperimentIntent } from '../src/contracts/workflow.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { hypothesisProposal } from './hypothesis-fixture.js';

function experimentFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-experiment-atomic-'));
  const filename = path.join(root, 'state.sqlite');
  const store = new SqliteTaskStore(filename); store.init();
  const runtime = new OptimizationRuntime(store);
  const workflowId = 'workflow:experiment';
  const task = runtime.createTask({ workflowId, target: { kind: 'function', name: 'kernel', scope: {} },
    sourceBaseline: { id: 'baseline' }, performanceBaseline: null, evaluator: { id: 'fixture' }, declaredContext: { fixture: true } });
  runtime.setTaskStatus(task.task_id, 'RUNNING');
  const workflow = initialOptimizationWorkflowRecord(workflowId, { functionName: 'kernel', entryFile: null,
    configPath: path.join(root, 'config.yaml'), repositoryRoot: root, enablePerformance: false });
  workflow.optimization_task_id = task.task_id; workflow.status = 'GENERATING';
  store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(workflow));
  const hypothesis = runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId: null,
    proposal: hypothesisProposal('Preserve experiment identity'), agentIdentity: {} });
  const workspace = { repository: root, baseline_commit: 'baseline', run_id: 'fixture', editing: root, validation: root,
    editing_created: true, validation_created: true, candidate_commit: 'commit-1', candidate_tree: 'tree-1' };
  const candidate = runtime.prepareCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace,
    checkpoint: { commit: 'commit-1', tree: 'tree-1', source_archive_sha256: 'a'.repeat(64), files: [] }, hypothesis: null, agentIdentity: {} });
  store.attachOptimizationCandidate(workflowId, candidate);
  const prepare = (id: string, type: WorkflowExperimentIntent['type'] = 'FORMAL_EVALUATION', round = 1) => {
    const intent: WorkflowExperimentIntent = { schema_version: 1, experiment_id: `experiment:${id}`, candidate_id: candidate.candidate_id, type, round };
    const experiment = runtime.prepareExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type,
      experimentId: intent.experiment_id, declaredContext: { ...task.declared_context, workflow_experiment_intent: intent }, initialStatus: 'PENDING' });
    return { intent, experiment };
  };
  return { root, filename, store, runtime, workflowId, task, candidate, prepare,
    close() { store.close(); assert.ok(root.startsWith(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('formal experiment and workflow intent are atomic when the workflow write fails', () => {
  const f = experimentFixture();
  const save = f.store.saveOptimizationWorkflowJson.bind(f.store);
  try {
    const { intent, experiment } = f.prepare('first');
    const before = f.store.getOptimizationWorkflowJson(f.workflowId);
    f.store.saveOptimizationWorkflowJson = () => { throw new Error('injected workflow write failure'); };
    assert.throws(() => f.store.attachOptimizationExperiment(f.workflowId, experiment, intent), /injected workflow write failure/);
    assert.deepEqual(f.store.listExperiments(f.task.task_id), []);
    assert.equal(f.store.getOptimizationWorkflowJson(f.workflowId), before);
    f.store.saveOptimizationWorkflowJson = save;
    assert.equal(f.store.attachOptimizationExperiment(f.workflowId, experiment, intent).experiment_id, intent.experiment_id);
    const workflow = JSON.parse(f.store.getOptimizationWorkflowJson(f.workflowId)!);
    assert.equal(workflow.experiment_id, intent.experiment_id);
    assert.deepEqual(workflow.experiment_creation_intent, intent);
  } finally { f.store.saveOptimizationWorkflowJson = save; f.close(); }
});

test('two stale creation intents cannot start parallel work; replay keeps one original ID', () => {
  const f = experimentFixture();
  const other = new SqliteTaskStore(f.filename); other.init();
  try {
    const first = f.prepare('first'), competing = f.prepare('competing');
    assert.equal(f.store.attachOptimizationExperiment(f.workflowId, first.experiment, first.intent).experiment_id, first.intent.experiment_id);
    assert.equal(other.attachOptimizationExperiment(f.workflowId, first.experiment, first.intent).experiment_id, first.intent.experiment_id);
    assert.throws(() => other.attachOptimizationExperiment(f.workflowId, competing.experiment, competing.intent), /未确认终态.*experiment:first/);
    const conflicting = { ...first.intent, round: 2 };
    assert.throws(() => other.attachOptimizationExperiment(f.workflowId,
      { ...first.experiment, declared_context: { ...first.experiment.declared_context, workflow_experiment_intent: conflicting } }, conflicting), /原实验.*核对/);
    assert.deepEqual(f.store.listExperiments(f.task.task_id).map(item => item.experiment_id), [first.intent.experiment_id]);
    f.store.saveExperiment({ ...first.experiment, status: 'SUCCEEDED', ended_at: new Date().toISOString() });
    const independent = f.prepare('independent', 'REVALIDATION');
    f.store.attachOptimizationExperiment(f.workflowId, independent.experiment, independent.intent);
    assert.notEqual(independent.intent.experiment_id, first.intent.experiment_id);
    assert.equal(JSON.parse(f.store.getOptimizationWorkflowJson(f.workflowId)!).revalidation_experiment_id, independent.intent.experiment_id);
    f.store.saveExperiment({ ...independent.experiment, status: 'SUCCEEDED', ended_at: new Date().toISOString() });
    const nextRound = f.prepare('next-round', 'FORMAL_EVALUATION', 2);
    f.store.attachOptimizationExperiment(f.workflowId, nextRound.experiment, nextRound.intent);
    assert.equal(JSON.parse(f.store.getOptimizationWorkflowJson(f.workflowId)!).experiment_id, nextRound.intent.experiment_id);
  } finally { other.close(); f.close(); }
});

test('an intent-only checkpoint cannot resubmit an experiment with a saved Runner plan or observed work', () => {
  const f = experimentFixture();
  try {
    const first = f.prepare('started');
    f.store.attachOptimizationExperiment(f.workflowId, first.experiment, first.intent);
    const withPlan = { ...first.experiment, declared_context: { ...first.experiment.declared_context, runner_execution_plan: { steps: [] } } };
    f.store.saveExperiment(withPlan);
    assert.throws(() => f.store.attachOptimizationExperiment(f.workflowId, first.experiment, first.intent), /原实验.*核对/);
    assert.deepEqual(f.store.getExperiment(first.intent.experiment_id), withPlan);
    assert.equal(f.store.listExperiments(f.task.task_id).length, 1);
  } finally { f.close(); }
});

for (const status of ['PENDING', 'RUNNING', 'UNKNOWN'] as const satisfies ExperimentStatus[]) {
  test(`legacy unlinked ${status} experiment blocks a new intent without rewriting it`, () => {
    const f = experimentFixture();
    try {
      const old = f.runtime.startExperiment({ taskId: f.task.task_id, candidateId: f.candidate.candidate_id,
        type: 'FORMAL_EVALUATION', initialStatus: status === 'UNKNOWN' ? 'PENDING' : status });
      if (status === 'UNKNOWN') f.store.saveExperiment({ ...old, status });
      const before = f.store.getExperiment(old.experiment_id)!;
      const next = f.prepare('new');
      assert.throws(() => f.store.attachOptimizationExperiment(f.workflowId, next.experiment, next.intent), new RegExp(`未确认终态.*${old.experiment_id}`));
      assert.deepEqual(f.store.getExperiment(old.experiment_id), before);
      assert.equal(f.store.listExperiments(f.task.task_id).length, 1);
    } finally { f.close(); }
  });
}
