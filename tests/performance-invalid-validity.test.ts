import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { evaluatePerformanceGate } from '../src/workspace/validation-runner.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';
import { startWebFixture } from './web-fixture.js';

for (const method of ['paired-block-bootstrap-v1', 'paired-block-bootstrap-v2'] as const) {
  test(`formal ${method} keeps execution separate from an invalid performance inventory`, async () => {
    const f = await startWebFixture();
    try {
      const seeded = await seedBlockedValidation(f, true);
      const pack = JSON.parse(fs.readFileSync(loadOptimizationConfig(f.configPath).config.validation.testpack, 'utf8'));
      pack.performance.statistics = { ...DEFAULT_STATISTICS, method };
      pack.performance.sampling.samples = 9;
      const gate = evaluatePerformanceGate(pack, [{ case_id: 'p1', baseline_samples: Array(9).fill(1), candidate_samples: [1] }]);
      assert.equal(gate.statistics?.verdict, 'INVALID');
      const validation = { ...seeded.validation, runner_status: undefined, performance: seeded.validation.build, passed: true };
      const runtime = new OptimizationRuntime(f.store);
      const experiment = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'FORMAL_EVALUATION' });
      const result = runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation, performance: gate });
      assert.equal(result.status, 'SUCCEEDED');
      assert.equal(result.validity, 'INVALID');
      assert.equal(result.evaluation?.correctness, 'PASSED');
      assert.equal(result.evaluation?.performance, 'INVALID');
      assert.equal(result.failure_category, null);
      assert.ok(f.store.listCommandExecutions(experiment.experiment_id).some(command => command.step === 'PERFORMANCE'));
      assert.equal(f.store.listHypothesisOutcomes(seeded.candidate.task_id).find(item => item.experiment_id === experiment.experiment_id)?.status, 'INCONCLUSIVE');
      assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);

      const repeat = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION' });
      const repeated = runtime.completeRevalidationExperiment({ experimentId: repeat.experiment_id,
        revalidation: { formal: validation, independent: null, performance_gate: gate, passed: false } });
      assert.equal(repeated.status, 'SUCCEEDED');
      assert.equal(repeated.validity, 'INVALID');
      assert.equal(repeated.evaluation?.performance, 'INVALID');
      assert.equal(repeated.failure_category, null);
      if (method === 'paired-block-bootstrap-v1') {
        // The former v3 revalidation code recorded this invalid gate as FAILED.
        const priorRun = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION' });
        const historical = { ...repeated, experiment_id: priorRun.experiment_id, validity: 'VALID' as const, failure_category: 'PERFORMANCE_REGRESSION' as const,
          evaluation: { ...repeated.evaluation!, performance: 'FAILED' as const } };
        f.store.saveExperiment(historical);
        const resume = () => runtime.completeRevalidationExperiment({ experimentId: priorRun.experiment_id, factsAlreadyPersisted: true,
          revalidation: { formal: validation, independent: null, performance_gate: gate, passed: false } });
        assert.deepEqual(resume(), historical);
        assert.deepEqual(resume(), historical);
      }
    } finally { await f.close(); }
  });
}

test('Runner success remains a separate fact; invalid derived statistics and replay preserve both identities', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const pack = JSON.parse(fs.readFileSync(loadOptimizationConfig(f.configPath).config.validation.testpack, 'utf8'));
    pack.performance.statistics = DEFAULT_STATISTICS;
    pack.performance.sampling.samples = 9;
    const gate = evaluatePerformanceGate(pack, [{ case_id: 'p1', baseline_samples: Array(9).fill(1), candidate_samples: [1] }]);
    const runtime = new OptimizationRuntime(f.store);
    const experiment = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'FORMAL_EVALUATION' });
    const status = { ...experiment, status: 'SUCCEEDED' as const, validity: 'VALID' as const, failure_category: null,
      ended_at: experiment.created_at, current_step: null, cancel_requested: false, failure: null };
    const validation = { ...seeded.validation, runner_status: status, performance: seeded.validation.build, passed: true };
    runtime.synchronizeRemoteExperiment(status);
    const result = runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation, performance: gate, factsAlreadyPersisted: true });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.validity, 'INVALID');
    assert.equal(result.runner_terminal_facts?.validity, 'VALID');
    assert.equal(result.evaluation?.performance, 'INVALID');
    assert.deepEqual(runtime.synchronizeRemoteExperiment(status), result);
    assert.deepEqual(runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation, performance: gate, factsAlreadyPersisted: true }), result);

    // Model an older saved record; replay must never silently reinterpret it.
    const priorRun = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'FORMAL_EVALUATION' });
    const { runner_terminal_facts: _runnerFacts, ...priorFields } = result;
    const historical = { ...priorFields, experiment_id: priorRun.experiment_id, validity: 'VALID' as const };
    f.store.saveExperiment(historical);
    const resume = () => runtime.completeValidationExperiment({ experimentId: priorRun.experiment_id, validation, performance: gate, factsAlreadyPersisted: true });
    assert.deepEqual(resume(), historical);
    assert.deepEqual(resume(), historical);
  } finally { await f.close(); }
});

test('public retry and report retain the invalid statistics diagnosis without marking the candidate failed', async () => {
  const f = await startWebFixture();
  try {
    const filename = loadOptimizationConfig(f.configPath).config.validation.testpack;
    const pack = JSON.parse(fs.readFileSync(filename, 'utf8'));
    pack.performance.statistics = DEFAULT_STATISTICS;
    pack.performance.sampling.samples = 9;
    pack.performance.command.args = ['-e', 'console.log(JSON.stringify([{case_id:"p1",baseline_samples:Array(9).fill(1),candidate_samples:[1]}]))'];
    fs.writeFileSync(filename, JSON.stringify(pack));
    const seeded = await seedBlockedValidation(f, true);
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const workflow = f.service.get(seeded.workflowId)!;
    assert.equal(workflow.status, 'VALIDATION_BLOCKED', workflow.error ?? JSON.stringify(workflow.progress));
    assert.equal(workflow.candidate_id, seeded.candidate.candidate_id);
    assert.equal(workflow.candidate_evaluation_feedback?.performance_summary.status, 'INVALID');
    const report = (await api.getOptimizationReport(seeded.workflowId)).report;
    const result = report.experiments.filter(row => row.experiment.candidate_id === seeded.candidate.candidate_id).at(-1)!.experiment;
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.validity, 'INVALID');
    assert.equal(result.evaluation?.performance, 'INVALID');
    assert.equal(result.failure_category, null);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
    assert.equal(f.modelRequests.inference, 0);
  } finally { await f.close(); }
});
