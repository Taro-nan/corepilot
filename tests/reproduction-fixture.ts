import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startRunnerHttpServer } from '../src/runner/http-server.js';
import { RunnerClient } from '../src/client/runner-client.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { createCandidateWorkspace, checkpointCandidate } from '../src/workspace/candidate-workspace.js';
import { runValidationCommand } from '../src/workspace/validation-runner.js';
import { sourceTreeSha256 } from '../src/core/source-identity.js';
import { createFormalEvaluatorFixture } from './formal-evaluator-fixture.js';
import { loadFormalEvaluatorBundle } from '../src/evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../src/evaluator/formal-plan.js';
import { freezeValidationTestpack } from '../src/testpack/validation-freeze.js';
import { initialOptimizationWorkflowRecord } from '../src/workflow/optimization-workflow.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';
import type { ExperimentExecutionPlan } from '../src/contracts/runner-rpc.js';
import type { ValidationTestpack } from '../src/contracts/validation-testpack.js';
import type { startWebFixture } from './web-fixture.js';

/** Real HTTP, process execution, Git and SQLite. Resource observations and timings are fixtures, never hardware evidence. */
export async function prepareReproductionFixture(f: Awaited<ReturnType<typeof startWebFixture>>, options: { buildGate?: string; resourceEnforcement?: 'REQUIRED' | 'DISABLED' } = {}) {
  const runnerRoot = path.join(f.root, 'runner'); fs.mkdirSync(runnerRoot);
  const runner = await startRunnerHttpServer({ host: '127.0.0.1', port: 0, token: 'fixture-runner', dbPath: path.join(runnerRoot, 'runner.sqlite'), workspaceRoot: runnerRoot,
    resourceEnforcement: options.resourceEnforcement ?? 'REQUIRED', formalResourceCommandRunner: async (command, resources, signal) => {
      const threads = String(resources.threads), node = String(resources.numa_node);
      return { result: await runValidationCommand(command, command.cwd, { signal }), resourceContext: { declared: resources,
        applied: { cpu_affinity: { mechanism: 'taskset', cpu_set: resources.cpu_set }, numa_policy: { mechanism: 'numactl', policy: 'bind', cpu_nodes: node, memory_nodes: node },
          thread_configuration: { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads } },
        observed: { cpu_set: resources.cpu_set, child_cpu_set: resources.cpu_set, mems_allowed_list: node,
          numa_policy: { policy: 'bind', cpu_nodes: node, node_bind: node, memory_nodes: node }, thread_configuration: { OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, GOTO_NUM_THREADS: threads },
          max_runtime_threads: resources.threads, runtime_thread_observation: 'OBSERVED' }, enforcement: { cpu_set: 'ENFORCED', numa_node: 'ENFORCED', threads: 'ENFORCED' }, validity: 'VALID', errors: [] } };
    } });
  const client = new RunnerClient({ baseUrl: runner.url, token: 'fixture-runner' });
  const machine = await client.probe();
  const evaluator = createFormalEvaluatorFixture(path.join(f.root, 'evaluator'), { domain: 'saxpy', warmupCount: 0, sampleCount: 3 });
  const bundle = loadFormalEvaluatorBundle(evaluator.root, { requireQualified: true });
  const runtime = new OptimizationRuntime(f.store);
  const task = runtime.createTask({ workflowId: 'workflow:reproduction', target: { kind: 'kernel', name: 'kernel', scope: {} }, sourceBaseline: { id: 'fixture-git' },
    performanceBaseline: { id: 'fixture-baseline' }, evaluator: { id: bundle.manifest.evaluator_id, version: bundle.manifest.version, digest: evaluator.digest }, declaredContext: {} });
  const workspace = createCandidateWorkspace({ repository: f.repo, worktreeRoot: path.join(f.root, 'worktrees'), runId: 'reproduce', baselineCommit: f.git('rev-parse', 'HEAD') });
  fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'int kernel(void) { return 2; }\n');
  const checkpoint = checkpointCandidate(workspace);
  const hypothesis = proposeFixtureHypothesis(runtime, task.task_id, 'Fold source expression', ['kernel.c']);
  const candidate = runtime.recordCandidate({ taskId: task.task_id, hypothesisId: hypothesis.hypothesis_id, workspace, checkpoint, hypothesis: hypothesis.description, agentIdentity: { fixture: true } });
  const oldSource = path.join(runnerRoot, 'original', 'source'), oldBuild = path.join(runnerRoot, 'original', 'build');
  fs.mkdirSync(path.join(runnerRoot, 'original'), { recursive: true });
  const baseline = path.join(runnerRoot, 'original', 'baseline.bin'); fs.writeFileSync(baseline, 'baseline fixture');
  const baselineSha = createHash('sha256').update(fs.readFileSync(baseline)).digest('hex');
  const artifact = path.join(oldBuild, 'kernel.bin');
  const buildScript = `const fs=require('node:fs');const build=${JSON.stringify(oldBuild)};if(fs.existsSync(build)&&fs.readdirSync(build).length)throw Error('build directory reused');fs.mkdirSync(build,{recursive:true});
    ${options.buildGate ? `while(!fs.existsSync(${JSON.stringify(options.buildGate)}))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);` : ''}
    fs.writeFileSync(${JSON.stringify(artifact)}, fs.readFileSync('kernel.c'));console.log('fresh build completed');`;
  const experiment = runtime.startExperiment({ taskId: task.task_id, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION', initialStatus: 'PENDING' });
  const plan: Omit<ExperimentExecutionPlan, 'experiment'> = {
    candidate: { candidate_id: candidate.candidate_id, commit: checkpoint.commit, tree: checkpoint.tree, source_sha256: sourceTreeSha256(workspace.validation), workspace_path: oldSource },
    evaluator: { evaluator_id: bundle.manifest.evaluator_id, version: bundle.manifest.version, digest: evaluator.digest, workspace_path: evaluator.root },
    build_directory: oldBuild, output_directory: path.join(runnerRoot, 'original', 'logs'),
    steps: [{ step: 'BUILD', execution_domain: 'CANDIDATE', command: { executable: process.execPath, args: ['-e', buildScript], cwd: oldSource, environment: {}, timeout_ms: 15000 } },
      ...createFormalEvaluatorSteps({ bundle, stagedEvaluatorRoot: evaluator.root, runtimeRoot: path.join(runnerRoot, 'original', 'runtime'),
        candidateArtifact: { artifactId: candidate.candidate_id, path: artifact, sha256: null }, baselineArtifact: { artifactId: 'fixture-baseline', path: baseline, sha256: baselineSha },
        correctnessTimeoutMs: 10000, performanceTimeoutMs: 10000, includePerformance: true })] };
  f.store.saveExperiment({ ...experiment, status: 'SUCCEEDED', validity: 'VALID', ended_at: experiment.created_at,
    observed_context: { machine: machine.machine }, declared_context: { runner_execution_plan: plan } });
  const config = JSON.parse(fs.readFileSync(f.configPath, 'utf8'));
  config.runner = { mode: 'rpc', endpoint: runner.url, token: 'fixture-runner' }; config.target.workspace_root = runnerRoot;
  fs.writeFileSync(f.configPath, JSON.stringify(config));
  const pack = JSON.parse(fs.readFileSync(config.validation.testpack, 'utf8')) as ValidationTestpack;
  pack.evaluator = { id: bundle.manifest.evaluator_id, version: bundle.manifest.version, owner: 'test-owner', sha256: evaluator.digest, root: evaluator.root };
  pack.correctness.cases = [{ case_id: 'case-1', parameters: evaluator.caseDefinition.parameters, threads: 1, critical: true, weight: 1, args: [] }];
  pack.performance.cases = [{ case_id: 'workload-1', parameters: evaluator.workload.parameters, threads: 1, critical: true, weight: 1 }];
  pack.performance.key_cases = ['workload-1'];
  freezeValidationTestpack(pack, path.join(f.root, 'frozen'));
  const record = initialOptimizationWorkflowRecord('workflow:reproduction', { functionName: 'kernel', entryFile: 'kernel.c', repositoryRoot: f.repo, configPath: f.configPath, enablePerformance: true });
  Object.assign(record, { status: 'WAITING_APPROVAL', candidate_id: candidate.candidate_id, optimization_task_id: task.task_id,
    candidate_commit: checkpoint.commit, candidate_tree: checkpoint.tree, baseline_commit: workspace.baseline_commit,
    workspace_editing: workspace.editing, workspace_validation: workspace.validation, testpack_snapshot_path: path.join(f.root, 'frozen', 'validation-testpack.json') });
  f.store.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
  return { record, candidate, experiment, plan, client, runner, runnerRoot, artifact, baseline, checkpoint, workspace };
}
