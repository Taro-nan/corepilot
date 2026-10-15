import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunnerClient, RunnerClientError } from '../src/client/runner-client.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION, type Experiment } from '../src/contracts/optimization-domain.js';
import type { ExperimentExecutionPlan, ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { evaluatorContentSha256, inspectFormalEvaluatorBundle, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { cpuSetIsSubset, type FormalResourceCommandRunner, type FormalResourceContext } from '../src/runner/resource-enforcement.js';
import { runValidationCommand } from '../src/workspace/validation-runner.js';
import { createFormalEvaluatorFixture, type FormalEvaluatorFixtureOptions } from './formal-evaluator-fixture.js';

const TOKEN = 'formal-evaluator-test-token';

test('child CPU affinity may narrow inside but cannot escape the declared taskset envelope', () => {
  assert.equal(cpuSetIsSubset('0', '0-15'), true);
  assert.equal(cpuSetIsSubset('0-7', '0-15'), true);
  assert.equal(cpuSetIsSubset('0,2,4,6', '0-7'), true);
  assert.equal(cpuSetIsSubset('15-16', '0-15'), false);
});

test('checked-in SGEMV-N bundle is explicitly owner-approved and qualified', () => {
  const root = path.resolve('evaluators/sgemv-n/1.0.0');
  const loaded = loadFormalEvaluatorBundle(root);
  const inspection = inspectFormalEvaluatorBundle(root);
  assert.equal(loaded.manifest.evaluator_id, 'sgemv-n');
  assert.equal(loaded.correctness.cases.length, 29);
  assert.equal(loaded.workloads.workloads.length, 18);
  assert.equal(loaded.qualification.status, 'QUALIFIED');
  assert.equal(loaded.qualification.qualification_run.result, 'TARGET_EXECUTION_PASSED');
  assert.equal(loaded.qualification.reviewer, 'Chen Mengnan <1195903721@qq.com>');
  assert.equal(loaded.qualification.approved_at, '2026-09-29T08:06:21.240Z');
  assert.equal(inspection.effective_state, 'QUALIFIED');
  assert.equal(inspection.checks.every((item) => item.status === 'PASS'), true);
  assert.equal(loadFormalEvaluatorBundle(root, { requireQualified: true }).qualification.status, 'QUALIFIED');
  const rawQualification = JSON.parse(fs.readFileSync(path.join(root, 'qualification.json'), 'utf8')) as {
    evidence: { evidence_digest?: string };
  };
  assert.equal(rawQualification.evidence.evidence_digest, '7564170a63bb77350b810943c01b14bb2ba358a498aaa3144d21800b411c479c');
});

test('checked-in SAXPY onboarding bundle uses generic parameters and remains unqualified', () => {
  const root = path.resolve('evaluators/saxpy/0.1.0');
  const loaded = loadFormalEvaluatorBundle(root);
  assert.equal(loaded.manifest.domain.api, 'cblas_saxpy');
  assert.equal(loaded.content_digest, 'd989eb4fae96a316ecfc9cf460146a07b37b7d73be242f1119f3c9ff8370a73f');
  assert.equal(loaded.qualification.status, 'QUALIFICATION_PENDING');
  assert.equal(loaded.correctness.cases.length, 7);
  assert.equal(loaded.workloads.workloads.length, 4);
  assert.deepEqual(loaded.correctness.cases[2].parameters, { n: 17, incx: 1, incy: 1, alpha: 0.75, seed: 103 });
  assert.equal(Object.hasOwn(loaded.workloads.workloads[0].parameters, 'm'), false);
  assert.throws(() => loadFormalEvaluatorBundle(root, { requireQualified: true }), /requires QUALIFIED evaluator/);

  const steps = createFormalEvaluatorSteps({
    bundle: loaded,
    stagedEvaluatorRoot: '/runner/development/saxpy-evaluator',
    runtimeRoot: '/runner/development/saxpy-runtime',
    candidateArtifact: { artifactId: 'candidate:saxpy', path: '/runner/candidate/libsaxpy.so', sha256: 'a'.repeat(64) },
    baselineArtifact: { artifactId: 'baseline:saxpy', path: '/runner/baseline/libopenblas.so', sha256: 'b'.repeat(64) },
    correctnessTimeoutMs: 10_000,
    performanceTimeoutMs: 10_000,
    includePerformance: true,
  });
  const correctness = steps.find((item) => item.step === 'CORRECTNESS');
  assert.deepEqual(correctness?.command.args.slice(1), [
    'n0', '/runner/candidate/libsaxpy.so', '0', '1', '1', '1', '1', '101', '/runner/development/saxpy-runtime',
  ]);
  const sample = steps.find((item) => item.formal_context?.phase === 'PERFORMANCE_SAMPLE');
  assert.deepEqual(sample?.command.args.slice(1), [
    'sample', 'BASELINE', 'saxpy_1024_t1', '/runner/baseline/libopenblas.so',
    '1024', '1', '1', '0.75', '1', '20000', '1001', '0', '/runner/development/saxpy-runtime',
  ]);
});

test('qualification attestation is outside evaluator content identity and binds the exact subject digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-attestation-content-'));
  try {
    const fixture = createFormalEvaluatorFixture(root);
    const before = evaluatorContentSha256(root);
    const qualificationPath = path.join(root, 'qualification.json');
    const qualification = JSON.parse(fs.readFileSync(qualificationPath, 'utf8')) as Record<string, unknown>;
    qualification.updated_at = '2026-09-28T01:00:00.000Z';
    fs.writeFileSync(qualificationPath, `${JSON.stringify(qualification, null, 2)}\n`);
    assert.equal(evaluatorContentSha256(root), before);
    const loaded = loadFormalEvaluatorBundle(root, { requireQualified: true });
    assert.equal(loaded.qualification.subject_digest, fixture.digest);
    assert.equal(loaded.content_digest, fixture.digest);

    qualification.subject_digest = 'f'.repeat(64);
    fs.writeFileSync(qualificationPath, `${JSON.stringify(qualification, null, 2)}\n`);
    assert.equal(evaluatorContentSha256(root), before);
    assert.throws(() => loadFormalEvaluatorBundle(root), /qualification subject_digest mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('target execution facts cannot promote an attestation without explicit owner approval', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-attestation-approval-'));
  try {
    const fixture = createFormalEvaluatorFixture(root, {
      state: 'QUALIFICATION_PENDING',
      targetResult: 'TARGET_EXECUTION_PASSED',
    });
    const loaded = loadFormalEvaluatorBundle(root);
    assert.equal(loaded.qualification.qualification_run.result, 'TARGET_EXECUTION_PASSED');
    assert.equal(loaded.qualification.status, 'QUALIFICATION_PENDING');
    assert.equal(loaded.qualification.reviewer, null);
    assert.equal(loaded.qualification.subject_digest, fixture.digest);
    assert.throws(() => loadFormalEvaluatorBundle(root, { requireQualified: true }), /requires QUALIFIED evaluator/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing evaluator content invalidates the prior qualification without changing the attestation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-attestation-invalidated-'));
  try {
    const fixture = createFormalEvaluatorFixture(root);
    const qualificationBefore = fs.readFileSync(path.join(root, 'qualification.json'), 'utf8');
    fs.writeFileSync(path.join(root, 'oracle.txt'), 'changed immutable oracle\n');
    assert.notEqual(evaluatorContentSha256(root), fixture.digest);
    assert.equal(fs.readFileSync(path.join(root, 'qualification.json'), 'utf8'), qualificationBefore);
    assert.throws(() => loadFormalEvaluatorBundle(root, { requireQualified: true }), /content digest mismatch|subject_digest mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Runner rejects unqualified, missing-manifest, and digest-mismatched evaluators', async () => {
  const harness = await createHarness();
  try {
    const pending = makePlan(harness.root, 'unqualified', { state: 'QUALIFICATION_PENDING' }, false);
    await assert.rejects(
      () => harness.client.submitExperiment(pending.plan),
      (error: unknown) => error instanceof RunnerClientError && error.status === 400 && /requires QUALIFIED evaluator/.test(error.message),
    );

    const missingEvaluator = path.join(harness.root, 'evaluators', 'missing');
    const missingCandidate = path.join(harness.root, 'candidates', 'missing');
    fs.mkdirSync(missingEvaluator, { recursive: true });
    fs.mkdirSync(missingCandidate, { recursive: true });
    fs.writeFileSync(path.join(missingCandidate, 'candidate.bin'), 'candidate');
    const missingExperiment = pendingExperiment('experiment:missing-manifest', '0'.repeat(64));
    const missingPlan: ExperimentExecutionPlan = {
      experiment: missingExperiment,
      candidate: { candidate_id: missingExperiment.candidate_id, commit: 'commit', tree: 'tree', source_sha256: sourceTreeSha256(missingCandidate), workspace_path: missingCandidate },
      evaluator: { evaluator_id: 'evaluator:test', version: '1.0.0', digest: '0'.repeat(64), workspace_path: missingEvaluator },
      steps: [{ step: 'BUILD', execution_domain: 'CANDIDATE', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: missingCandidate, environment: {}, timeout_ms: 5_000 } }],
    };
    await assert.rejects(
      () => harness.client.submitExperiment(missingPlan),
      (error: unknown) => error instanceof RunnerClientError && error.status === 400 && /manifest\.json/.test(error.message),
    );

    const mismatch = makePlan(harness.root, 'digest-mismatch', {}, false);
    mismatch.plan.experiment.evaluator.digest = 'f'.repeat(64);
    if (mismatch.plan.evaluator) mismatch.plan.evaluator.digest = 'f'.repeat(64);
    await assert.rejects(
      () => harness.client.submitExperiment(mismatch.plan),
      (error: unknown) => error instanceof RunnerClientError && error.status === 400 && /digest differs|digest mismatch/.test(error.message),
    );
  } finally {
    await harness.close();
  }
});

test('qualified evaluator preserves raw samples, derives medians, enforces symmetry, and traces identity', async () => {
  const harness = await createHarness();
  try {
    const asymmetric = makePlan(harness.root, 'asymmetric', {}, true);
    asymmetric.plan.steps.pop();
    await assert.rejects(
      () => harness.client.submitExperiment(asymmetric.plan),
      (error: unknown) => error instanceof RunnerClientError && error.status === 400 && /exactly match workload, role, warmup, and sample/.test(error.message),
    );

    const valid = makePlan(harness.root, 'qualified', {}, true);
    await harness.client.submitExperiment(valid.plan);
    const completed = await waitForStatus(harness.client, valid.plan.experiment.experiment_id, ['SUCCEEDED', 'FAILED']);
    assert.equal(completed.status, 'SUCCEEDED', completed.failure?.message);
    assert.deepEqual((completed.observed_context as { evaluator: unknown }).evaluator, {
      id: 'evaluator:test', version: '1.0.0', digest: valid.digest,
    });

    const response = await harness.client.getMeasurements(valid.plan.experiment.experiment_id);
    const raw = response.measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE');
    const medians = response.measurements.filter((item) => item.kind === 'PERFORMANCE_MEDIAN');
    assert.equal(raw.length, 6);
    assert.equal(medians.length, 2);
    assert.deepEqual(raw.filter((item) => item.role === 'BASELINE').map((item) => item.value), [9, 3, 6]);
    assert.deepEqual(raw.filter((item) => item.role === 'CANDIDATE').map((item) => item.value), [4, 2, 8]);
    assert.equal(medians.find((item) => item.role === 'BASELINE')?.value, 6);
    assert.equal(medians.find((item) => item.role === 'CANDIDATE')?.value, 4);
    assert.equal(response.measurements.every((item) => item.evaluator?.digest === valid.digest), true);
    assert.equal((raw[0].domain_payload.resource_policy as { enforcement: { cpu_set: string } }).enforcement.cpu_set, 'NOT_ENFORCED');

    const commands = await harness.client.getCommandExecutions(valid.plan.experiment.experiment_id);
    assert.equal(commands.command_executions.every((item) => item.evaluator?.digest === valid.digest), true);
  } finally {
    await harness.close();
  }
});

test('Runner rejects candidate mutation of evaluator content or attestation and executed-case identity drift', async () => {
  const harness = await createHarness();
  try {
    const mutation = makePlan(harness.root, 'candidate-mutation', {}, false);
    const evaluatorRoot = mutation.plan.evaluator?.workspace_path as string;
    const candidateRoot = mutation.plan.candidate?.workspace_path as string;
    mutation.plan.steps.unshift({
      step: 'BUILD',
      execution_domain: 'CANDIDATE',
      command: {
        executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(path.join(evaluatorRoot, 'oracle.txt'))},'candidate mutation')`],
        cwd: candidateRoot,
        environment: {},
        timeout_ms: 5_000,
      },
    });
    await harness.client.submitExperiment(mutation.plan);
    const mutated = await waitForStatus(harness.client, mutation.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(mutated.validity, 'INVALID');
    assert.equal(mutated.failure?.code, 'EVALUATOR_IDENTITY_MISMATCH');

    const attestationMutation = makePlan(harness.root, 'attestation-mutation', {}, false);
    const attestationRoot = attestationMutation.plan.evaluator?.workspace_path as string;
    const attestationCandidate = attestationMutation.plan.candidate?.workspace_path as string;
    const qualificationPath = path.join(attestationRoot, 'qualification.json');
    attestationMutation.plan.steps.unshift({
      step: 'BUILD',
      execution_domain: 'CANDIDATE',
      command: {
        executable: process.execPath,
        args: ['-e', `const fs=require('node:fs');const p=${JSON.stringify(qualificationPath)};const q=JSON.parse(fs.readFileSync(p,'utf8'));q.updated_at='2026-09-28T03:00:00.000Z';fs.writeFileSync(p,JSON.stringify(q,null,2)+'\\n')`],
        cwd: attestationCandidate,
        environment: {},
        timeout_ms: 5_000,
      },
    });
    await harness.client.submitExperiment(attestationMutation.plan);
    const attestationRejected = await waitForStatus(harness.client, attestationMutation.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(attestationRejected.validity, 'INVALID');
    assert.equal(attestationRejected.failure?.code, 'EVALUATOR_IDENTITY_MISMATCH');
    assert.match(attestationRejected.failure?.message ?? '', /qualification attestation changed/);

    const drift = makePlan(harness.root, 'case-drift', { reportedCaseId: 'undeclared-case' }, false);
    await harness.client.submitExperiment(drift.plan);
    const rejected = await waitForStatus(harness.client, drift.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(rejected.failure?.code, 'FORMAL_CONTRACT_VIOLATION');
    assert.match(rejected.failure?.message ?? '', /measurement identity differs/);
  } finally {
    await harness.close();
  }
});

test('resource threads remain Runner-owned when evaluator omits them from domain parameters', async () => {
  const harness = await createHarness();
  try {
    for (const phase of ['CORRECTNESS', 'PERFORMANCE'] as const) {
      const prepared = makePlan(harness.root, `missing-threads-${phase}`, { domain: 'saxpy', omitThreads: phase }, phase === 'PERFORMANCE');
      await harness.client.submitExperiment(prepared.plan);
      const completed = await waitForStatus(harness.client, prepared.plan.experiment.experiment_id, ['SUCCEEDED', 'FAILED']);
      assert.equal(completed.status, 'SUCCEEDED', completed.failure?.message);
      assert.equal(completed.failure_classification?.contract_status, 'VALID');
      const retained = (await harness.client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements;
      assert.equal(retained.filter(item => item.kind === 'PERFORMANCE_SAMPLE').length, phase === 'PERFORMANCE' ? 6 : 0);
      assert.equal(Object.hasOwn(retained[0].domain_payload.parameters as object, 'threads'), phase === 'PERFORMANCE');
    }
  } finally {
    await harness.close();
  }
});

test('missing domain fields and conflicting reported threads violate the Formal measurement contract', async () => {
  const harness = await createHarness();
  try {
    for (const [index, options] of [
      { omitParameter: { phase: 'CORRECTNESS' as const, name: 'n' } },
      { reportedThreads: { phase: 'CORRECTNESS' as const, value: 2 } },
    ].entries()) {
      const prepared = makePlan(harness.root, `invalid-measurement-${index}`, { domain: 'saxpy', ...options }, false);
      await harness.client.submitExperiment(prepared.plan);
      const rejected = await waitForStatus(harness.client, prepared.plan.experiment.experiment_id, ['FAILED']);
      assert.equal(rejected.failure_classification?.failure_origin, 'CONTRACT');
      assert.equal(rejected.failure_classification?.contract_status, 'VIOLATED');
      assert.equal(rejected.failure_classification?.evaluation_status, 'UNKNOWN');
      assert.equal(rejected.failure_classification?.violation_reason, 'omitParameter' in options ? 'MISSING_MEASUREMENT_FIELD' : 'INVALID_EVIDENCE');
      if ('omitParameter' in options) assert.deepEqual(rejected.failure?.missing_fields, ['domain_payload.parameters.n']);
      assert.equal((await harness.client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements.length, 0);
    }
  } finally {
    await harness.close();
  }
});

test('a valid Formal FAIL is candidate failure, not evaluator or contract failure', async () => {
  const harness = await createHarness();
  try {
    const prepared = makePlan(harness.root, 'candidate-correctness-fail', { correctnessValue: 'FAIL' }, true);
    await harness.client.submitExperiment(prepared.plan);
    const rejected = await waitForStatus(harness.client, prepared.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(rejected.failure?.code, 'CANDIDATE_CORRECTNESS_FAILED');
    assert.equal(rejected.failure_classification?.failure_origin, 'CANDIDATE');
    assert.equal(rejected.failure_classification?.evaluation_status, 'FAIL');
    assert.equal(rejected.failure_classification?.contract_status, 'VALID');
    const measurements = (await harness.client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements;
    assert.equal(measurements.length, 1);
    assert.equal(measurements[0].value, 'FAIL');
  } finally {
    await harness.close();
  }
});

test('missing measurement fields, evaluator errors, and timeouts stay distinct over RPC', async () => {
  const harness = await createHarness();
  try {
    for (const [index, options] of [
      { omitCorrectnessValue: true },
      { correctnessExitCode: 78 },
      { correctnessHang: true },
    ].entries()) {
      const prepared = makePlan(harness.root, `failure-layer-${index}`, options, false);
      if (options.correctnessHang) {
        const correctness = prepared.plan.steps.find(item => item.step === 'CORRECTNESS');
        if (correctness) correctness.command.timeout_ms = 250;
      }
      await harness.client.submitExperiment(prepared.plan);
      const rejected = await waitForStatus(harness.client, prepared.plan.experiment.experiment_id, ['FAILED']);
      const classification = rejected.failure_classification;
      assert.equal(classification?.evaluation_status, 'UNKNOWN');
      assert.equal(classification?.failure_origin, options.omitCorrectnessValue ? 'CONTRACT' : options.correctnessExitCode ? 'EVALUATOR' : 'EXECUTION');
      if (options.omitCorrectnessValue) {
        assert.equal(classification?.violation_reason, 'MISSING_MEASUREMENT_FIELD');
        assert.deepEqual(rejected.failure?.missing_fields, ['measurement.value']);
      } else {
        assert.equal(classification?.contract_status, 'VALID');
        assert.equal(classification?.execution_status, options.correctnessHang ? 'TIMEOUT' : 'FAILED');
      }
      assert.equal((await harness.client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements.length, 0);
    }
  } finally {
    await harness.close();
  }
});

test('missing required Runner observations report the missing resource fields', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-missing-resource-'));
  const prepared = makePlan(root, 'missing-runtime-threads', {}, false);
  const server = await startRunnerHttpServer({
    host: '127.0.0.1', port: 0, token: TOKEN, dbPath: path.join(root, 'runner.sqlite'), workspaceRoot: root,
    resourceEnforcement: 'REQUIRED',
    formalResourceCommandRunner: async (command, resources, signal) => {
      const constrained = await fakeResourceRunner(false)(command, resources, signal);
      constrained.resourceContext.observed.max_runtime_threads = null;
      constrained.resourceContext.observed.runtime_thread_observation = 'UNKNOWN';
      return constrained;
    },
  });
  try {
    const client = new RunnerClient({ baseUrl: server.url, token: TOKEN });
    await client.submitExperiment(prepared.plan);
    const rejected = await waitForStatus(client, prepared.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(rejected.failure_category, 'RESOURCE_UNAVAILABLE');
    assert.equal(rejected.failure?.code, 'MISSING_RESOURCE_CONTEXT');
    assert.deepEqual(rejected.failure?.missing_fields, ['command.resource_context.observed.max_runtime_threads']);
    assert.equal(rejected.failure_classification?.violation_reason, 'MISSING_RESOURCE_CONTEXT');
    assert.equal((await client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements.length, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('missing thread environment in the Runner resource context is not a generic invalid result', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-missing-thread-environment-'));
  const prepared = makePlan(root, 'missing-thread-environment', {}, false);
  const server = await startRunnerHttpServer({
    host: '127.0.0.1', port: 0, token: TOKEN, dbPath: path.join(root, 'runner.sqlite'), workspaceRoot: root,
    resourceEnforcement: 'REQUIRED',
    formalResourceCommandRunner: async (command, resources, signal) => {
      const constrained = await fakeResourceRunner(false)(command, resources, signal);
      constrained.resourceContext.observed.thread_configuration.OMP_NUM_THREADS = null;
      return constrained;
    },
  });
  try {
    const client = new RunnerClient({ baseUrl: server.url, token: TOKEN });
    await client.submitExperiment(prepared.plan);
    const rejected = await waitForStatus(client, prepared.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(rejected.validity, 'INVALID');
    assert.equal(rejected.failure?.code, 'MISSING_RESOURCE_CONTEXT');
    assert.deepEqual(rejected.failure?.missing_fields, ['command.resource_context.observed.thread_configuration.OMP_NUM_THREADS']);
    assert.equal((await client.getMeasurements(prepared.plan.experiment.experiment_id)).measurements.length, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required resource enforcement records declared/applied/observed facts and rejects mismatch before evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-formal-resources-'));
  const valid = makePlan(root, 'target-validated-resources', { state: 'TARGET_VALIDATED' }, true);
  const validRunner = fakeResourceRunner(false);
  let server = await startRunnerHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dbPath: path.join(root, 'valid-runner.sqlite'),
    workspaceRoot: root,
    resourceEnforcement: 'REQUIRED',
    formalResourceCommandRunner: validRunner,
    allowTargetValidatedDigest: valid.digest,
  });
  try {
    const client = new RunnerClient({ baseUrl: server.url, token: TOKEN });
    await client.submitExperiment(valid.plan);
    const completed = await waitForStatus(client, valid.plan.experiment.experiment_id, ['SUCCEEDED', 'FAILED']);
    assert.equal(completed.status, 'SUCCEEDED', completed.failure?.message);
    assert.equal(completed.validity, 'VALID');
    assert.equal((completed.observed_context as { resource_policy: { validity: string } }).resource_policy.validity, 'VALID');
    const commands = await client.getCommandExecutions(valid.plan.experiment.experiment_id);
    const formalCommands = commands.command_executions.filter((item) => item.resource_context !== null);
    assert.equal(formalCommands.length, valid.plan.steps.filter((item) => item.formal_context).length);
    assert.equal(formalCommands.every((item) => item.resource_context?.validity === 'VALID'), true);
    const measurements = await client.getMeasurements(valid.plan.experiment.experiment_id);
    assert.equal(measurements.measurements.every((item) =>
      (item.domain_payload.resource_policy as { validity: string }).validity === 'VALID'), true);
  } finally {
    await server.close();
  }

  const invalid = makePlan(root, 'resource-mismatch', {}, false);
  server = await startRunnerHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dbPath: path.join(root, 'invalid-runner.sqlite'),
    workspaceRoot: root,
    resourceEnforcement: 'REQUIRED',
    formalResourceCommandRunner: fakeResourceRunner(true),
  });
  try {
    const client = new RunnerClient({ baseUrl: server.url, token: TOKEN });
    await client.submitExperiment(invalid.plan);
    const rejected = await waitForStatus(client, invalid.plan.experiment.experiment_id, ['FAILED']);
    assert.equal(rejected.validity, 'INVALID');
    assert.equal(rejected.failure_category, 'RESOURCE_UNAVAILABLE');
    assert.equal(rejected.failure?.code, 'RESOURCE_CONSTRAINT_UNSATISFIED');
    assert.equal((await client.getMeasurements(invalid.plan.experiment.experiment_id)).measurements.length, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePlan(root: string, name: string, options: FormalEvaluatorFixtureOptions, includePerformance: boolean) {
  const candidateRoot = path.join(root, 'candidates', name);
  const evaluatorRoot = path.join(root, 'evaluators', name);
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  const candidateArtifact = path.join(candidateRoot, 'candidate.bin');
  fs.writeFileSync(candidateArtifact, `candidate ${name}`);
  const fixture = createFormalEvaluatorFixture(evaluatorRoot, options);
  const bundle = loadFormalEvaluatorBundle(evaluatorRoot);
  const experiment = pendingExperiment(`experiment:${name}`, fixture.digest);
  const artifactSha256 = createHash('sha256').update(fs.readFileSync(candidateArtifact)).digest('hex');
  experiment.baseline = { id: 'baseline:test', digest: artifactSha256 };
  const plan: ExperimentExecutionPlan = {
    experiment,
    candidate: { candidate_id: experiment.candidate_id, commit: 'commit', tree: 'tree', source_sha256: sourceTreeSha256(candidateRoot), workspace_path: candidateRoot },
    evaluator: { evaluator_id: 'evaluator:test', version: '1.0.0', digest: fixture.digest, workspace_path: evaluatorRoot },
    steps: createFormalEvaluatorSteps({
      bundle,
      stagedEvaluatorRoot: evaluatorRoot,
      runtimeRoot: path.join(candidateRoot, '.formal-runtime'),
      candidateArtifact: { artifactId: 'candidate:test', path: candidateArtifact, sha256: artifactSha256 },
      baselineArtifact: { artifactId: 'baseline:test', path: candidateArtifact, sha256: artifactSha256 },
      correctnessTimeoutMs: 5_000,
      performanceTimeoutMs: 5_000,
      includePerformance,
    }),
  };
  return { plan, digest: fixture.digest };
}

function pendingExperiment(id: string, evaluatorDigest: string): Experiment {
  const now = new Date().toISOString();
  return {
    schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
    experiment_id: id,
    task_id: 'opt-task:formal',
    candidate_id: `candidate:${id}`,
    type: 'FORMAL_EVALUATION',
    status: 'PENDING',
    validity: 'UNKNOWN',
    failure_category: null,
    evaluator: { id: 'evaluator:test', version: '1.0.0', digest: evaluatorDigest },
    baseline: { id: 'baseline:test' },
    declared_context: {},
    observed_context: null,
    evaluation: null,
    started_at: null,
    ended_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-formal-evaluator-'));
  const server = await startRunnerHttpServer({
    host: '127.0.0.1', port: 0, token: TOKEN, dbPath: path.join(root, 'runner.sqlite'), workspaceRoot: root,
  });
  return {
    root,
    client: new RunnerClient({ baseUrl: server.url, token: TOKEN }),
    close: async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function fakeResourceRunner(mismatch: boolean): FormalResourceCommandRunner {
  return async (command, resources, signal) => ({
    result: await runValidationCommand(command, command.cwd, { signal }),
    resourceContext: fakeResourceContext(resources, mismatch),
  });
}

function fakeResourceContext(
  resources: { cpu_set: string; numa_node: number; threads: number },
  mismatch: boolean,
): FormalResourceContext {
  const threads = String(resources.threads);
  const node = String(resources.numa_node);
  return {
    declared: { ...resources },
    applied: {
      cpu_affinity: { mechanism: 'taskset', cpu_set: resources.cpu_set },
      numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: node, memory_nodes: node },
      thread_configuration: { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads },
    },
    observed: {
      cpu_set: mismatch ? '1' : resources.cpu_set,
      child_cpu_set: mismatch ? '1' : resources.cpu_set,
      mems_allowed_list: node,
      numa_policy: { policy: 'bind', cpu_nodes: node, node_bind: node, memory_nodes: node },
      thread_configuration: { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads },
      max_runtime_threads: resources.threads,
      runtime_thread_observation: 'OBSERVED',
    },
    enforcement: {
      cpu_set: mismatch ? 'NOT_ENFORCED' : 'ENFORCED',
      numa_node: 'ENFORCED',
      threads: 'ENFORCED',
    },
    validity: mismatch ? 'INVALID' : 'VALID',
    errors: mismatch ? ['observed CPU set differs from declared context'] : [],
  };
}

async function waitForStatus(
  client: RunnerClient,
  id: string,
  statuses: readonly ExperimentStatusResponse['status'][],
): Promise<ExperimentStatusResponse> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await client.getExperiment(id);
    if (statuses.includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`experiment ${id} did not reach ${statuses.join('/')}`);
}
