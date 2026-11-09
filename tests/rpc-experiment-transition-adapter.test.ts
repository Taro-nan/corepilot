import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunnerClient, RunnerClientError } from '../src/client/runner-client.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { RunnerClientExperimentExecutionBackend, type ExperimentExecutionBackend } from '../src/core/experiment-execution-backend.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { RemoteExperimentCancelledError, RemoteExperimentUnknownError, RpcExperimentTransitionAdapter } from '../src/core/rpc-experiment-transition-adapter.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { evaluatorBundleSha256, loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { assertMeasurementTrace } from '../src/application/workflow-evidence-measurements.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { CandidateWorkspaceState } from '../src/workspace/candidate-workspace.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { candidateEvaluationFeedback } from '../src/workspace/candidate-evaluation-feedback.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';

async function verifyRpcTransition(omitThreads?: 'CORRECTNESS', submissionFailure?: 'aborted' | 'aborted-400' | '500' | '409' | 'rejected' | 'http-lost' | 'progress-error' | 'sync-and-unknown-error' | 'preexisting-plan' | 'old-runner' | 'old-artifact-check') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-rpc-transition-'));
  const runnerRoot = path.join(root, 'runner');
  const localRepository = path.join(root, 'local-source');
  const stagedCandidate = path.join(runnerRoot, 'candidates', 'candidate-1');
  const evaluatorRoot = path.join(runnerRoot, 'evaluators', 'evaluator-1');
  const stagedBaseline = path.join(runnerRoot, 'baselines', 'comparison', 'artifact.so');
  for (const directory of [runnerRoot, localRepository, stagedCandidate, evaluatorRoot, path.dirname(stagedBaseline)]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(stagedCandidate, 'candidate.txt'), 'candidate source\n');
  fs.copyFileSync(path.join(stagedCandidate, 'candidate.txt'), stagedBaseline);
  createFormalEvaluatorFixture(evaluatorRoot, { domain: 'saxpy', omitThreads, ...(omitThreads ? { correctnessValue: 'FAIL' } : {}) });
  const candidateDigest = sourceTreeSha256(stagedCandidate);
  const candidateArtifactDigest = createHash('sha256').update(fs.readFileSync(path.join(stagedCandidate, 'candidate.txt'))).digest('hex');
  const evaluatorDigest = evaluatorBundleSha256(evaluatorRoot);
  const token = 'rpc-transition-token';
  const server = await startRunnerHttpServer({
    host: '127.0.0.1',
    port: 0,
    token,
    dbPath: path.join(root, 'runner.sqlite'),
    workspaceRoot: runnerRoot,
  });
  const store = new SqliteTaskStore(path.join(root, 'control.sqlite'));
  store.init();
  const runtime = new OptimizationRuntime(store, { idFactory: (() => { let id = 0; return () => String(++id); })() });
  const task = runtime.createTask({
    workflowId: 'workflow:rpc-transition',
    target: { kind: 'software_function', name: 'cblas_saxpy', scope: { entry_file: 'kernel/arm64/axpy.S' } },
    sourceBaseline: { id: 'git:baseline' },
    performanceBaseline: { id: 'comparison', version: '1', digest: candidateArtifactDigest },
    evaluator: { id: 'evaluator:test', version: '1.0.0', digest: evaluatorDigest, details: { owner: 'test-owner' } },
    declaredContext: {},
  });
  const workspace: CandidateWorkspaceState = {
    repository: localRepository,
    baseline_commit: 'baseline',
    run_id: 'run',
    editing: localRepository,
    validation: stagedCandidate,
    editing_created: true,
    validation_created: true,
    candidate_commit: 'candidate-commit',
    candidate_tree: 'candidate-tree',
  };
  const candidate = runtime.recordCandidate({
    taskId: task.task_id,
    hypothesisId: proposeFixtureHypothesis(runtime, task.task_id, 'reduce fixture loop overhead', ['kernel/arm64/axpy.S']).hypothesis_id,
    workspace,
    checkpoint: { commit: 'candidate-commit', tree: 'candidate-tree', source_archive_sha256: candidateDigest, files: [] },
    hypothesis: 'reduce SAXPY loop overhead',
    agentIdentity: { model: 'test' },
  });
  const experiment = runtime.startExperiment({
    taskId: task.task_id,
    candidateId: candidate.candidate_id,
    type: 'FORMAL_EVALUATION',
    initialStatus: 'PENDING',
  });
  const build = { executable: process.execPath, args: ['-e', submissionFailure === 'http-lost' ? 'setInterval(()=>{},1000)' : "require('node:fs').readFileSync('candidate.txt')"], cwd: localRepository, environment: {}, timeout_ms: 5_000 };
  const evaluator = { id: 'evaluator:test', version: '1.0.0', owner: 'test-owner', root: evaluatorRoot, sha256: evaluatorDigest };
  const testpack: ValidationTestpack = {
    schema_version: 1,
    testpack_id: 'rpc-transition',
    function_name: 'cblas_saxpy',
    function_family: 'axpy',
    operation: 'y=alpha*x+y',
    data_type: 'float32',
    evaluator,
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: {
      command: {
        executable: process.execPath,
        args: ['-e', "const fs=require('node:fs');fs.readFileSync('oracle.txt');fs.readFileSync(process.env.COREPILOT_CANDIDATE_ROOT+'/candidate.txt')"],
        cwd: evaluatorRoot,
        environment: {},
        timeout_ms: 5_000,
      },
      cases: [{ case_id: 'case-1', parameters: { n: 17, incx: 1, incy: 2, alpha: 0.5, seed: 1 }, threads: 1, critical: true, weight: 1 }],
      pass_required: 1,
    },
    performance: {
      command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: evaluatorRoot, environment: {}, timeout_ms: 5_000 },
      cases: [{ case_id: 'workload-1', parameters: { n: 4096, incx: 1, incy: 1, alpha: 0.75, loops: 20, seed: 2 }, threads: 1, critical: true, weight: 1 }],
      sampling: { warmup: 1, samples: 3, interleave_seed: 1, bootstrap_iterations: 1 },
      baselines: {
        current: { id: 'current', library: 'test', version: '1', sha256: candidateArtifactDigest, path: path.join(stagedCandidate, 'candidate.txt') },
        comparison: { id: 'comparison', library: 'test', version: '1', sha256: candidateArtifactDigest, path: '/opt/known-baselines/comparison.so' },
      },
      thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 },
      key_cases: ['workload-1'],
    },
    revalidation: {
      formal: { required: false, timeout_ms: 5_000, command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: evaluatorRoot, environment: {}, timeout_ms: 5_000 } },
      independent: { required: false, timeout_ms: 5_000, command: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: evaluatorRoot, environment: {}, timeout_ms: 5_000 } },
    },
  };
  const cancellation = new AbortController();
  let submissions = 0; let cancellations = 0; let runnerMissing = false; let runnerStopped = false;
  let proxy: http.Server | undefined;
  let replacement: Awaited<ReturnType<typeof startRunnerHttpServer>> | undefined;
  let proxyTarget = server.url;
  let runnerUrl = server.url;
  if (submissionFailure === 'http-lost') {
    proxy = http.createServer((request, response) => {
      void (async () => {
        const url = request.url ?? '/';
        if (request.method === 'POST' && url.endsWith('/experiments')) {
          submissions++;
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const accepted = await fetch(server.url + url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
          if (accepted.status !== 202) throw new Error(`Runner did not accept fixture experiment: ${accepted.status} ${await accepted.text()}`);
          // The real Runner has persisted the experiment. Lose only its response.
          cancellation.abort('cancelled by user');
          return;
        }
        if (request.method === 'POST' && url.endsWith('/cancel')) {
          cancellations++; response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":{"code":"UNAVAILABLE"}}'); return;
        }
        if (runnerMissing && request.method === 'GET' && url.includes('/experiments/')) {
          response.writeHead(404, { 'content-type': 'application/json' }); response.end('{"error":{"code":"EXPERIMENT_NOT_FOUND"}}'); return;
        }
        const result = await fetch(proxyTarget + url, { headers: { authorization: `Bearer ${token}` } });
        response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
      })().catch(error => { if (!response.destroyed) { response.writeHead(500); response.end(String(error)); } });
    });
    await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
    const address = proxy.address(); assert.ok(address && typeof address === 'object'); runnerUrl = `http://127.0.0.1:${address.port}`;
  }
  const runnerClient = new RunnerClient({ baseUrl: runnerUrl, token });
  const realBackend = new RunnerClientExperimentExecutionBackend(runnerClient);
  const backend: ExperimentExecutionBackend = submissionFailure && submissionFailure !== 'http-lost' ? {
    mode: 'rpc', async preflight(signal) {
      const result = await realBackend.preflight(signal);
      if (submissionFailure === 'old-runner') { delete result.health.store_instance_id; if (result.health.capabilities) delete result.health.capabilities.store_identity_guard; }
      if (submissionFailure === 'old-artifact-check' && result.health.capabilities) delete result.health.capabilities.artifact_path_check;
      return result;
    }, bindStoreIdentity: id => realBackend.bindStoreIdentity(id),
    submitExperiment: async () => {
      submissions++;
      if (['aborted', 'aborted-400', 'progress-error', 'sync-and-unknown-error'].includes(submissionFailure!)) cancellation.abort('cancelled by user');
      if (submissionFailure === 'progress-error' || submissionFailure === 'sync-and-unknown-error') return { experiment_id: experiment.experiment_id, status: 'PENDING' };
      if (submissionFailure === '500') throw new RunnerClientError(500, 'INTERNAL', 'response after submission failed');
      if (submissionFailure === '409') throw new RunnerClientError(409, 'EXPERIMENT_ALREADY_EXISTS', 'same id exists');
      if (submissionFailure === 'rejected' || submissionFailure === 'aborted-400') throw new RunnerClientError(400, 'INVALID_EXPERIMENT_PLAN', 'rejected plan');
      throw new RunnerClientError(null, 'REQUEST_ABORTED', 'response lost');
    },
    cancelExperiment: async id => { cancellations++; return { experiment_id: id, status: 'RUNNING', cancel_requested: true }; },
    reconcileExperiment: async id => {
      if (runnerMissing) throw new RunnerClientError(404, 'EXPERIMENT_NOT_FOUND', 'not found');
      return { ...runtime.getExperiment(id), status: runnerStopped ? 'CANCELLED' : cancellation.signal.aborted ? 'RUNNING' : 'UNKNOWN',
        validity: runnerStopped ? 'INVALID' : 'UNKNOWN', failure_category: runnerStopped ? 'CANCELLED' : 'UNKNOWN',
        ended_at: runnerStopped ? new Date().toISOString() : null, current_step: 'BUILD', cancel_requested: cancellation.signal.aborted, failure: null };
    },
    getExperiment: id => realBackend.getExperiment(id),
    getCommandExecutions: id => runnerStopped ? Promise.resolve({ experiment_id: id, command_executions: [] }) : realBackend.getCommandExecutions(id),
    getMeasurements: id => runnerStopped ? Promise.resolve({ experiment_id: id, measurements: [] }) : realBackend.getMeasurements(id),
  } : realBackend;
  if (submissionFailure === 'sync-and-unknown-error') {
    runtime.synchronizeRemoteExperiment = () => { throw new Error('injected status persistence failure'); };
    runtime.markRemoteStateUnknown = () => { throw new Error('injected unknown persistence failure'); };
  }
  let candidateStageCalls = 0, evaluatorStageCalls = 0, baselineStageCalls = 0;
  const adapter = new RpcExperimentTransitionAdapter({
    backend,
    runtime,
    pollIntervalMs: 10,
    cancelConfirmationMs: 30,
    ...(submissionFailure === 'progress-error' ? { onStatus: () => { throw new Error('injected progress persistence failure'); } } : {}),
    stageCandidate: async () => { candidateStageCalls++; return { candidateId: candidate.candidate_id, workspacePath: stagedCandidate, sourceSha256: candidateDigest }; },
    stageEvaluator: async () => { evaluatorStageCalls++; return { evaluatorId: evaluator.id, version: evaluator.version, workspacePath: evaluatorRoot, digest: evaluatorDigest }; },
    stageBaseline: async ({ baseline }) => {
      baselineStageCalls += 1;
      return { baselineId: baseline.id, workspacePath: stagedBaseline, sha256: candidateArtifactDigest };
    },
  });

  try {
    if (submissionFailure === 'preexisting-plan') {
      runtime.recordRemoteExecutionPlan(experiment.experiment_id, { previously_saved: true });
      await assert.rejects(adapter.executeValidation({ experimentId: experiment.experiment_id, workspace, build, testpack,
        sourceRoot: localRepository, includePerformance: true }), RemoteExperimentUnknownError);
      assert.equal(submissions, 0, 'an existing plan is never submitted again');
      assert.deepEqual([candidateStageCalls, evaluatorStageCalls, baselineStageCalls], [0, 0, 0], 'an existing plan is detected before any staging');
      assert.deepEqual(runtime.getExperiment(experiment.experiment_id).declared_context.runner_execution_plan, { previously_saved: true });
      await assert.rejects(adapter.executeValidation({ experimentId: experiment.experiment_id, workspace, build, testpack,
        sourceRoot: localRepository, includePerformance: true, resume: true }), /历史实验没有固定 Runner 数据库身份/);
      assert.equal(runtime.getExperiment(experiment.experiment_id).declared_context.runner_store_instance_id, undefined);
      return;
    }
    if (submissionFailure === 'old-runner' || submissionFailure === 'old-artifact-check') {
      await assert.rejects(adapter.executeValidation({ experimentId: experiment.experiment_id, workspace, build, testpack,
        sourceRoot: localRepository, includePerformance: true }), /升级 Runner/);
      assert.equal(submissions, 0); assert.deepEqual([candidateStageCalls, evaluatorStageCalls, baselineStageCalls], [0, 0, 0]);
      assert.equal(runtime.getExperiment(experiment.experiment_id).declared_context.runner_store_instance_id, undefined);
      return;
    }
    if (submissionFailure) {
      const input = { experimentId: experiment.experiment_id, workspace, build, testpack, sourceRoot: localRepository, includePerformance: true };
      await assert.rejects(adapter.executeValidation({ ...input, signal: cancellation.signal }), submissionFailure === 'rejected' ? RunnerClientError : RemoteExperimentUnknownError);
      assert.equal(submissions, 1);
      if (submissionFailure === 'rejected') return;
      assert.equal(cancellations, cancellation.signal.aborted ? 1 : 0, 'cancellation is sent only when requested');
      if (submissionFailure === 'http-lost') {
        const original = await new RunnerClient({ baseUrl: server.url, token }).getExperiment(experiment.experiment_id);
        assert.ok(['PENDING', 'RUNNING'].includes(original.status), 'the real Runner accepted the original experiment and did not confirm cancellation');
      }
      const unknown = runtime.getExperiment(experiment.experiment_id);
      if (submissionFailure === 'sync-and-unknown-error') {
        assert.equal(unknown.status, 'PENDING', 'failed writes retain the previous recoverable state instead of inventing cancellation');
        assert.ok(unknown.declared_context.runner_execution_plan);
        return;
      }
      assert.equal(unknown.status, 'UNKNOWN');
      assert.equal(unknown.validity, 'UNKNOWN');
      assert.equal(unknown.ended_at, null);
      assert.equal(unknown.evaluation, null);
      assert.ok(unknown.declared_context.runner_execution_plan, 'the original plan must remain available for reconciliation');
      assert.equal(unknown.declared_context.runner_store_instance_id, server.storeInstanceId);
      if (submissionFailure === 'http-lost') {
        const preflight = realBackend.preflight.bind(realBackend);
        realBackend.preflight = async signal => { const response = await preflight(signal);
          if (response.health.capabilities) delete response.health.capabilities.artifact_path_check;
          return response; };
        const historical = new RpcExperimentTransitionAdapter({ backend: realBackend, runtime, pollIntervalMs: 10,
          stageCandidate: async () => { throw new Error('historical query must not stage'); },
          stageEvaluator: async () => { throw new Error('historical query must not stage'); } });
        try {
          await historical.preflight(undefined, { allowLegacyArtifactPathCheck: true });
          assert.equal((await realBackend.getExperiment(experiment.experiment_id)).experiment_id, experiment.experiment_id);
        } finally { realBackend.preflight = preflight; }
        replacement = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token, runnerId: server.runnerId,
          dbPath: path.join(root, 'replacement.sqlite'), workspaceRoot: runnerRoot });
        proxyTarget = replacement.url;
        await assert.rejects(adapter.executeValidation({ ...input, resume: true }), /Runner 数据库身份与原任务不一致/);
        assert.equal(runtime.getExperiment(experiment.experiment_id).status, 'UNKNOWN');
        await assert.rejects(new RunnerClient({ baseUrl: replacement.url, token }).getExperiment(experiment.experiment_id), /not found/i);
        assert.equal(submissions, 1);
        proxyTarget = server.url;
      }
      runnerMissing = true;
      await assert.rejects(adapter.executeValidation({ ...input, resume: true }), RemoteExperimentUnknownError);
      assert.equal(submissions, 1, 'a Runner 404 cannot prove that it is safe to resubmit');
      assert.equal(runtime.getExperiment(experiment.experiment_id).status, 'UNKNOWN');
      assert.equal(store.listExperiments(task.task_id).length, 1);
      if (submissionFailure === 'aborted') {
        runnerMissing = false; runnerStopped = true;
        await assert.rejects(adapter.executeValidation({ ...input, resume: true }), RemoteExperimentCancelledError);
        const confirmed = runtime.getExperiment(experiment.experiment_id);
        assert.equal(confirmed.status, 'CANCELLED');
        assert.ok(confirmed.last_control_diagnostic?.resolved_at, 'the prior unknown diagnostic is retained as resolved history');
        assert.equal(submissions, 1, 'confirmed cancellation is reconciled without another submission');
      }
      return;
    }
    const result = await adapter.executeValidation({
      experimentId: experiment.experiment_id,
      workspace,
      build,
      testpack,
      sourceRoot: localRepository,
      includePerformance: true,
    });
    if (omitThreads) {
      assert.equal(result.passed, false);
      assert.equal(result.correctness?.ok, true);
      assert.equal(result.runner_status?.status, 'FAILED');
      assert.equal(result.runner_status?.failure?.code, 'CANDIDATE_CORRECTNESS_FAILED');
      assert.equal(result.runner_status?.failure_classification?.failure_origin, 'CANDIDATE');
      const feedback = candidateEvaluationFeedback({ validation: result });
      assert.equal(feedback.candidate_id, candidate.candidate_id);
      assert.equal(feedback.experiment_id, experiment.experiment_id);
      assert.equal(feedback.correctness_status, 'FAILED');
      assert.equal(feedback.failed_cases[0].evidence.observation?.value, 'FAIL');
      assert.equal(feedback.failed_cases[0].evidence.command_execution_id, store.listCommandExecutions(experiment.experiment_id).find(command => command.step === 'CORRECTNESS')?.command_execution_id);
      assert.equal(feedback.failure_classification?.evaluation_status, 'FAIL');
      assert.equal(feedback.resource_context.validity, 'NOT_ENFORCED');
      assert.equal(feedback.performance_summary.status, 'NOT_EXECUTED');
      assert.equal(store.listMeasurements(experiment.experiment_id).length, 1);
      runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation: result, performance: null, factsAlreadyPersisted: true });
      assert.equal(store.listHypothesisOutcomes(task.task_id)[0].feedback?.failure_classification?.failure_origin, 'CANDIDATE');
      const reopened = new SqliteTaskStore(path.join(root, 'control.sqlite'));
      reopened.init();
      try {
        assert.equal(reopened.listHypothesisOutcomes(task.task_id)[0].feedback?.failure_classification?.evaluation_status, 'FAIL');
      } finally {
        reopened.close();
      }
      return;
    }
    assert.equal(result.passed, true);
    assert.equal(result.formal_correctness_complete, true);
    assert.equal(result.correctness_cases[0].status, 'PASSED');
    assert.equal(result.performance?.ok, true);
    assert.equal(baselineStageCalls, 1);
    const commands = store.listCommandExecutions(experiment.experiment_id);
    assert.equal(commands[0].cwd, stagedCandidate);
    assert.equal(commands.slice(1).every((item) => item.cwd === evaluatorRoot), true);
    const baselineCommands = commands.filter((item) => item.args[2] === 'BASELINE');
    const candidateCommands = commands.filter((item) => item.args[2] === 'CANDIDATE');
    assert.equal(baselineCommands.every((item) => item.args[4] === stagedBaseline), true);
    assert.equal(candidateCommands.every((item) => item.args[4] === path.join(stagedCandidate, 'candidate.txt')), true);
    const measurements = store.listMeasurements(experiment.experiment_id);
    assert.equal(measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE').length, 6);
    assert.equal(measurements.filter((item) => item.kind === 'PERFORMANCE_MEDIAN').length, 2);
    assert.deepEqual(
      measurements.find((item) => item.kind === 'CORRECTNESS_CASE')?.domain_payload.parameters,
      { n: 17, incx: 1, incy: 2, alpha: 0.5, seed: 1, threads: 1 },
    );
    assert.equal(measurements.some((item) => Object.hasOwn(item.domain_payload.parameters as object, 'm')), false);
    assert.equal((runtime.getExperiment(experiment.experiment_id).observed_context as { evaluator: { digest: string } }).evaluator.digest, evaluatorDigest);
    assert.doesNotThrow(() => assertMeasurementTrace({ candidate, experiment: runtime.getExperiment(experiment.experiment_id),
      rows: measurements, commands, bundle: loadFormalEvaluatorBundle(evaluatorRoot) }));
    const commit = store.commitExperimentResult.bind(store);
    try {
      store.commitExperimentResult = (expected, next, outcome, localFacts) => {
        commit(expected, next, outcome, localFacts);
        throw new Error('injected lost result acknowledgement');
      };
      assert.throws(() => runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation: result,
        performance: null, factsAlreadyPersisted: true }), /injected lost result acknowledgement/);
    } finally { store.commitExperimentResult = commit; }
    const evaluated = runtime.getExperiment(experiment.experiment_id);
    assert.equal(store.listHypothesisOutcomes(task.task_id).length, 1);
    const resumed = new RpcExperimentTransitionAdapter({ backend: new RunnerClientExperimentExecutionBackend(runnerClient), runtime, pollIntervalMs: 10,
      stageCandidate: async () => { throw new Error('Recovery must not restage or delete live source directories'); },
      stageEvaluator: async () => { throw new Error('Recovery must use the persisted execution plan'); },
      stageBaseline: async () => { throw new Error('Recovery must not replace the baseline'); } });
    const recovered = await resumed.executeValidation({ experimentId: experiment.experiment_id, workspace, build, testpack,
      sourceRoot: localRepository, includePerformance: true, resume: true });
    assert.equal(recovered.passed, true);
    assert.deepEqual(runtime.getExperiment(experiment.experiment_id), evaluated, 'reconciliation preserves the Control evaluation');
    const outcomeBeforeReplay = store.listHypothesisOutcomes(task.task_id);
    const replayed = runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation: recovered,
      performance: null, factsAlreadyPersisted: true });
    assert.deepEqual(replayed, evaluated, 'replaying the same result retains the original experiment and timestamps');
    assert.deepEqual(store.listHypothesisOutcomes(task.task_id), outcomeBeforeReplay);
    assert.deepEqual(store.listCommandExecutions(experiment.experiment_id), commands);
    assert.deepEqual(store.listMeasurements(experiment.experiment_id), measurements);
    assert.equal(store.listExperiments(task.task_id).length, 1, 'reconnecting observes the original execution');
  } finally {
    if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
    await replacement?.close();
    await server.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('SAXPY domain reuses Optimization Runtime, Candidate, RPC Runner, Experiment, and Evidence paths', () => verifyRpcTransition());

test('RPC failure preserves Candidate identity and raw correctness FAIL without reported threads', () => verifyRpcTransition('CORRECTNESS'));

test('cancel during submission preserves an unconfirmed experiment and never replays it after a 404', () => verifyRpcTransition(undefined, 'aborted'));
test('cancel racing with a rejection still checks the original experiment', () => verifyRpcTransition(undefined, 'aborted-400'));
test('a server error after submission checks the original experiment', () => verifyRpcTransition(undefined, '500'));
test('a duplicate experiment response checks the original experiment', () => verifyRpcTransition(undefined, '409'));
test('an existing Runner plan is never restaged or submitted', () => verifyRpcTransition(undefined, 'preexisting-plan'));
test('new formal execution reports an upgrade requirement before staging on an old Runner', () => verifyRpcTransition(undefined, 'old-runner'));
test('new formal execution requires artifact path verification before staging', () => verifyRpcTransition(undefined, 'old-artifact-check'));
test('an explicitly rejected plan retains its diagnostic', () => verifyRpcTransition(undefined, 'rejected'));
test('a real Runner keeps the original job when an accepted POST response is lost during cancellation', () => verifyRpcTransition(undefined, 'http-lost'));
test('progress persistence failure during cancellation stays unknown', () => verifyRpcTransition(undefined, 'progress-error'));
test('failed status and UNKNOWN writes still surface an unknown outcome to the workflow', () => verifyRpcTransition(undefined, 'sync-and-unknown-error'));
