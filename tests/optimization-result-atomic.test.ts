import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { ExperimentType } from '../src/contracts/optimization-domain.js';
import type { HypothesisOutcome } from '../src/contracts/optimization-hypothesis.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { CommandRunResult, ValidationCycleResult } from '../src/workspace/validation-runner.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';

function fixture(type: ExperimentType) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-result-atomic-'));
  const store = new SqliteTaskStore(path.join(root, 'state.sqlite')); store.init();
  const runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({ workflowId: 'workflow:result', target: { kind: 'kernel', name: 'fixture', scope: {} },
    sourceBaseline: { id: 'baseline' }, performanceBaseline: null, evaluator: { id: 'evaluator' }, declaredContext: {} });
  const hypothesis = proposeFixtureHypothesis(runtime, task.task_id, 'preserve result and outcome');
  const workspace = { repository: root, baseline_commit: 'base', run_id: 'run', editing: root, validation: root,
    editing_created: true, validation_created: true, candidate_commit: 'commit', candidate_tree: 'tree' };
  const candidate = runtime.recordCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace,
    checkpoint: { commit: 'commit', tree: 'tree', source_archive_sha256: 'archive', files: [] }, hypothesis: 'fixture', agentIdentity: {} });
  const experiment = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type, initialStatus: 'PENDING' });
  const time = '2026-01-01T00:00:00.000Z';
  const command: CommandRunResult = { command: 'fixture', args: [], cwd: root, start_time: time, end_time: time,
    timeout_ms: 1000, duration_ms: 1, ok: true, exit_code: 0, timed_out: false, cancelled: false, stdout: '', stderr: '' };
  const remote = { ...experiment, status: 'SUCCEEDED' as const, validity: 'UNKNOWN' as const, failure_category: null,
    started_at: time, ended_at: time, updated_at: time, current_step: null, cancel_requested: false, failure: null };
  const validation: ValidationCycleResult = { build: command, correctness: command, correctness_cases: [{ case_id: 'case',
    parameters: {}, status: 'PASSED', error: null, command }], correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true },
    formal_correctness_complete: true, performance: null, passed: true, runner_status: remote };
  return { root, store, runtime, task, hypothesis, experiment, remote, validation,
    close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function injectOutcomeWriteFailure(store: SqliteTaskStore) {
  const writable = store as unknown as { appendHypothesisOutcome(outcome: HypothesisOutcome): void };
  const original = writable.appendHypothesisOutcome;
  writable.appendHypothesisOutcome = function (outcome) {
    original.call(store, outcome);
    throw new Error('injected failure after outcome and hypothesis writes');
  };
  return () => { writable.appendHypothesisOutcome = original; };
}

for (const type of ['FORMAL_EVALUATION', 'REVALIDATION'] as const) {
  test(`${type} commits experiment, outcome and hypothesis together and rejects changed replay`, () => {
    const f = fixture(type);
    try {
      f.runtime.synchronizeRemoteExperiment(f.remote);
      const before = f.store.getExperiment(f.experiment.experiment_id)!;
      const hypothesisBefore = f.store.getHypothesis(f.hypothesis.hypothesis_id);
      const complete = (validation = f.validation) => type === 'FORMAL_EVALUATION'
        ? f.runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id, validation, performance: null, factsAlreadyPersisted: true })
        : f.runtime.completeRevalidationExperiment({ experimentId: f.experiment.experiment_id,
          revalidation: { formal: validation, independent: null, performance_gate: null, passed: validation.passed }, factsAlreadyPersisted: true });
      const restore = injectOutcomeWriteFailure(f.store);
      try { assert.throws(() => complete(), /injected failure/); } finally { restore(); }
      assert.deepEqual(f.store.getExperiment(before.experiment_id), before);
      assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisBefore);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
      const committed = complete();
      const outcomes = f.store.listHypothesisOutcomes(f.task.task_id);
      const hypothesisAfter = f.store.getHypothesis(f.hypothesis.hypothesis_id);
      assert.equal(outcomes.length, 1);
      assert.deepEqual(complete(), committed);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), outcomes);
      assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisAfter);
      assert.throws(() => f.store.commitExperimentResult(committed, committed, { ...outcomes[0], reason: 'conflicting outcome' }),
        /已记录的实验评价或假设结果不一致/);
      assert.deepEqual(f.store.getExperiment(committed.experiment_id), committed);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), outcomes);
      const changed: ValidationCycleResult = { ...f.validation, passed: false, correctness_cases: [{ ...f.validation.correctness_cases[0], status: 'FAILED' }],
        correctness_coverage: { planned: 1, executed: 1, passed: 0, failed: 1, complete: true } };
      assert.throws(() => complete(changed), /已记录的实验评价或假设结果不一致/);
      assert.deepEqual(f.store.getExperiment(committed.experiment_id), committed);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), outcomes);
      assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisAfter);
    } finally { f.close(); }
  });
}

for (const type of ['FORMAL_EVALUATION', 'REVALIDATION'] as const) {
  test(`${type} local facts roll back with the result and can be saved once from the captured output`, () => {
    const f = fixture(type);
    const append = f.store.appendMeasurement.bind(f.store);
    try {
      const { runner_status: _remote, ...validation } = f.validation;
      const complete = () => type === 'FORMAL_EVALUATION'
        ? f.runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id, validation, performance: null })
        : f.runtime.completeRevalidationExperiment({ experimentId: f.experiment.experiment_id,
          revalidation: { formal: validation, independent: validation, performance_gate: null, passed: true } });
      const before = f.store.getExperiment(f.experiment.experiment_id);
      const hypothesisBefore = f.store.getHypothesis(f.hypothesis.hypothesis_id);
      f.store.appendMeasurement = measurement => { append(measurement); throw new Error('injected local measurement write failure'); };
      assert.throws(complete, /injected local measurement write failure/);
      assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), before);
      assert.deepEqual(f.store.listCommandExecutions(f.experiment.experiment_id), []);
      assert.deepEqual(f.store.listMeasurements(f.experiment.experiment_id), []);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
      assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisBefore);
      f.store.appendMeasurement = append;
      const restoreOutcome = injectOutcomeWriteFailure(f.store);
      try { assert.throws(complete, /injected failure after outcome/); } finally { restoreOutcome(); }
      assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), before);
      assert.deepEqual(f.store.listCommandExecutions(f.experiment.experiment_id), []);
      assert.deepEqual(f.store.listMeasurements(f.experiment.experiment_id), []);
      assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
      assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisBefore);
      const result = complete();
      const commands = f.store.listCommandExecutions(result.experiment_id);
      const measurements = f.store.listMeasurements(result.experiment_id);
      assert.equal(commands.length, type === 'FORMAL_EVALUATION' ? 2 : 4);
      assert.equal(measurements.length, type === 'FORMAL_EVALUATION' ? 1 : 2);
      assert.deepEqual(commands.map(command => command.sequence), commands.map((_, index) => index));
      assert.equal(f.store.listHypothesisOutcomes(f.task.task_id).length, 1);
    } finally { f.store.appendMeasurement = append; f.close(); }
  });
}

test('pre-existing ambiguous local facts are preserved and block automatic result creation', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    const command: import('../src/contracts/optimization-domain.js').CommandExecution = { schema_version: 1,
      command_execution_id: 'command:historical-partial', experiment_id: f.experiment.experiment_id, evaluator: { id: 'evaluator' },
      step: 'BUILD', sequence: 0, command: 'fixture', args: [], cwd: f.root, start_time: f.remote.started_at!, end_time: f.remote.ended_at!,
      duration_ms: 1, exit_code: 0, stdout: 'original', stderr: '', timeout_ms: 1000, timed_out: false, cancelled: false };
    f.store.appendCommandExecution(command);
    const before = f.store.getExperiment(f.experiment.experiment_id);
    const { runner_status: _remote, ...validation } = f.validation;
    assert.throws(() => f.runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id, validation, performance: null }), /已有命令或测量记录/);
    assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), before);
    assert.deepEqual(f.store.listCommandExecutions(f.experiment.experiment_id), [command]);
    assert.deepEqual(f.store.listMeasurements(f.experiment.experiment_id), []);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
  } finally { f.close(); }
});

test('a historical measurement without a command is not overwritten or duplicated', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    const measurement: import('../src/contracts/optimization-domain.js').Measurement = { schema_version: 1,
      measurement_id: 'measurement:historical-partial', experiment_id: f.experiment.experiment_id, evaluator: { id: 'evaluator' },
      kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'case', sample_index: null, value: true, unit: null,
      validity: 'VALID', domain_payload: { parameters: {} }, recorded_at: f.remote.updated_at };
    f.store.appendMeasurement(measurement);
    const before = f.store.getExperiment(f.experiment.experiment_id);
    const { runner_status: _remote, ...validation } = f.validation;
    assert.throws(() => f.runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id, validation, performance: null }), /已有命令或测量记录/);
    assert.deepEqual(f.store.getExperiment(f.experiment.experiment_id), before);
    assert.deepEqual(f.store.listCommandExecutions(f.experiment.experiment_id), []);
    assert.deepEqual(f.store.listMeasurements(f.experiment.experiment_id), [measurement]);
  } finally { f.close(); }
});

test('confirmed failure commits with its outcome; unknown state never invents one', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    const before = f.store.getExperiment(f.experiment.experiment_id)!;
    const hypothesisBefore = f.store.getHypothesis(f.hypothesis.hypothesis_id);
    const restore = injectOutcomeWriteFailure(f.store);
    try { assert.throws(() => f.runtime.failExperiment({ experimentId: before.experiment_id, error: 'fixture failure', cancelled: false }), /injected failure/); }
    finally { restore(); }
    assert.deepEqual(f.store.getExperiment(before.experiment_id), before);
    assert.deepEqual(f.store.getHypothesis(f.hypothesis.hypothesis_id), hypothesisBefore);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
    const failed = f.runtime.failExperiment({ experimentId: before.experiment_id, error: 'fixture failure', cancelled: false });
    assert.equal(failed.status, 'FAILED');
    const outcomes = f.store.listHypothesisOutcomes(f.task.task_id);
    assert.equal(outcomes.length, 1);
    assert.deepEqual(f.runtime.failExperiment({ experimentId: before.experiment_id, error: 'fixture failure', cancelled: false }), failed);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), outcomes);
    const pending = f.runtime.startExperiment({ taskId: f.task.task_id, candidateId: f.experiment.candidate_id,
      type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' });
    const unknown = f.runtime.failExperiment({ experimentId: pending.experiment_id, error: 'fixture unconfirmed', cancelled: true, remoteStateUnknown: true });
    assert.equal(unknown.status, 'UNKNOWN');
    assert.equal(unknown.ended_at, null);
    assert.equal(f.store.listHypothesisOutcomes(f.task.task_id).length, 1);
    assert.throws(() => f.runtime.completeValidationExperiment({ experimentId: pending.experiment_id, validation: f.validation,
      performance: null, factsAlreadyPersisted: true }), /终态尚未确认/);
    assert.deepEqual(f.store.getExperiment(pending.experiment_id), unknown);
  } finally { f.close(); }
});

test('a historical evaluation is not overwritten even when its outcome is missing', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    const terminal = f.runtime.synchronizeRemoteExperiment(f.remote);
    const historical = { ...terminal, validity: 'INVALID' as const, failure_category: 'INVALID_EXPERIMENT' as const,
      evaluation: { build: 'PASSED' as const, correctness: 'INCOMPLETE' as const, performance: 'NOT_EXECUTED' as const } };
    f.store.saveExperiment(historical);
    assert.throws(() => f.runtime.completeValidationExperiment({ experimentId: historical.experiment_id,
      validation: f.validation, performance: null, factsAlreadyPersisted: true }), /已记录的实验评价或假设结果不一致/);
    assert.deepEqual(f.store.getExperiment(historical.experiment_id), historical);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
  } finally { f.close(); }
});

test('a stale result cannot overwrite a newer experiment record from another connection', () => {
  const f = fixture('FORMAL_EVALUATION');
  const other = new SqliteTaskStore(path.join(f.root, 'state.sqlite')); other.init();
  try {
    const expected = f.runtime.synchronizeRemoteExperiment(f.remote);
    const newer = { ...expected, last_control_diagnostic: { code: 'REMOTE_STATE_UNKNOWN' as const, message: 'preserved' } };
    other.saveExperiment(newer);
    assert.throws(() => f.store.commitExperimentResult(expected, { ...expected, validity: 'VALID' }, null), /实验状态已改变/);
    assert.deepEqual(f.store.getExperiment(expected.experiment_id), newer);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
  } finally { other.close(); f.close(); }
});

test('a historical candidate without a hypothesis keeps its original result and timestamp on replay', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    const db = new DatabaseSync(path.join(f.root, 'state.sqlite'));
    try {
      const candidate = f.store.getCandidate(f.experiment.candidate_id)!;
      const historical: Partial<typeof candidate> = { ...candidate };
      delete historical.hypothesis_id;
      db.prepare('UPDATE optimization_candidates SET record_json = ? WHERE candidate_id = ?')
        .run(JSON.stringify(historical), candidate.candidate_id);
    } finally { db.close(); }
    f.runtime.synchronizeRemoteExperiment(f.remote);
    let now = '2026-01-02T00:00:00.000Z';
    const runtime = new OptimizationRuntime(f.store, { now: () => new Date(now) });
    const complete = () => runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id,
      validation: f.validation, performance: null, factsAlreadyPersisted: true });
    const first = complete();
    assert.equal(first.evaluation?.correctness, 'PASSED');
    assert.equal(first.updated_at, now);
    now = '2026-01-03T00:00:00.000Z';
    assert.deepEqual(complete(), first);
    assert.deepEqual(f.store.getExperiment(first.experiment_id), first);
    assert.deepEqual(f.store.listHypothesisOutcomes(f.task.task_id), []);
  } finally { f.close(); }
});

test('a matching historical result can recover a missing outcome without rewriting the experiment', () => {
  const f = fixture('FORMAL_EVALUATION');
  try {
    f.runtime.synchronizeRemoteExperiment(f.remote);
    let now = '2026-01-02T00:00:00.000Z';
    const runtime = new OptimizationRuntime(f.store, { now: () => new Date(now) });
    const complete = () => runtime.completeValidationExperiment({ experimentId: f.experiment.experiment_id,
      validation: f.validation, performance: null, factsAlreadyPersisted: true });
    const first = complete();
    const db = new DatabaseSync(path.join(f.root, 'state.sqlite'));
    try { db.prepare('DELETE FROM optimization_hypothesis_outcomes WHERE experiment_id = ?').run(first.experiment_id); }
    finally { db.close(); }
    now = '2026-01-03T00:00:00.000Z';
    assert.deepEqual(complete(), first);
    assert.deepEqual(f.store.getExperiment(first.experiment_id), first);
    assert.equal(f.store.listHypothesisOutcomes(f.task.task_id).length, 1);
  } finally { f.close(); }
});
