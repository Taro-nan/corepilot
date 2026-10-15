import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunnerClient } from '../src/client/runner-client.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { RunnerClientExperimentExecutionBackend } from '../src/core/experiment-execution-backend.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { RpcExperimentTransitionAdapter } from '../src/core/rpc-experiment-transition-adapter.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { evaluatorBundleSha256 } from '../src/evaluator/formal-evaluator.js';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { CandidateWorkspaceState } from '../src/workspace/candidate-workspace.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { candidateEvaluationFeedback } from '../src/workspace/candidate-evaluation-feedback.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';

async function verifyRpcTransition(omitThreads?: 'CORRECTNESS') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-rpc-transition-'));
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
  const build = { executable: process.execPath, args: ['-e', "require('node:fs').readFileSync('candidate.txt')"], cwd: localRepository, environment: {}, timeout_ms: 5_000 };
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
        args: ['-e', "const fs=require('node:fs');fs.readFileSync('oracle.txt');fs.readFileSync(process.env.PHYOPT_CANDIDATE_ROOT+'/candidate.txt')"],
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
  const runnerClient = new RunnerClient({ baseUrl: server.url, token });
  let baselineStageCalls = 0;
  const adapter = new RpcExperimentTransitionAdapter({
    backend: new RunnerClientExperimentExecutionBackend(runnerClient),
    runtime,
    pollIntervalMs: 10,
    stageCandidate: async () => ({ candidateId: candidate.candidate_id, workspacePath: stagedCandidate, sourceSha256: candidateDigest }),
    stageEvaluator: async () => ({ evaluatorId: evaluator.id, version: evaluator.version, workspacePath: evaluatorRoot, digest: evaluatorDigest }),
    stageBaseline: async ({ baseline }) => {
      baselineStageCalls += 1;
      return { baselineId: baseline.id, workspacePath: stagedBaseline, sha256: candidateArtifactDigest };
    },
  });

  try {
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
  } finally {
    await server.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('SAXPY domain reuses Optimization Runtime, Candidate, RPC Runner, Experiment, and Evidence paths', () => verifyRpcTransition());

test('RPC failure preserves Candidate identity and raw correctness FAIL without reported threads', () => verifyRpcTransition('CORRECTNESS'));
