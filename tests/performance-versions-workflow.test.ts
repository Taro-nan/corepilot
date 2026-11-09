import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClient } from '../src/client/api-client.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { DEFAULT_STATISTICS } from '../src/contracts/performance-statistics.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { evaluatePerformanceGate } from '../src/workspace/validation-runner.js';
import { startWebFixture } from './web-fixture.js';
import { seedBlockedValidation } from './validation-recovery-fixture.js';

test('formal workflow records a confirmed target miss above 1× without calling it a regression', async () => {
  const f = await startWebFixture();
  try {
    const filename = loadOptimizationConfig(f.configPath).config.validation.testpack;
    const pack = JSON.parse(fs.readFileSync(filename, 'utf8'));
    pack.performance.statistics = DEFAULT_STATISTICS;
    pack.performance.sampling.samples = 9;
    pack.performance.thresholds = { weighted_geomean_min: 1, overall_ci_lower_min: 1.1, key_case_ci_lower_min: 0.9, confidence_level: 0.95 };
    pack.performance.command.args = ['-e', 'console.log(JSON.stringify([{case_id:"p1",baseline_samples:Array(9).fill(1.05),candidate_samples:Array(9).fill(1)}]))'];
    fs.writeFileSync(filename, JSON.stringify(pack));
    const seeded = await seedBlockedValidation(f, true);
    const before = JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id));
    const api = new ApiClient(f.url, { token: f.token });
    await api.retryOptimizationValidation(seeded.workflowId);
    for (let count = 0; count < 500 && f.service.activeWorkflowIds().length; count++) await delay(20);
    const workflow = f.service.get(seeded.workflowId)!;
    assert.equal(workflow.status, 'PERFORMANCE_THRESHOLD_NOT_MET', workflow.error ?? JSON.stringify(workflow.progress));
    assert.equal(workflow.candidate_id, seeded.candidate.candidate_id);
    assert.equal(f.store.listExperiments(seeded.candidate.task_id).length, 2);
    assert.equal(JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id)), before);
    assert.equal(f.modelRequests.inference, 0);
    const latest = f.store.listExperiments(seeded.candidate.task_id).at(-1)!;
    assert.equal(latest.evaluation?.performance, 'FAILED');
    assert.equal(latest.failure_category, 'PERFORMANCE_TARGET_NOT_MET');
    const gate = latest.evaluation!.details!.performance_gate as { gate_version: number; statistics: { verdict: string; comparison: string } };
    assert.equal(gate.gate_version, 4);
    assert.equal(gate.statistics.verdict, 'FAILED');
    assert.equal(gate.statistics.comparison, 'IMPROVED');
    assert.equal(latest.evaluation?.performance_workloads?.[0].regression, false);
    assert.match(workflow.candidate_evaluation_feedback?.performance_summary.reason ?? '', /未确认性能退化/);
    assert.equal(f.store.getCandidateApproval(seeded.candidate.candidate_id), null);
  } finally { await f.close(); }
});

test('v4 revalidation separates a target miss from regression and invalid measurements', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const pack = JSON.parse(fs.readFileSync(loadOptimizationConfig(f.configPath).config.validation.testpack, 'utf8'));
    pack.performance.statistics = DEFAULT_STATISTICS;
    pack.performance.sampling.samples = 9;
    pack.performance.thresholds = { weighted_geomean_min: 1, overall_ci_lower_min: 1.1, key_case_ci_lower_min: 0.9, confidence_level: 0.95 };
    const measurement = { case_id: 'p1', baseline_samples: Array(9).fill(1.05), candidate_samples: Array(9).fill(1) };
    const gate = evaluatePerformanceGate(pack, [measurement]);
    assert.equal(gate.statistics?.verdict, 'FAILED');
    const validation = { ...seeded.validation, runner_status: undefined, performance: seeded.validation.build, passed: true };
    const runtime = new OptimizationRuntime(f.store);
    const repeat = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION' });
    const result = runtime.completeRevalidationExperiment({ experimentId: repeat.experiment_id,
      revalidation: { formal: validation, independent: null, performance_gate: gate, passed: false } });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.evaluation?.performance, 'FAILED');
    assert.equal(result.failure_category, 'PERFORMANCE_TARGET_NOT_MET');
    assert.equal(result.evaluation?.details?.performance_gate && (result.evaluation.details.performance_gate as typeof gate).statistics?.comparison, 'IMPROVED');

    const invalid = evaluatePerformanceGate(pack, [{ ...measurement, candidate_samples: [1] }]);
    const another = runtime.startExperiment({ taskId: seeded.candidate.task_id, candidateId: seeded.candidate.candidate_id, type: 'REVALIDATION' });
    const invalidResult = runtime.completeRevalidationExperiment({ experimentId: another.experiment_id,
      revalidation: { formal: validation, independent: null, performance_gate: invalid, passed: false } });
    assert.equal(invalidResult.status, 'SUCCEEDED');
    assert.equal(invalidResult.validity, 'INVALID');
    assert.equal(invalidResult.evaluation?.performance, 'INVALID');
    assert.notEqual(invalidResult.failure_category, 'PERFORMANCE_REGRESSION');
  } finally { await f.close(); }
});

test('reading a historical v3 failure does not rewrite it when v4 is available', async () => {
  const f = await startWebFixture();
  try {
    const seeded = await seedBlockedValidation(f, true);
    const pack = JSON.parse(fs.readFileSync(loadOptimizationConfig(f.configPath).config.validation.testpack, 'utf8'));
    pack.performance.statistics = { ...DEFAULT_STATISTICS, method: 'paired-block-bootstrap-v1' };
    pack.performance.sampling.samples = 9;
    const measurements = [{ case_id: 'p1', baseline_samples: Array(9).fill(0.8), candidate_samples: Array(9).fill(1) }];
    const historicalGate = evaluatePerformanceGate(pack, measurements);
    assert.equal(historicalGate.gate_version, 3);
    assert.equal(historicalGate.statistics?.verdict, 'FAILED');
    const historical = f.store.getExperiment(seeded.experiment.experiment_id)!;
    historical.evaluation = { ...historical.evaluation!, performance: 'FAILED', details: { ...historical.evaluation!.details, performance_gate: historicalGate } };
    f.store.saveExperiment(historical);
    const before = JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id));
    const api = new ApiClient(f.url, { token: f.token });
    await api.getOptimizationReport(seeded.workflowId);
    pack.performance.statistics = DEFAULT_STATISTICS;
    assert.equal(evaluatePerformanceGate(pack, measurements).gate_version, 4);
    await api.getOptimizationReport(seeded.workflowId);
    assert.equal(JSON.stringify(f.store.getExperiment(seeded.experiment.experiment_id)), before);
  } finally { await f.close(); }
});
