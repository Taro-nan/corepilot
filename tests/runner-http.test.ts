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
import { runValidationCommand } from '../src/workspace/validation-runner.js';
import { exportGitSourceArchive } from '../src/workspace/git-source-archive.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { sourceTreeSha256Async } from '../src/core/source-identity.js';

const TOKEN = 'runner-test-token-not-a-secret';

test('unchanged correctness code executes known-bad implementations; valid FAIL detects a defect, crashes and self-passing tests do not', async () => {
  const item = await harness();
  try {
    const good = path.join(item.root, 'correct.cjs'), bad = path.join(item.root, 'missing-tail.cjs');
    fs.writeFileSync(good, 'module.exports = a => a.map(x => x * 2);');
    fs.writeFileSync(bad, 'module.exports = a => a.map((x,i) => i < 16 ? x * 2 : 0);');
    const script = path.join(item.root, 'check.cjs');
    fs.writeFileSync(script, `const fs=require('fs'),crypto=require('crypto');const artifact=process.argv[2];
const values=Array.from({length:17},(_,i)=>i+1), result=require(artifact)(values);
const passed=result.length===values.length && result.every((x,i)=>x===values[i]*2);
console.log('COREPILOT_MEASUREMENT '+JSON.stringify({kind:'CORRECTNESS_CASE',role:'EVALUATOR',subject_id:'tail17',sample_index:null,value:passed?'PASS':'FAIL',unit:null,validity:'VALID',domain_payload:{parameters:{length:17},artifact_identity:{sha256:crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),input_path:artifact,resolved_symbol_path:artifact},evaluator_binary_identity:{sha256:'${'c'.repeat(64)}'}}}));process.exit(passed?0:1);`);
    for (const [id, artifact, expected] of [['correct', good, 'MISSED'], ['fault', bad, 'DETECTED']] as const) {
      const run = plan(item.root, `sensitivity:${id}`, '');
      run.steps[0] = { step: 'CORRECTNESS', command: { executable: process.execPath, args: [script, artifact], cwd: item.root, environment: {}, timeout_ms: 5000 },
        formal_context: { phase: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'tail17', iteration_index: null, parameters: { length: 17 },
          resources: { threads: 1, cpu_set: '0', numa_node: 0 }, artifact: { artifact_id: `sensitivity:${id}`, path: artifact, sha256: null } },
        diagnostic_probe: { probe_id: id, defect: 'omits SIMD tail', input_id: 'tail17' } };
      await item.client.submitExperiment(run);
      assert.equal((await waitForStatus(item.client, run.experiment.experiment_id, ['SUCCEEDED', 'FAILED'])).status, 'SUCCEEDED');
      const measured = (await item.client.getMeasurements(run.experiment.experiment_id)).measurements;
      assert.equal(measured.length, 1); assert.equal(measured[0].kind, 'OBSERVATION'); assert.equal(measured[0].value, expected);
    }
    fs.writeFileSync(bad, 'throw new Error("broken ABI")');
    const crash = plan(item.root, 'sensitivity:crash', '');
    crash.steps[0] = { step: 'CORRECTNESS', command: { executable: process.execPath, args: [script, bad], cwd: item.root, environment: {}, timeout_ms: 5000 },
      formal_context: { phase: 'CORRECTNESS_CASE', role: 'EVALUATOR', subject_id: 'tail17', iteration_index: null, parameters: { length: 17 },
        resources: { threads: 1, cpu_set: '0', numa_node: 0 }, artifact: { artifact_id: 'sensitivity:crash', path: bad, sha256: null } },
      diagnostic_probe: { probe_id: 'crash', defect: 'broken ABI', input_id: 'tail17' } };
    await item.client.submitExperiment(crash);
    assert.equal((await waitForStatus(item.client, 'sensitivity:crash', ['FAILED'])).failure_category, 'EVALUATOR_FAILURE');
    assert.equal((await item.client.getMeasurements('sensitivity:crash')).measurements.length, 0);
  } finally { await item.server.close(); fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Runner RPC stages pinned source bytes and exports live logs plus new build artifacts in one discoverable run', async () => {
  const item = await harness();
  const repo = path.join(item.root, 'export-repo'); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--initial-branch=main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(repo, 'source.c'), 'int answer(void){return 42;}\n');
  fs.writeFileSync(path.join(repo, 'old.so'), 'tracked fixture, not a new build product');
  git('add', '.'); git('commit', '-m', 'pinned source');
  const archive = await exportGitSourceArchive(repo, git('rev-parse', 'HEAD'), path.join(item.root, 'source.tar.gz'));
  const run = path.join(item.root, 'projects', 'fixture', 'branches', 'main', 'runs', 'baseline-1');
  try {
    await assert.rejects(item.client.uploadSourceArchive({ filename: archive.path, sha256: '0'.repeat(64), workspacePath: path.join(run, 'source') }), /SHA-256/);
    const staged = await item.client.uploadSourceArchive({ filename: archive.path, sha256: archive.sha256, workspacePath: path.join(run, 'source') });
    assert.equal(staged.source_sha256, sourceTreeSha256(staged.workspace_path));
    assert.equal(staged.source_sha256, await sourceTreeSha256Async(staged.workspace_path));
    const release = path.join(item.root, 'release-build');
    const buildRoot = path.join(run, 'build');
    const build = plan(item.root, 'experiment:archive-build', `const fs=require('fs');console.log('compile-start');const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(release)}))return;clearInterval(timer);fs.mkdirSync(${JSON.stringify(path.join(buildRoot, 'CMakeFiles'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(buildRoot, 'CMakeFiles', 'compiler-probe.exe'))},'compiler detection');fs.writeFileSync(${JSON.stringify(path.join(buildRoot, 'libfixture.so'))},'new fixture artifact');console.log('compile-done');},25);`);
    build.steps[0].execution_domain = 'CANDIDATE'; build.steps[0].command.cwd = staged.workspace_path;
    build.candidate = { candidate_id: build.experiment.candidate_id, commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), source_sha256: staged.source_sha256, workspace_path: staged.workspace_path };
    build.output_directory = path.join(run, 'logs');
    build.build_directory = buildRoot;
    await item.client.submitExperiment(build);
    let streaming = false;
    for (let i = 0; i < 80; i++) { if ((await item.client.getExecutionOutput(build.experiment.experiment_id))?.stdout.includes('compile-start')) { streaming = true; break; } await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(streaming, true, 'logs are visible before the command finishes');
    assert.equal((await item.client.getExperiment(build.experiment.experiment_id)).status, 'RUNNING');
    fs.writeFileSync(release, 'done');
    await waitForStatus(item.client, build.experiment.experiment_id, ['SUCCEEDED']);
    const output = await item.client.getExecutionOutput(build.experiment.experiment_id);
    assert.match(output!.stdout, /compile-done/);
    assert.deepEqual(output!.artifacts!.map(file => file.relative_path), ['build/libfixture.so']);
    assert.equal(fs.readFileSync(output!.artifacts![0].path, 'utf8'), 'new fixture artifact');
    assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'run.json'), 'utf8')).experiment.status, 'SUCCEEDED');
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  } finally { await item.server.close(); fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('Git archive exports committed long paths without a Control checkout or index mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-archive-long-'));
  try {
    execFileSync('git', ['init', '--initial-branch=main', root], { windowsHide: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    const blob = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: 'committed bytes', encoding: 'utf8', windowsHide: true }).stdout.trim();
    const longPath = `ctest/build/${'directory-'.repeat(12)}/${'function-'.repeat(12)}/function.cpp.o.d`;
    git('update-index', '--add', '--cacheinfo', `100644,${blob},${longPath}`); git('commit', '-m', 'long path object');
    const before = git('status', '--porcelain');
    const archive = await exportGitSourceArchive(root, git('rev-parse', 'HEAD'), path.join(root, '.git', 'export.tar.gz'));
    assert.ok(execFileSync('tar', ['-tf', archive.path], { encoding: 'utf8' }).includes(longPath));
    assert.equal(fs.existsSync(path.join(root, 'ctest')), false);
    assert.equal(git('status', '--porcelain'), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SSH transport preserves bash -lc scripts as one quoted remote argv', () => {
  const script = "rm -rf -- '/tmp/a b' && mkdir -p -- '/tmp/a b'";
  const serialized = serializeRemoteArgv(['bash', '-lc', script]);
  assert.equal(serialized, "'bash' '-lc' 'rm -rf -- '\"'\"'/tmp/a b'\"'\"' && mkdir -p -- '\"'\"'/tmp/a b'\"'\"''");
  const args = buildSshCommandArgs('target-alias', ['bash', '-lc', script]);
  assert.deepEqual(args.slice(-2), ['target-alias', serialized]);
});

test('unqualified development comparisons enforce declared resources and reject changed workload parameters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-controlled-draft-'));
  const artifact = path.join(root, 'artifact.so'); fs.writeFileSync(artifact, 'fixture artifact');
  const digest = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
  let enforced = 0;
  const server = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: TOKEN, dbPath: path.join(root, 'runner.sqlite'), workspaceRoot: root,
    resourceEnforcement: 'REQUIRED', formalResourceCommandRunner: async (command, resources, signal) => {
      enforced++;
      assert.deepEqual(resources, { threads: 2, cpu_set: '2-3', numa_node: 1 });
      assert.equal(command.environment.OMP_NUM_THREADS, '2');
      return { result: await runValidationCommand(command, command.cwd, { signal }), resourceContext: {
        declared: resources, applied: { cpu_affinity: { mechanism: 'taskset', cpu_set: '2-3' },
          numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: '1', memory_nodes: '1' },
          thread_configuration: { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', GOTO_NUM_THREADS: '2' } },
        observed: { cpu_set: '2-3', child_cpu_set: '2-3', mems_allowed_list: '1',
          numa_policy: { policy: 'bind', cpu_nodes: '1', node_bind: '1', memory_nodes: '1' },
          thread_configuration: { OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', GOTO_NUM_THREADS: '2' }, max_runtime_threads: 2, runtime_thread_observation: 'OBSERVED' },
        enforcement: { cpu_set: 'ENFORCED', numa_node: 'ENFORCED', threads: 'ENFORCED' }, validity: 'VALID', errors: [] } };
    } });
  const client = new RunnerClient({ baseUrl: server.url, token: TOKEN });
  try {
    for (const length of [64, 32]) {
      const id = `draft-parameters-${length}`;
      const observation = { kind: 'PERFORMANCE_SAMPLE', role: 'BASELINE', subject_id: 'length-64', sample_index: 0, value: 0.1, unit: 'seconds', validity: 'VALID',
        domain_payload: { parameters: { length }, artifact_identity: { sha256: digest, input_path: artifact, resolved_symbol_path: artifact }, benchmark_identity: { sha256: 'a'.repeat(64) } } };
      const execution = plan(root, id, `console.log(${JSON.stringify('COREPILOT_MEASUREMENT ' + JSON.stringify(observation))})`, { measurements: true });
      execution.steps[0].step = 'PERFORMANCE';
      execution.steps[0].formal_context = { phase: 'PERFORMANCE_SAMPLE', subject_id: 'length-64', role: 'BASELINE', iteration_index: 0,
        parameters: { length: 64, threads: 2 }, artifact: { artifact_id: 'baseline', path: artifact, sha256: digest }, resources: { threads: 2, cpu_set: '2-3', numa_node: 1 } };
      await client.submitExperiment(execution);
      const result = await waitForStatus(client, id, ['SUCCEEDED', 'FAILED']);
      assert.equal(result.status, length === 64 ? 'SUCCEEDED' : 'FAILED');
      if (length === 32) assert.match(result.failure?.message ?? '', /parameters differ/);
      else {
        const measurements = await client.getMeasurements(id);
        assert.equal(measurements.measurements[0].domain_payload.development_only, true);
        assert.equal(measurements.measurements[0].evaluator, null);
      }
    }
    assert.equal(enforced, 2);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

interface Harness {
  root: string;
  dbPath: string;
  server: RunningRunnerServer;
  client: RunnerClient;
}

async function harness(existing?: { root: string; dbPath: string }): Promise<Harness> {
  const root = existing?.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-runner-'));
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

test('Runner owns one durable FIFO lane across builds and measurements, queued cancellation never starts a process', async () => {
  const item = await harness();
  try {
    await item.client.submitExperiment(plan(item.root, 'queue:first', "setTimeout(()=>console.log('first finished'),350)"));
    await waitForStatus(item.client, 'queue:first', ['RUNNING']);
    await item.client.submitExperiment(plan(item.root, 'queue:cancel', "console.log('must never execute')"));
    await item.client.submitExperiment(plan(item.root, 'queue:last', "console.log('last finished')"));
    const queued = await item.client.getExperiment('queue:last');
    assert.equal(queued.status, 'PENDING'); assert.equal(queued.queue?.position, 2);
    assert.equal(queued.queue?.waiting_for, 'queue:first');
    assert.equal((await item.client.getCommandExecutions('queue:last')).command_executions.length, 0);
    await item.client.cancelExperiment('queue:cancel');
    await waitForStatus(item.client, 'queue:last', ['SUCCEEDED']);
    assert.equal((await item.client.getCommandExecutions('queue:cancel')).command_executions.length, 0);
    const first = (await item.client.getCommandExecutions('queue:first')).command_executions[0];
    const last = (await item.client.getCommandExecutions('queue:last')).command_executions[0];
    assert.ok(Date.parse(last.start_time) >= Date.parse(first.end_time));
    assert.ok(((await item.client.getExperiment('queue:last')).queue?.wait_ms ?? 0) > 0);
    assert.ok((await item.client.getExperiment('queue:last')).observed_context?.measurement_environment);
  } finally { await item.server.close(); fs.rmSync(item.root, { recursive: true, force: true }); }
});

for (const priorStatus of ['RUNNING', 'UNKNOWN'] as const) test(`${priorStatus} process ownership blocks recovered pending work until an explicit stopped receipt, without rewriting historical failure`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-queue-restart-'));
  const dbPath = path.join(root, 'runner.sqlite');
  const store = new SqliteRunnerStore(dbPath); store.init();
  const unknown = plan(root, 'queue:unknown', "console.log('never replay')");
  unknown.experiment.status = priorStatus; unknown.experiment.started_at = new Date().toISOString();
  store.createExecution({ ...unknown, current_step: 'BUILD', cancel_requested: false, failure: null });
  const pending = plan(root, 'queue:pending', "console.log('pending resumed')");
  store.createExecution({ ...pending, current_step: null, cancel_requested: false, failure: null }); store.close();
  const item = await harness({ root, dbPath });
  try {
    const history = await item.client.getExperiment('queue:unknown');
    assert.equal(history.status, 'UNKNOWN');
    const waiting = await item.client.getExperiment('queue:pending');
    assert.equal(waiting.status, 'PENDING'); assert.equal(waiting.queue?.waiting_for, 'queue:unknown');
    await item.client.confirmExperimentStopped('queue:unknown', 'maintainer', 'Verified no old process or process group remains');
    await waitForStatus(item.client, 'queue:pending', ['SUCCEEDED']);
    const released = await item.client.getExperiment('queue:unknown');
    assert.equal(released.status, 'UNKNOWN'); assert.equal(released.failure?.code, history.failure?.code);
    assert.ok(released.queue?.stop_confirmation); assert.equal((await item.client.getCommandExecutions('queue:unknown')).command_executions.length, 0);
  } finally { await item.server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

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
    "const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);console.log('COREPILOT_MEASUREMENT '+JSON.stringify(" + JSON.stringify(measurement) + "));console.error('retained-stderr')}},20)",
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
    assert.match(commands.command_executions[0].stdout, /COREPILOT_MEASUREMENT/);
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
    // Changing a runtime dependency must invalidate the next experiment even when the main artifact matches.
    const dependency = path.join(item.root, 'baseline-runtime.so');
    fs.writeFileSync(dependency, 'changed dependency bytes');
    const withDependency = structuredClone(formalPlan);
    withDependency.experiment.experiment_id = 'experiment:dependency-drift';
    for (const step of withDependency.steps) {
      if (step.formal_context) step.formal_context.artifact.dependencies = [{ path: dependency,
        sha256: createHash('sha256').update('original dependency bytes').digest('hex') }];
    }
    await item.client.submitExperiment(withDependency);
    const invalid = await waitForStatus(item.client, withDependency.experiment.experiment_id, ['FAILED']);
    assert.equal(invalid.validity, 'INVALID');
    assert.match(invalid.failure?.message ?? '', /dependency differs from frozen identity/);
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
