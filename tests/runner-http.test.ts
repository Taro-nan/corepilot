import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Experiment } from '../src/contracts/optimization-domain.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION } from '../src/contracts/optimization-domain.js';
import type { ExperimentExecutionPlan, ExperimentStatusResponse } from '../src/contracts/runner-rpc.js';
import { RunnerClient, RunnerClientError } from '../src/client/runner-client.js';
import { startRunnerHttpServer, type RunningRunnerServer } from '../src/runner/http-server.js';
import { SqliteRunnerStore } from '../src/runner/sqlite-runner-store.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { evaluatorBundleSha256, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { buildSshCommandArgs, serializeRemoteArgv } from '../src/testpack/remote-transport.js';

const TOKEN = 'runner-test-token-not-a-secret';

test('SSH transport preserves bash -lc scripts as one quoted remote argv', () => {
  const script = "rm -rf -- '/tmp/a b' && mkdir -p -- '/tmp/a b'";
  const serialized = serializeRemoteArgv(['bash', '-lc', script]);
  assert.equal(serialized, "'bash' '-lc' 'rm -rf -- '\"'\"'/tmp/a b'\"'\"' && mkdir -p -- '\"'\"'/tmp/a b'\"'\"''");
  const args = buildSshCommandArgs('target-alias', ['bash', '-lc', script]);
  assert.deepEqual(args.slice(-2), ['target-alias', serialized]);
});

interface Harness {
  root: string;
  dbPath: string;
  server: RunningRunnerServer;
  client: RunnerClient;
}

async function harness(existing?: { root: string; dbPath: string }): Promise<Harness> {
  const root = existing?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-runner-'));
  const dbPath = existing?.dbPath ?? path.join(root, 'runner.sqlite');
  const server = await startRunnerHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    dbPath,
    workspaceRoot: root,
  });
  return { root, dbPath, server, client: new RunnerClient({ baseUrl: server.url, token: TOKEN }) };
}

function pendingExperiment(id: string): Experiment {
  const now = new Date().toISOString();
  return {
    schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
    experiment_id: id,
    task_id: 'opt-task:test',
    candidate_id: `candidate:${id}`,
    type: 'DEVELOPMENT_FEEDBACK',
    status: 'PENDING',
    validity: 'UNKNOWN',
    failure_category: null,
    evaluator: { id: 'evaluator:test' },
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

function plan(root: string, id: string, script: string, options: { measurements?: boolean; timeoutMs?: number } = {}): ExperimentExecutionPlan {
  return {
    experiment: pendingExperiment(id),
    steps: [{
      step: 'BUILD',
      command: {
        executable: process.execPath,
        args: ['-e', script],
        cwd: root,
        environment: {},
        timeout_ms: options.timeoutMs ?? 5_000,
      },
      ...(options.measurements ? { measurements_from_stdout: true } : {}),
    }],
  };
}

async function waitForStatus(client: RunnerClient, id: string, statuses: readonly ExperimentStatusResponse['status'][], timeoutMs = 5_000): Promise<ExperimentStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  let latest: ExperimentStatusResponse | null = null;
  while (Date.now() < deadline) {
    latest = await client.getExperiment(id);
    if (statuses.includes(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`experiment ${id} did not reach ${statuses.join('/')} (last=${latest?.status ?? 'none'})`);
}

test('runner health, machine probe, authentication, and missing experiment responses are real HTTP RPC', async () => {
  const item = await harness();
  try {
    const health = await item.client.health();
    assert.equal(health.runner_id, item.server.runnerId);
    assert.equal(health.protocol_version, 1);
    assert.equal(health.status, 'READY');

    const machine = await item.client.machine();
    assert.equal(machine.hostname, os.hostname());
    assert.equal(machine.architecture, os.arch());
    assert.equal(machine.kernel, os.release());
    assert.ok(machine.cpu_count >= 1);

    const unauthenticated = new RunnerClient({ baseUrl: item.server.url, token: 'wrong-token' });
    await assert.rejects(() => unauthenticated.health(), (error: unknown) => error instanceof RunnerClientError && error.status === 401 && error.code === 'UNAUTHORIZED');
    await assert.rejects(() => item.client.getExperiment('missing'), (error: unknown) => error instanceof RunnerClientError && error.status === 404 && error.code === 'EXPERIMENT_NOT_FOUND');
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('POST returns while the command is RUNNING, then retains command output and measurements', async () => {
  const item = await harness();
  const release = path.join(item.root, 'release-command');
  const measurement = {
    kind: 'PERFORMANCE_SAMPLE',
    role: 'CANDIDATE',
    subject_id: 'workload-1',
    sample_index: 0,
    value: 12.5,
    unit: 'ms',
    validity: 'VALID',
    domain_payload: { threads: 1 },
  };
  const script = [
    "const fs=require('node:fs')",
    `const release=${JSON.stringify(release)}`,
    "console.log('command-started')",
    "const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);console.log('PHYOPT_MEASUREMENT '+JSON.stringify(" + JSON.stringify(measurement) + "));console.error('retained-stderr')}},20)",
  ].join(';');
  try {
    const submitted = await item.client.submitExperiment(plan(item.root, 'experiment:async', script, { measurements: true }));
    assert.equal(submitted.experiment_id, 'experiment:async');
    assert.equal(submitted.status, 'PENDING');

    const running = await waitForStatus(item.client, submitted.experiment_id, ['RUNNING']);
    assert.equal(running.current_step, 'BUILD');
    assert.equal(fs.existsSync(release), false, 'HTTP submission returned before the command was allowed to finish');

    fs.writeFileSync(release, 'continue');
    const completed = await waitForStatus(item.client, submitted.experiment_id, ['SUCCEEDED']);
    assert.equal(completed.current_step, null);
    assert.equal(completed.failure_category, null);

    const commands = await item.client.getCommandExecutions(submitted.experiment_id);
    assert.equal(commands.command_executions.length, 1);
    assert.match(commands.command_executions[0].stdout, /command-started/);
    assert.match(commands.command_executions[0].stdout, /PHYOPT_MEASUREMENT/);
    assert.match(commands.command_executions[0].stderr, /retained-stderr/);
    assert.equal(commands.command_executions[0].exit_code, 0);

    const measurements = await item.client.getMeasurements(submitted.experiment_id);
    assert.equal(measurements.measurements.length, 1);
    assert.equal(measurements.measurements[0].subject_id, 'workload-1');
    assert.equal(measurements.measurements[0].value, 12.5);
    assert.deepEqual(measurements.measurements[0].domain_payload, { threads: 1 });
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('multiple identities are independent and a failed command produces FAILED', async () => {
  const item = await harness();
  try {
    const first = await item.client.submitExperiment(plan(item.root, 'experiment:first', "console.log('first')"));
    const second = await item.client.submitExperiment(plan(item.root, 'experiment:second', "console.log('second')"));
    assert.notEqual(first.experiment_id, second.experiment_id);
    await waitForStatus(item.client, first.experiment_id, ['SUCCEEDED']);
    await waitForStatus(item.client, second.experiment_id, ['SUCCEEDED']);

    await item.client.submitExperiment(plan(item.root, 'experiment:failed', "console.error('expected failure');process.exit(7)"));
    const failed = await waitForStatus(item.client, 'experiment:failed', ['FAILED']);
    assert.equal(failed.failure_category, 'BUILD_FAILURE');
    assert.equal(failed.failure?.code, 'COMMAND_FAILED');
    const commands = await item.client.getCommandExecutions('experiment:failed');
    assert.equal(commands.command_executions[0].exit_code, 7);
    assert.match(commands.command_executions[0].stderr, /expected failure/);
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('cancel request is distinct from confirmed CANCELLED', async () => {
  const item = await harness();
  try {
    await item.client.submitExperiment(plan(item.root, 'experiment:cancel', 'setInterval(()=>{},1000)', { timeoutMs: 10_000 }));
    await waitForStatus(item.client, 'experiment:cancel', ['RUNNING']);
    const requested = await item.client.cancelExperiment('experiment:cancel');
    assert.equal(requested.cancel_requested, true);
    assert.equal(requested.status, 'RUNNING', 'cancel acknowledgement is not terminal confirmation');
    const cancelled = await waitForStatus(item.client, 'experiment:cancel', ['CANCELLED']);
    assert.equal(cancelled.status, 'CANCELLED');
    const commands = await item.client.getCommandExecutions('experiment:cancel');
    assert.equal(commands.command_executions.length, 1);
    assert.equal(commands.command_executions[0].cancelled, true);
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('completed facts survive restart and an interrupted RUNNING record recovers as UNKNOWN', async () => {
  let item = await harness();
  const root = item.root;
  const dbPath = item.dbPath;
  try {
    await item.client.submitExperiment(plan(root, 'experiment:persisted', "console.log('persisted-output')"));
    await waitForStatus(item.client, 'experiment:persisted', ['SUCCEEDED']);
    await item.server.close();

    item = await harness({ root, dbPath });
    const persisted = await item.client.getExperiment('experiment:persisted');
    assert.equal(persisted.status, 'SUCCEEDED');
    const commands = await item.client.getCommandExecutions('experiment:persisted');
    assert.match(commands.command_executions[0].stdout, /persisted-output/);
    await item.server.close();

    const store = new SqliteRunnerStore(dbPath);
    store.init();
    const interrupted = pendingExperiment('experiment:interrupted');
    interrupted.status = 'RUNNING';
    interrupted.started_at = new Date().toISOString();
    store.createExecution({
      experiment: interrupted,
      steps: plan(root, interrupted.experiment_id, 'setInterval(()=>{},1000)').steps,
      current_step: 'BUILD',
      cancel_requested: false,
      failure: null,
    });
    store.close();

    item = await harness({ root, dbPath });
    const recovered = await item.client.getExperiment(interrupted.experiment_id);
    assert.equal(recovered.status, 'UNKNOWN');
    assert.equal(recovered.failure_category, 'UNKNOWN');
    assert.equal(recovered.failure?.code, 'RUNNER_RESTART');
    assert.equal(recovered.current_step, 'BUILD');
    assert.equal(recovered.ended_at, null);
  } finally {
    await item.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('formal execution isolates and verifies evaluator content before and after use', async () => {
  const item = await harness();
  const candidateRoot = path.join(item.root, 'candidates', 'candidate-1');
  const evaluatorRoot = path.join(item.root, 'evaluators', 'evaluator-1');
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, 'candidate.txt'), 'candidate source\n');
  const fixture = createFormalEvaluatorFixture(evaluatorRoot);
  const bundle = loadFormalEvaluatorBundle(evaluatorRoot, { requireQualified: true });
  const candidateDigest = sourceTreeSha256(candidateRoot);
  const evaluatorDigest = fixture.digest;
  const experiment = pendingExperiment('experiment:formal-isolation');
  experiment.type = 'FORMAL_EVALUATION';
  experiment.evaluator = { id: 'evaluator:test', version: '1.0.0', digest: evaluatorDigest };
  const formalPlan: ExperimentExecutionPlan = {
    experiment,
    candidate: {
      candidate_id: experiment.candidate_id,
      commit: 'candidate-commit',
      tree: 'candidate-tree',
      source_sha256: candidateDigest,
      workspace_path: candidateRoot,
    },
    evaluator: {
      evaluator_id: 'evaluator:test',
      version: '1.0.0',
      digest: evaluatorDigest,
      workspace_path: evaluatorRoot,
    },
    steps: [{
      step: 'BUILD',
      execution_domain: 'CANDIDATE',
      command: { executable: process.execPath, args: ['-e', "require('node:fs').readFileSync('candidate.txt')"], cwd: candidateRoot, environment: {}, timeout_ms: 5_000 },
    }, ...createFormalEvaluatorSteps({
      bundle,
      stagedEvaluatorRoot: evaluatorRoot,
      runtimeRoot: path.join(candidateRoot, '.formal-runtime'),
      candidateArtifact: { artifactId: 'candidate:test', path: path.join(candidateRoot, 'candidate.txt'), sha256: createHash('sha256').update(fs.readFileSync(path.join(candidateRoot, 'candidate.txt'))).digest('hex') },
      baselineArtifact: { artifactId: 'baseline:test', path: path.join(candidateRoot, 'candidate.txt'), sha256: createHash('sha256').update(fs.readFileSync(path.join(candidateRoot, 'candidate.txt'))).digest('hex') },
      correctnessTimeoutMs: 5_000,
      performanceTimeoutMs: 5_000,
      includePerformance: false,
    })],
  };
  try {
    await item.client.submitExperiment(formalPlan);
    const completed = await waitForStatus(item.client, experiment.experiment_id, ['SUCCEEDED']);
    assert.deepEqual((completed.observed_context as { evaluator: unknown }).evaluator, {
      id: 'evaluator:test',
      version: '1.0.0',
      digest: evaluatorDigest,
    });
    assert.equal(evaluatorBundleSha256(evaluatorRoot), evaluatorDigest);
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('formal execution rejects the wrong domain and records evaluator tampering as invalid', async () => {
  const item = await harness();
  const candidateRoot = path.join(item.root, 'candidates', 'candidate-2');
  const evaluatorRoot = path.join(item.root, 'evaluators', 'evaluator-2');
  fs.mkdirSync(candidateRoot, { recursive: true });
  fs.mkdirSync(evaluatorRoot, { recursive: true });
  fs.writeFileSync(path.join(candidateRoot, 'candidate.txt'), 'candidate source\n');
  const fixture = createFormalEvaluatorFixture(evaluatorRoot, { tamperOnCorrectness: true });
  const bundle = loadFormalEvaluatorBundle(evaluatorRoot, { requireQualified: true });
  const candidateDigest = sourceTreeSha256(candidateRoot);
  const evaluatorDigest = fixture.digest;
  const experiment = pendingExperiment('experiment:evaluator-tamper');
  experiment.type = 'FORMAL_EVALUATION';
  experiment.evaluator = { id: 'evaluator:test', version: '1.0.0', digest: evaluatorDigest };
  const base: ExperimentExecutionPlan = {
    experiment,
    candidate: { candidate_id: experiment.candidate_id, commit: 'commit', tree: 'tree', source_sha256: candidateDigest, workspace_path: candidateRoot },
    evaluator: { evaluator_id: 'evaluator:test', version: '1.0.0', digest: evaluatorDigest, workspace_path: evaluatorRoot },
    steps: createFormalEvaluatorSteps({
      bundle,
      stagedEvaluatorRoot: evaluatorRoot,
      runtimeRoot: path.join(candidateRoot, '.formal-runtime'),
      candidateArtifact: { artifactId: 'candidate:test', path: path.join(candidateRoot, 'candidate.txt'), sha256: createHash('sha256').update(fs.readFileSync(path.join(candidateRoot, 'candidate.txt'))).digest('hex') },
      baselineArtifact: { artifactId: 'baseline:test', path: path.join(candidateRoot, 'candidate.txt'), sha256: createHash('sha256').update(fs.readFileSync(path.join(candidateRoot, 'candidate.txt'))).digest('hex') },
      correctnessTimeoutMs: 5_000,
      performanceTimeoutMs: 5_000,
      includePerformance: false,
    }),
  };
  try {
    const wrongDomain = structuredClone(base);
    wrongDomain.experiment.experiment_id = 'experiment:wrong-domain';
    const wrongCorrectness = wrongDomain.steps.find((item) => item.step === 'CORRECTNESS');
    assert.ok(wrongCorrectness);
    wrongCorrectness.execution_domain = 'CANDIDATE';
    await assert.rejects(
      () => item.client.submitExperiment(wrongDomain),
      (error: unknown) => error instanceof RunnerClientError && error.status === 400 && /CORRECTNESS must execute in the EVALUATOR domain/.test(error.message),
    );

    await item.client.submitExperiment(base);
    const failed = await waitForStatus(item.client, experiment.experiment_id, ['FAILED']);
    assert.equal(failed.validity, 'INVALID');
    assert.equal(failed.failure_category, 'EVALUATOR_FAILURE');
    assert.equal(failed.failure?.code, 'EVALUATOR_IDENTITY_MISMATCH');
    const commands = await item.client.getCommandExecutions(experiment.experiment_id);
    assert.equal(commands.command_executions.length, 2, 'setup and the tampering command remain auditable facts');
  } finally {
    await item.server.close();
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
