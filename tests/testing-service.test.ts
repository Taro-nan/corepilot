import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TestingService } from '../src/application/testing-service.js';
import { RunnerClientError } from '../src/client/runner-client.js';
import { ApiClient } from '../src/client/api-client.js';
import { ApiError } from '../src/core/api-error.js';
import { summarizeTestingTask } from '../src/application/testing-results.js';
import { createTestingFixture, testingPlanRef, waitTestingPreparation } from './testing-fixture.js';
import { startWebFixture } from './web-fixture.js';

test('file-file testing uses existing Runner without a project, fixed oracle or formal approval mutation', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    const beforePackage = fs.readFileSync(path.join(f.packageRoot, 'package.json')), oracle = fs.readFileSync(path.join(f.evaluatorRoot, 'oracle.txt'));
    const preview = f.service.plan(testingPlanRef); assert.equal(preview.function_name, 'cblas_saxpy'); assert.equal(preview.code.performance, true);
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'performance', candidate, baseline,
      expected_evaluator_digest: preview.evaluator.digest, expected_package_digest: preview.package_digest }, { requestId: 'create-file-comparison' });
    assert.equal(task.execution.status, 'PREPARING'); await waitTestingPreparation(f.service, task.task_id);
    assert.equal(f.projects.size, 0); assert.equal(f.plans.length, 1); const plan = f.plans[0];
    assert.equal(plan.experiment.type, 'DEVELOPMENT_FEEDBACK'); assert.equal(plan.candidate, undefined);
    assert.equal(plan.steps.some(step => step.step === 'BUILD' || step.step === 'CORRECTNESS'), false);
    const candidateStep = plan.steps.find(step => step.formal_context?.role === 'CANDIDATE')!;
    const baselineStep = plan.steps.find(step => step.formal_context?.role === 'BASELINE')!;
    assert.match(candidateStep.command.environment.LD_LIBRARY_PATH, /subjects\/candidate\/lib/);
    assert.match(baselineStep.command.environment.LD_LIBRARY_PATH, /subjects\/baseline\/lib/);
    assert.equal(candidateStep.formal_context!.artifact.dependencies!.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.packageRoot, 'package.json')), beforePackage);
    assert.deepEqual(fs.readFileSync(path.join(f.evaluatorRoot, 'oracle.txt')), oracle);
    f.complete(task); const details = await f.service.get(task.task_id);
    assert.equal(details.task.execution.status, 'SUCCEEDED'); assert.equal(details.summary.correctness.status, 'NOT_REQUESTED');
    assert.equal(details.summary.performance.status, 'IMPROVED'); assert.equal(details.summary.performance.speedup, 2); assert.equal(details.formal_evidence, false);
    const restarted = new TestingService(f.options); assert.deepEqual((await restarted.get(task.task_id)).summary, details.summary);
    assert.equal((await restarted.get(task.task_id)).output?.stdout, 'fixture output');
  } finally { f.close(); }
});

test('source-source freezes explicit candidate commit and builds each side in an isolated directory', async () => {
  const f = createTestingFixture();
  try {
    const source = f.source(), before = fs.readFileSync(source.project.config_path);
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'both',
      candidate: { kind: 'source', project_id: source.project.project_id, branch: 'main', commit: source.commit },
      baseline: { kind: 'source', project_id: source.project.project_id, branch: 'main', commit: source.nextCommit,
        build: { command: 'cmake -S . -B custom -DCMAKE_BUILD_TYPE=Release && cmake --build custom', cwd: '.' }, artifact: 'custom/libfixture.so' } });
    const prepared = await waitTestingPreparation(f.service, task.task_id);
    assert.equal(prepared.execution.status, 'PENDING', prepared.execution.failure?.message);
    assert.equal(prepared.subjects.candidate?.source?.commit, source.commit);
    assert.equal(prepared.subjects.baseline?.source?.commit, source.nextCommit);
    assert.equal(f.uploads.length, 2); assert.notEqual(f.uploads[0].workspacePath, f.uploads[1].workspacePath);
    const builds = f.plans[0].steps.filter(step => step.step === 'BUILD'); assert.equal(builds.length, 2);
    assert.match(builds[0].command.environment.COREPILOT_BUILD_ROOT, /subjects\/candidate\/build$/);
    assert.match(builds[1].command.environment.COREPILOT_BUILD_ROOT, /subjects\/baseline\/build$/);
    assert.equal(prepared.subjects.baseline?.artifact_path.endsWith('subjects/baseline/build/libfixture.so'), true);
    assert.deepEqual(fs.readFileSync(source.project.config_path), before);
    assert.equal(execFileSync('git', ['-C', source.project.repository_root, 'rev-parse', 'HEAD'], { windowsHide: true, encoding: 'utf8' }).trim(), source.nextCommit);
    const correct = f.plans[0].steps.find(step => step.step === 'CORRECTNESS')!;
    assert.equal(correct.command.environment.COREPILOT_BASELINE_SOURCE_ROOT, prepared.subjects.baseline?.source?.workspace);
    f.complete(task); assert.equal((await f.service.get(task.task_id)).summary.correctness.status, 'PASSED');
  } finally { f.close(); }
});

test('source-file testing reuses build defaults without changing project selection or requiring a qualified evaluator', async () => {
  const f = createTestingFixture();
  try {
    const source = f.source(), baseline = await f.binary('external');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'both',
      candidate: { kind: 'source', project_id: source.project.project_id, branch: 'main' }, baseline });
    const ready = await waitTestingPreparation(f.service, task.task_id);
    assert.equal(ready.plan.evaluator.qualification, 'DRAFT'); assert.equal(ready.subjects.candidate?.version, source.nextCommit);
    assert.equal(f.plans[0].steps.filter(step => step.step === 'BUILD').length, 1);
    assert.equal(ready.subjects.baseline?.kind, 'binary');
  } finally { f.close(); }
});

test('request id is persistent and submission timeout reconciles one experiment instead of resubmitting', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    f.failSubmit(new RunnerClientError(null, 'REQUEST_TIMEOUT', 'fixture submission ack lost'));
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'both' as const, candidate, baseline };
    const task = await f.service.start(input, { requestId: 'once-only' });
    const unknown = await waitTestingPreparation(f.service, task.task_id); assert.equal(unknown.execution.status, 'UNKNOWN');
    const restarted = new TestingService(f.options);
    assert.equal((await restarted.start(input, { requestId: 'once-only' })).task_id, task.task_id);
    await assert.rejects(restarted.start({ ...input, mode: 'performance' }, { requestId: 'once-only' }), error => error instanceof ApiError && error.statusCode === 409);
    f.complete(task); const reconciled = await restarted.get(task.task_id);
    assert.equal(reconciled.task.execution.status, 'SUCCEEDED'); assert.equal(f.plans.length, 1);
  } finally { f.close(); }
});

test('a proxy error or duplicate response after submit remains unknown and reconciles the accepted task', async () => {
  for (const error of [new RunnerClientError(503, 'HTTP_ERROR', 'proxy failed after forwarding'),
    new RunnerClientError(409, 'EXPERIMENT_ALREADY_EXISTS', 'duplicate id')]) {
    const f = createTestingFixture();
    try {
      f.failSubmit(error);
      const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'correctness' as const, candidate: await f.binary('candidate') };
      const task = await f.service.start(input, { requestId: 'accepted-before-error' });
      const unknown = await waitTestingPreparation(f.service, task.task_id);
      assert.equal(unknown.execution.status, 'UNKNOWN');
      assert.equal(unknown.execution.failure?.code, 'TESTING_SUBMISSION_UNKNOWN');
      const restarted = new TestingService(f.options);
      assert.equal((await restarted.start(input, { requestId: 'accepted-before-error' })).task_id, task.task_id);
      const reconciled = await restarted.get(task.task_id);
      assert.equal(reconciled.task.execution.status, 'RUNNING');
      assert.equal(f.plans.length, 1);
      assert.ok(f.getCalls > 0);
    } finally { f.close(); }
  }
});

test('the testing HTTP API returns and reconciles the same task after an accepted submission gets a proxy error', async () => {
  const f = createTestingFixture();
  const web = await startWebFixture({ testingService: f.service });
  try {
    f.failSubmit(new RunnerClientError(503, 'HTTP_ERROR', 'fixture proxy error'));
    const api = new ApiClient(web.url, { token: web.token });
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef,
      mode: 'correctness' as const, candidate: await f.binary('candidate') };
    const { task } = await api.testing.start(input, 'http-once');
    assert.equal((await waitTestingPreparation(f.service, task.task_id)).execution.status, 'UNKNOWN');
    assert.equal((await api.testing.start(input, 'http-once')).task.task_id, task.task_id);
    const result = await api.testing.get(task.task_id);
    assert.equal(result.task.execution.status, 'RUNNING');
    assert.equal(f.plans.length, 1);
  } finally { await web.close(); f.close(); }
});

test('a documented pre-submission rejection remains a failed preparation', async () => {
  const f = createTestingFixture();
  try {
    f.failSubmit(new RunnerClientError(400, 'INVALID_EXPERIMENT_PLAN', 'invalid execution plan'), false);
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef,
      mode: 'correctness', candidate: await f.binary('candidate') });
    const failed = await waitTestingPreparation(f.service, task.task_id);
    assert.equal(failed.execution.status, 'FAILED');
    assert.equal(failed.execution.failure?.code, 'TESTING_PREPARATION_FAILED');
    assert.equal(f.plans.length, 0);
    assert.equal((await f.service.get(task.task_id)).task.execution.status, 'FAILED');
    assert.equal(f.getCalls, 0);
  } finally { f.close(); }
});

test('a missing cancellation receipt and a 404 during reconciliation do not confirm stop', async () => {
  const f = createTestingFixture();
  try {
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef,
      mode: 'correctness', candidate: await f.binary('candidate') });
    await waitTestingPreparation(f.service, task.task_id);
    const originalFactory = f.options.runnerFactory!;
    const runner = originalFactory(f.machine);
    f.options.runnerFactory = () => ({ ...runner,
      async cancelExperiment() { throw new RunnerClientError(404, 'EXPERIMENT_NOT_FOUND', 'missing cancellation receipt'); },
      async getExperiment() { throw new RunnerClientError(404, 'EXPERIMENT_NOT_FOUND', 'not visible on this Runner'); },
    });
    const unknown = await f.service.cancel(task.task_id);
    assert.equal(unknown.task.execution.status, 'UNKNOWN');
    assert.equal(unknown.task.execution.cancel_requested, true);
    assert.equal(f.plans.length, 1);
    f.options.runnerFactory = originalFactory;
    assert.equal((await f.service.get(task.task_id)).task.execution.status, 'RUNNING');
    assert.equal(f.plans.length, 1);
  } finally { f.close(); }
});

test('a rejected cancel response after the submission receipt does not turn an accepted job into a failed preparation', async () => {
  const f = createTestingFixture(); let release!: () => void;
  try {
    f.setSubmitGate(new Promise<void>(resolve => { release = resolve; }));
    f.failCancel(new RunnerClientError(400, 'INVALID_JSON', 'invalid cancel request'));
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef,
      mode: 'correctness', candidate: await f.binary('candidate') });
    for (let i = 0; i < 100 && f.plans.length === 0; i++) await delay(10);
    assert.equal(f.plans.length, 1);
    await f.service.cancel(task.task_id);
    release();
    let result = f.service.list().find(row => row.task_id === task.task_id)!;
    for (let i = 0; i < 100 && result.execution.phase !== 'SUBMITTED'; i++) {
      await delay(10); result = f.service.list().find(row => row.task_id === task.task_id)!;
    }
    assert.equal(result.execution.phase, 'SUBMITTED');
    assert.equal(result.execution.status, 'UNKNOWN');
    assert.equal(result.execution.cancel_requested, true);
    f.failCancel(null);
    assert.equal((await f.service.get(task.task_id)).task.execution.status, 'RUNNING');
    assert.equal(f.plans.length, 1);
  } finally { release?.(); f.close(); }
});

test('cancellation during preparation never submits and running cancellation waits for the Runner receipt', async () => {
  const f = createTestingFixture(); let release!: () => void;
  try {
    const candidate = await f.binary('candidate');
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'correctness' as const, candidate };
    const preparing = await f.service.start(input);
    assert.equal((await f.service.cancel(preparing.task_id)).task.execution.cancel_requested, true);
    release(); await delay(20);
    assert.equal((await f.service.get(preparing.task_id)).task.execution.status, 'CANCELLED'); assert.equal(f.plans.length, 0);
    f.setStagingGate(null);
    const running = await f.service.start(input); await waitTestingPreparation(f.service, running.task_id);
    assert.equal(f.plans[0].steps.find(step => step.step === 'CORRECTNESS')!.command.environment.COREPILOT_BASELINE_ARTIFACT, '', 'no comparison selection must not silently compare a library with itself');
    const pending = await f.service.cancel(running.task_id);
    assert.equal(pending.task.execution.status, 'RUNNING'); assert.equal(pending.task.execution.cancel_requested, true);
    f.setStatus('CANCELLED'); assert.equal((await f.service.get(running.task_id)).task.execution.status, 'CANCELLED');
  } finally { release?.(); f.close(); }
});

test('changed connection cannot query another Runner, and restored connection reconciles the original id', async () => {
  const f = createTestingFixture();
  try {
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'correctness', candidate: await f.binary('candidate') });
    await waitTestingPreparation(f.service, task.task_id);
    const old = f.machine.runner.endpoint; f.machine.runner.endpoint = 'http://other-runner.invalid';
    const before = f.getCalls, unknown = await f.service.get(task.task_id);
    assert.equal(unknown.task.execution.status, 'UNKNOWN'); assert.equal(unknown.task.execution.failure?.code, 'TESTING_MACHINE_CHANGED'); assert.equal(f.getCalls, before);
    f.machine.runner.endpoint = old; assert.equal((await f.service.get(task.task_id)).task.execution.status, 'RUNNING'); assert.equal(f.plans.length, 1);
  } finally { f.close(); }
});

test('missing, duplicate and invalid samples never become a correctness pass or a performance improvement', async () => {
  const f = createTestingFixture();
  try {
    const candidate = await f.binary('candidate'), baseline = await f.binary('baseline');
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'both', candidate, baseline });
    const prepared = await waitTestingPreparation(f.service, task.task_id);
    const samples = [f.measurement(prepared, { role: 'BASELINE', value: 2 }), f.measurement(prepared, { role: 'CANDIDATE', value: 1 })];
    assert.equal(summarizeTestingTask(prepared, samples).correctness.status, 'NOT_MEASURED');
    assert.equal(summarizeTestingTask(prepared, samples).performance.status, 'INCOMPLETE');
    assert.equal(summarizeTestingTask(prepared, [...samples, samples[1]]).performance.status, 'INVALID');
    const wrong = f.measurement(prepared, { kind: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'case-1', sample_index: null, unit: null, value: 'PASS', validity: 'UNKNOWN' });
    assert.equal(summarizeTestingTask(prepared, [wrong]).correctness.status, 'INVALID');
  } finally { f.close(); }
});

test('invalid paths are user errors, uploaded bytes are verified and stale plan confirmation is rejected', async () => {
  const f = createTestingFixture();
  try {
    const asset = f.service.assets.create({ name: 'tamper-check' });
    const chunks = async function* () { yield Buffer.from('bytes'); };
    await assert.rejects(f.service.assets.upload(asset.asset_id, '../bad.so', chunks()), error => error instanceof ApiError && error.statusCode === 400);
    await f.service.assets.upload(asset.asset_id, 'good.so', chunks());
    await f.service.assets.finalize(asset.asset_id, { entry_path: 'good.so' });
    fs.writeFileSync(path.join(f.service.assets.filesRoot(asset.asset_id), 'good.so'), 'drift');
    await assert.rejects(f.service.assets.verify(asset.asset_id), error => error instanceof ApiError && error.code === 'TEST_ASSET_CHANGED');
    assert.throws(() => f.service.plan(null as never), error => error instanceof ApiError && error.statusCode === 400);
    await assert.rejects(f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'correctness', candidate: { kind: 'binary', asset_id: asset.asset_id }, expected_evaluator_digest: '0'.repeat(64) }), error => error instanceof ApiError && error.statusCode === 409);
    assert.equal(f.plans.length, 0);
  } finally { f.close(); }
});

test('legacy evaluator without test-plan.json still receives explicit two-library and asset paths', async () => {
  const f = createTestingFixture({ testPlan: false });
  try {
    const task = await f.service.start({ machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'both', candidate: await f.binary('candidate'), baseline: await f.binary('baseline') });
    const prepared = await waitTestingPreparation(f.service, task.task_id); assert.equal(prepared.execution.status, 'PENDING', prepared.execution.failure?.message);
    for (const step of f.plans[0].steps) {
      assert.equal(step.command.environment.COREPILOT_TEST_ASSETS_ROOT, task.workspace.assets_root);
      assert.equal(step.command.environment.COREPILOT_CANDIDATE_ARTIFACT, prepared.subjects.candidate?.artifact_path);
      assert.equal(step.command.environment.COREPILOT_BASELINE_ARTIFACT, prepared.subjects.baseline?.artifact_path);
    }
    f.complete(task); const details = await f.service.get(task.task_id);
    assert.equal(details.summary.performance.status, 'INCONCLUSIVE'); assert.equal(details.summary.performance.interval, null);
  } finally { f.close(); }
});

test('interrupted preparation remains unknown after restart and can be cancelled without a submission', async () => {
  const f = createTestingFixture(); let release!: () => void;
  try {
    f.setStagingGate(new Promise<void>(resolve => { release = resolve; }));
    const input = { machine_id: f.machine.identity.machine_id, plan: testingPlanRef, mode: 'correctness' as const, candidate: await f.binary('candidate') };
    const task = await f.service.start(input, { requestId: 'interrupted-preparation' });
    await delay(20);
    const restarted = new TestingService(f.options), unknown = await restarted.get(task.task_id);
    assert.equal(unknown.task.execution.status, 'UNKNOWN'); assert.equal(f.getCalls, 0);
    assert.equal((await restarted.start(input, { requestId: 'interrupted-preparation' })).task_id, task.task_id);
    assert.equal((await restarted.cancel(task.task_id)).task.execution.status, 'CANCELLED');
    release(); await delay(30); assert.equal(f.plans.length, 0);
  } finally { release?.(); f.close(); }
});
