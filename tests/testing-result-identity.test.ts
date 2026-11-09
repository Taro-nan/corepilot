import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeTestingTask } from '../src/application/testing-results.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import type { Measurement } from '../src/contracts/optimization-domain.js';
import type { TestingTaskRecord } from '../src/contracts/testing.js';

const task = { task_id: 'testing:fixture', input: { mode: 'both' }, subjects: {
  candidate: { artifact_path: '/fixture/CANDIDATE.so' }, baseline: { artifact_path: '/fixture/BASELINE.so' } }, plan: { function_name: 'kernel',
  cases: [{ case_id: 'case' }], workloads: [{ workload_id: 'load', parameters: {}, threads: 1, critical: true, weight: 1 }],
  test_plan: { sampling: { sample_count: 9, warmup_count: 0 }, statistics: DEFAULT_STATISTICS, seed: 1 } } } as unknown as TestingTaskRecord;

function observation(kind: 'CORRECTNESS_CASE' | 'PERFORMANCE_SAMPLE', role: 'EVALUATOR' | 'BASELINE' | 'CANDIDATE', index: number | null): Measurement {
  const input = `/fixture/${role === 'EVALUATOR' ? 'CANDIDATE' : role}.so`, fileId = { device: '1', inode: role === 'BASELINE' ? '1' : '2' };
  return { schema_version: 1, measurement_id: `${kind}-${role}-${index}`, experiment_id: task.task_id, kind, role,
    subject_id: kind === 'CORRECTNESS_CASE' ? 'case' : 'load', sample_index: index, value: kind === 'CORRECTNESS_CASE' ? 'PASS' : role === 'BASELINE' ? 2 : 1,
    unit: kind === 'CORRECTNESS_CASE' ? null : 'seconds', validity: 'VALID', evaluator: null, recorded_at: '2026-11-09T00:00:00Z',
    domain_payload: { artifact_identity: { input_path: input, resolved_symbol_path: input, sha256: 'a'.repeat(64) },
      runner_artifact_path_check: { planned_path: input, input_realpath: input, input_file_id: fileId,
        reported_paths: [{ field: 'input_path', path: input, realpath: input, file_id: fileId },
          { field: 'resolved_symbol_path', path: input, realpath: input, file_id: fileId }] } } };
}

test('independent testing does not claim a pass or improvement for historical unchecked identities', () => {
  const rows = [observation('CORRECTNESS_CASE', 'EVALUATOR', null),
    ...Array.from({ length: 9 }, (_, index) => [observation('PERFORMANCE_SAMPLE', 'BASELINE', index), observation('PERFORMANCE_SAMPLE', 'CANDIDATE', index)]).flat()];
  const current = summarizeTestingTask(task, rows);
  assert.equal(current.correctness.status, 'PASSED');
  assert.equal(current.performance.status, 'IMPROVED');
  assert.equal(current.performance.speedup, 2);
  const historical = structuredClone(rows);
  for (const row of historical) delete row.domain_payload.runner_artifact_path_check;
  const before = structuredClone(historical);
  const result = summarizeTestingTask(task, historical);
  assert.equal(result.correctness.status, 'UNVERIFIED');
  assert.equal(result.correctness.passed, 1, 'the recorded evaluator result remains visible');
  assert.equal(result.performance.status, 'UNVERIFIED');
  assert.equal(result.performance.speedup, null);
  assert.equal(result.comparisons[0].conclusion, 'UNVERIFIED');
  assert.equal(result.comparisons[0].baseline_samples.length, 9);
  assert.match(result.provenance_issues?.[0] ?? '', /原始记录已保留/);
  assert.deepEqual(historical, before);
});

test('conflicting identity checks suppress conclusions even if the values themselves are valid', () => {
  const row = observation('CORRECTNESS_CASE', 'EVALUATOR', null);
  (row.domain_payload.artifact_identity as { resolved_symbol_path: string }).resolved_symbol_path = '/other/library.so';
  const result = summarizeTestingTask({ ...task, input: { ...task.input, mode: 'correctness' } }, [row]);
  assert.equal(result.correctness.status, 'UNVERIFIED');
  assert.equal(result.performance.status, 'NOT_REQUESTED');
  const wrongSubject = observation('CORRECTNESS_CASE', 'EVALUATOR', null);
  (wrongSubject.domain_payload.runner_artifact_path_check as { planned_path: string }).planned_path = '/other/library.so';
  assert.equal(summarizeTestingTask({ ...task, input: { ...task.input, mode: 'correctness' } }, [wrongSubject]).correctness.status, 'UNVERIFIED');
});

test('independent testing rejects fractional indices and measurements from another experiment', () => {
  const rows = [observation('CORRECTNESS_CASE', 'EVALUATOR', null),
    ...Array.from({ length: 9 }, (_, index) => [observation('PERFORMANCE_SAMPLE', 'BASELINE', index), observation('PERFORMANCE_SAMPLE', 'CANDIDATE', index)]).flat()];
  const fractional = structuredClone(rows);
  fractional.find(row => row.role === 'CANDIDATE' && row.sample_index === 1)!.sample_index = 0.5;
  const indexResult = summarizeTestingTask(task, fractional);
  assert.equal(indexResult.performance.status, 'INVALID');
  assert.equal(indexResult.performance.speedup, null);

  const foreign = structuredClone(rows);
  foreign.find(row => row.kind === 'CORRECTNESS_CASE')!.experiment_id = 'testing:another';
  foreign.find(row => row.role === 'BASELINE')!.experiment_id = 'testing:another';
  const identityResult = summarizeTestingTask(task, foreign);
  assert.equal(identityResult.correctness.status, 'INVALID');
  assert.equal(identityResult.performance.status, 'INVALID');
  assert.equal(identityResult.performance.speedup, null);
});

test('independent testing does not present non-representable numeric results with or without a statistical policy', () => {
  const count = 12;
  const configured = { ...task, input: { ...task.input, mode: 'performance' as const }, plan: { ...task.plan,
    test_plan: { ...task.plan.test_plan, sampling: { ...task.plan.test_plan.sampling, sample_count: count } } } };
  const rows = Array.from({ length: count }, (_, index) => (['BASELINE', 'CANDIDATE'] as const).map(role =>
    ({ ...observation('PERFORMANCE_SAMPLE', role, index), value: 1e308 }))).flat();
  for (const statistics of [DEFAULT_STATISTICS, undefined]) {
    const input = { ...configured, plan: { ...configured.plan, test_plan: { ...configured.plan.test_plan, statistics } } };
    const result = summarizeTestingTask(input, rows);
    assert.equal(result.performance.status, 'INVALID');
    assert.equal(result.performance.speedup, null);
    assert.ok(result.performance.issues.length);
    assert.equal(result.comparisons[0].speedup, null);
    assert.deepEqual(result.comparisons[0].baseline_samples, Array(count).fill(1e308));
  }

  const extremeTail = rows.map(row => ({ ...row, value: row.sample_index! < 7 ? 1 : row.role === 'BASELINE' ? 1e200 : 1e-200 }));
  const bootstrap = summarizeTestingTask(configured, extremeTail);
  assert.equal(bootstrap.performance.status, 'INVALID');
  assert.equal(bootstrap.performance.speedup, null);
  assert.equal(bootstrap.comparisons[0].conclusion, 'INVALID');
});
