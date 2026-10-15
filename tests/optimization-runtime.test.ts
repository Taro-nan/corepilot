import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { PiAgentRuntimeResult } from '../src/agent/pi-agent-runtime.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { SqliteTaskStore } from '../src/storage/sqlite-task-store.js';
import type { PublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import { runPublicAgentWorkflow } from '../src/workflow/public-agent-workflow.js';
import type { CommandRunResult, PerformanceGateResult, ValidationCycleResult } from '../src/workspace/validation-runner.js';
import { hypothesisProposal, proposeFixtureHypothesis } from './hypothesis-fixture.js';

function command(name: string, ok = true): CommandRunResult {
  const started = new Date().toISOString();
  return {
    command: process.execPath,
    args: ['-e', `console.log(${JSON.stringify(name)})`],
    cwd: process.cwd(),
    start_time: started,
    end_time: started,
    timeout_ms: 10_000,
    ok,
    exit_code: ok ? 0 : 1,
    timed_out: false,
    cancelled: false,
    stdout: `${name}\n`,
    stderr: ok ? '' : `${name} failed\n`,
    duration_ms: 5,
  };
}

function validation(label: string): ValidationCycleResult {
  return {
    build: command(`${label}-build`),
    correctness: command(`${label}-correctness`),
    correctness_cases: [{
      case_id: 'case-1',
      parameters: { size: 16 },
      status: 'PASSED',
      error: null,
      command: command(`${label}-case-1`),
    }],
    correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true },
    formal_correctness_complete: true,
    performance: command(`${label}-performance`),
    passed: true,
  };
}

function performance(): PerformanceGateResult {
  return {
    passed: true,
    weighted_geomean: 1.25,
    overall_ci_lower: 1.2,
    key_case_ci_lower: 1.2,
    case_ratios: { workload_1: 1.25 },
    workloads: [{
      case_id: 'workload_1',
      baseline_samples: [10, 11, 9],
      candidate_samples: [8, 9, 7],
      baseline_median: 10,
      candidate_median: 8,
      speedup: 1.25,
      critical: true,
      regression: false,
    }],
    reason: 'performance thresholds satisfied',
  };
}

test('persists multiple candidates, experiments, command facts, and raw samples across reopen', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-runtime-'));
  const dbPath = path.join(root, 'runtime.sqlite');
  let store = new SqliteTaskStore(dbPath);
  store.init();
  let runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({
    workflowId: 'workflow:test',
    target: { kind: 'kernel', name: 'example', scope: {} },
    sourceBaseline: { id: 'git:baseline' },
    performanceBaseline: { id: 'baseline:binary', digest: 'abc' },
    evaluator: { id: 'evaluator:test', digest: 'def' },
    declaredContext: { cpu_set: '0' },
  });

  const workspace = {
    repository: root,
    baseline_commit: 'baseline',
    run_id: 'run',
    editing: path.join(root, 'editing'),
    validation: path.join(root, 'validation'),
    editing_created: true,
    validation_created: true,
    candidate_commit: 'candidate-1',
    candidate_tree: 'tree-1',
  };
  const first = runtime.recordCandidate({
    taskId: task.task_id,
    hypothesisId: proposeFixtureHypothesis(runtime, task.task_id, 'first attempt').hypothesis_id,
    workspace,
    checkpoint: { commit: 'candidate-1', tree: 'tree-1', source_archive_sha256: 'archive-1', files: [] },
    hypothesis: 'first attempt',
    agentIdentity: { model: 'test-model' },
  });
  const firstExperiment = runtime.startExperiment({ taskId: task.task_id, candidateId: first.candidate_id, type: 'FORMAL_EVALUATION' });
  runtime.completeValidationExperiment({ experimentId: firstExperiment.experiment_id, validation: validation('first'), performance: performance() });

  workspace.candidate_commit = 'candidate-2';
  workspace.candidate_tree = 'tree-2';
  const second = runtime.recordCandidate({
    taskId: task.task_id,
    hypothesisId: proposeFixtureHypothesis(runtime, task.task_id, 'second attempt', ['kernel.c'], first.hypothesis_id).hypothesis_id,
    workspace,
    checkpoint: { commit: 'candidate-2', tree: 'tree-2', source_archive_sha256: 'archive-2', files: [] },
    hypothesis: 'second attempt',
    agentIdentity: { model: 'test-model' },
  });
  const secondExperiment = runtime.startExperiment({ taskId: task.task_id, candidateId: second.candidate_id, type: 'FORMAL_EVALUATION' });
  runtime.completeValidationExperiment({ experimentId: secondExperiment.experiment_id, validation: validation('second'), performance: performance() });
  store.close();

  store = new SqliteTaskStore(dbPath);
  store.init();
  runtime = new OptimizationRuntime(store);
  const candidates = store.listCandidates(task.task_id);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].parent_candidate_id, candidates[0].candidate_id);
  assert.deepEqual(candidates.map((item) => item.sequence), [1, 2]);
  const experiments = store.listExperiments(task.task_id);
  assert.equal(experiments.length, 2);
  assert.ok(experiments.every((item) => item.status === 'SUCCEEDED' && item.validity === 'VALID'));

  const commands = store.listCommandExecutions(secondExperiment.experiment_id);
  assert.equal(commands.length, 3);
  assert.ok(commands.every((item) => item.command && item.cwd && item.start_time && item.end_time));
  assert.ok(commands.every((item) => item.command_execution_id.startsWith('command-execution:')));
  assert.deepEqual(commands.map((item) => item.step), ['BUILD', 'CORRECTNESS', 'PERFORMANCE']);
  assert.equal(commands[0].stdout, 'second-build\n');
  assert.equal(commands[1].stdout, 'second-case-1\n');
  assert.equal(commands[2].stderr, '');
  const measurements = store.listMeasurements(secondExperiment.experiment_id);
  assert.deepEqual(
    measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE' && item.role === 'BASELINE').map((item) => item.value),
    [10, 11, 9],
  );
  assert.deepEqual(
    measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE' && item.role === 'CANDIDATE').map((item) => item.value),
    [8, 9, 7],
  );
  assert.equal(experiments[1].evaluation?.performance_workloads?.[0].baseline_median, 10);
  assert.equal(experiments[1].evaluation?.performance_workloads?.[0].candidate_median, 8);
  assert.equal(experiments[1].evaluation?.performance_workloads?.[0].speedup, 1.25);
  assert.ok(measurements.every((item) => item.subject_id && item.validity === 'VALID'));
  assert.equal(measurements.find((item) => item.kind === 'CORRECTNESS_CASE')?.domain_payload.parameters instanceof Object, true);
  assert.equal(runtime.getTask(task.task_id).task_id, task.task_id);
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the public optimization workflow appends candidate and experiment facts on every round', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phyopt-public-runtime-'));
  const repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  assert.equal(spawnSync('git', ['-C', repository, 'init', '--initial-branch=main'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', repository, 'config', 'user.email', 'test@example.invalid'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', repository, 'config', 'user.name', 'PhyOpt Test'], { encoding: 'utf8' }).status, 0);
  fs.writeFileSync(path.join(repository, 'kernel.c'), 'int example(void) { return 0; }\n');
  assert.equal(spawnSync('git', ['-C', repository, 'add', '.'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('git', ['-C', repository, 'commit', '-m', 'baseline'], { encoding: 'utf8' }).status, 0);

  const testpack = publicLoopTestpack(repository);
  const config = {
    model: { model_id: 'test-model', api_key: 'not-used', endpoint: 'https://example.invalid/v1', timeout_ms: 10_000 },
    target: { ssh_alias: 'test-target', workspace_root: '/tmp/phyopt' },
    build: { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', environment: {}, timeout_ms: 10_000 },
    validation: { testpack: path.join(root, 'testpack.yaml') },
    output_dir: path.join(root, 'output'),
  } as const;
  const preflight: PublicOptimizationPreflight = {
    request: { function_name: 'example', entry_file: 'kernel.c', config_path: path.join(root, 'phyopt.yaml'), repository_root: repository },
    config: { config, configPath: path.join(root, 'phyopt.yaml'), configDir: root, rawSha256: 'config-digest' },
    testpack: { testpack, testpackPath: path.join(root, 'testpack.yaml'), testpackDir: root, rawSha256: 'evaluator-digest' },
    credential: { apiKey: 'not-used', source: 'cli' },
    audit: { function_name: 'example', entry_file: 'kernel.c', config_path: path.join(root, 'phyopt.yaml'), repository_root: repository, config_sha256: 'config-digest', config, testpack: {} },
  };

  const store = new SqliteTaskStore(path.join(root, 'runtime.sqlite'));
  store.init();
  const runtime = new OptimizationRuntime(store);
  const task = runtime.createTask({
    workflowId: 'workflow:public-loop',
    target: { kind: 'software_function', name: 'example', scope: {} },
    sourceBaseline: { id: 'git:baseline' },
    performanceBaseline: { id: 'baseline:test' },
    evaluator: { id: 'evaluator:test' },
    declaredContext: {},
  });
  let round = 0;
  const result = await runPublicAgentWorkflow({
    preflight,
    repository,
    worktreeRoot: path.join(root, 'worktrees'),
    runId: 'public-loop',
    maxRounds: 2,
    reasoning: {
      history: () => runtime.reasoningHistory(task.task_id),
      propose: (proposal, parentHypothesisId) => runtime.proposeHypothesis({ taskId: task.task_id, parentHypothesisId, proposal, agentIdentity: { model: 'test-model' } }),
      abandon: (hypothesisId, reason) => runtime.abandonHypothesis(task.task_id, hypothesisId, reason),
    },
    runAgent: async (tools, prompt): Promise<PiAgentRuntimeResult> => {
      round += 1;
      if (round === 1) await tools.find(tool => tool.name === 'record_hypothesis')!.execute('proposal', { parent_hypothesis_id: null, ...hypothesisProposal('test hypothesis') });
      if (round > 1) {
        const previousCandidate = store.listCandidates(task.task_id).at(-1)!;
        const previousExperiment = store.listExperiments(task.task_id).at(-1)!;
        assert.ok(prompt.includes(previousCandidate.candidate_id));
        assert.ok(prompt.includes(previousExperiment.experiment_id));
        assert.match(prompt, /Candidate Evaluation Feedback/);
        assert.match(prompt, /Optimization Reasoning History/);
        assert.ok(prompt.includes(previousCandidate.hypothesis_id));
        await tools.find(tool => tool.name === 'record_candidate_decision')!.execute(`repair-${round}`, {
          candidate_id: previousCandidate.candidate_id,
          experiment_id: previousExperiment.experiment_id,
          action: 'REPAIR',
          reason: 'Repair the source using the recorded correctness failure.',
        });
      }
      const replace = tools.find((tool) => tool.name === 'replace_text');
      const changed = await replace?.execute(`replace-${round}`, {
        path: 'kernel.c',
        old_text: `return ${round - 1}`,
        new_text: `return ${round}`,
      }, new AbortController().signal);
      assert.equal(changed?.content[0]?.type, 'text');
      return { ok: true, text: `round ${round} hypothesis`, hypothesis: `round ${round} hypothesis`, development_findings: null, no_source_mutation: false, turns: 1, tool_calls: 1, messages: [], error: null };
    },
    lifecycle: {
      candidateCheckpointed: ({ workspace, checkpoint, agent }) => runtime.recordCandidate({
        taskId: task.task_id,
        hypothesisId: agent.hypothesis_id!,
        workspace,
        checkpoint,
        hypothesis: agent.hypothesis ?? agent.text,
        agentIdentity: { model: 'test-model' },
      }).candidate_id,
      experimentStarted: ({ candidateId }) => runtime.startExperiment({ taskId: task.task_id, candidateId, type: 'FORMAL_EVALUATION' }).experiment_id,
      experimentCompleted: ({ experimentId, validation: result_, performance: performance_ }) => {
        runtime.completeValidationExperiment({ experimentId, validation: result_, performance: performance_ });
      },
      revalidationStarted: ({ candidateId }) => runtime.startExperiment({ taskId: task.task_id, candidateId, type: 'REVALIDATION' }).experiment_id,
      revalidationCompleted: ({ experimentId, revalidation: result_ }) => {
        runtime.completeRevalidationExperiment({ experimentId, revalidation: result_ });
      },
      experimentFailed: ({ experimentId, error, cancelled, remoteStateUnknown }) => {
        runtime.failExperiment({ experimentId, error, cancelled, remoteStateUnknown });
      },
    },
  });

  assert.equal(result.status, 'WAITING_APPROVAL');
  assert.equal(round, 2);
  const candidates = store.listCandidates(task.task_id);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].parent_candidate_id, candidates[0].candidate_id);
  assert.equal(candidates[1].hypothesis_id, candidates[0].hypothesis_id);
  assert.equal(store.listHypotheses(task.task_id).length, 1);
  const experiments = store.listExperiments(task.task_id);
  assert.equal(experiments.length, 3);
  assert.deepEqual(experiments.map((item) => item.type), ['FORMAL_EVALUATION', 'FORMAL_EVALUATION', 'REVALIDATION']);
  assert.equal(experiments[0].evaluation?.correctness, 'FAILED');
  assert.equal(experiments[0].failure_category, 'CORRECTNESS_FAILURE');
  assert.equal(experiments[1].evaluation?.correctness, 'PASSED');
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function publicLoopTestpack(repository: string): ValidationTestpack {
  const success = { executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: repository, environment: {}, timeout_ms: 10_000 };
  return {
    schema_version: 1,
    testpack_id: 'public-loop',
    function_name: 'example',
    function_family: 'test',
    operation: 'test',
    data_type: 'test',
    resources: { cpu_set: '0', numa_nodes: [0], thread_counts: [1] },
    correctness: {
      command: {
        executable: process.execPath,
        args: ['-e', "const fs=require('node:fs'); process.exit(fs.readFileSync('kernel.c','utf8').includes('return 2') ? 0 : 7)"],
        cwd: repository,
        environment: {},
        timeout_ms: 10_000,
      },
      cases: [{ case_id: 'case-1', m: 1, n: 1, threads: 1, seed: 1, critical: true, weight: 1, args: ['case-1'] }],
      pass_required: 1,
    },
    performance: {
      command: success,
      cases: [{ case_id: 'performance-1', m: 1, n: 1, threads: 1, seed: 2, critical: true, weight: 1 }],
      sampling: { warmup: 0, samples: 1, interleave_seed: 1, bootstrap_iterations: 1 },
      baselines: {
        current: { id: 'current', library: 'test', version: '1', sha256: '0'.repeat(64), path: repository },
        comparison: { id: 'comparison', library: 'test', version: '1', sha256: '1'.repeat(64), path: repository },
      },
      thresholds: { weighted_geomean_min: 1, overall_ci_lower_min: 1, key_case_ci_lower_min: 1, confidence_level: 0.95 },
      key_cases: ['performance-1'],
    },
    revalidation: {
      formal: { required: false, timeout_ms: 10_000, command: success },
      independent: { required: false, timeout_ms: 10_000, command: success },
    },
  };
}
