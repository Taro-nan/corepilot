import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectRecord } from '../contracts/project.js';
import type { ResolvedExecutionMachine } from '../contracts/execution-machine.js';
import type { ExperimentExecutionPlan, ExperimentExecutionStep } from '../contracts/runner-rpc.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION, type Experiment } from '../contracts/optimization-domain.js';
import type { TestingPreparedSubject, TestingTaskRecord } from '../contracts/testing.js';
import type { RemoteValidationTransport } from '../workspace/validation-runner.js';
import { stageRemoteDevelopmentAssets } from '../core/development-investigation.js';
import { createFormalEvaluatorSteps } from '../evaluator/formal-plan.js';
import { expandCpuSet } from '../evaluator/validation-test-plan.js';
import type { TestingStore } from '../storage/testing-store.js';
import type { TestingAssetService } from './testing-assets.js';
import { freezeSourceSubject, stageBinarySubject, stageSourceSubject, type TestingBinaryStager, type TestingRunner, type TestingSubjectContext } from './testing-subjects.js';
import type { ResolvedTestingPlan } from './testing-plan.js';

export interface TestingPreparation {
  store: TestingStore;
  taskId: string;
  resolved: ResolvedTestingPlan;
  assets: TestingAssetService;
  projects: { get(id: string): ProjectRecord };
  machine: ResolvedExecutionMachine;
  runner: TestingRunner;
  transport: RemoteValidationTransport;
  stageBinary: TestingBinaryStager;
  signal: AbortSignal;
}
export function testingConnectionKey(machine: ResolvedExecutionMachine): string {
  return createHash('sha256').update(JSON.stringify({ runner: machine.runner, target: machine.target })).digest('hex');
}
function phase(context: TestingPreparation, name: string, message: string): TestingTaskRecord {
  context.signal.throwIfAborted();
  if (context.store.task(context.taskId).execution.cancel_requested) throw new Error('测试准备已取消。');
  return context.store.updateTask(context.taskId, record => { record.execution.phase = name; record.execution.message = message; });
}
function subjectIdentity(subject: TestingPreparedSubject) {
  return { id: subject.kind === 'source' ? `source:${subject.version}` : `binary:${subject.asset_id}`, version: subject.version,
    ...(subject.artifact_sha256 ? { digest: subject.artifact_sha256 } : {}) };
}

/** Prepare two explicit subjects, then submit exactly one existing Runner experiment. */
export async function prepareTestingExecution(context: TestingPreparation): Promise<void> {
  let record = context.store.task(context.taskId);
  const buildSteps: ExperimentExecutionStep[] = [];
  const shared = { projects: context.projects, resolved: context.resolved, assets: context.assets, machine: context.machine,
    runner: context.runner, stageBinary: context.stageBinary, signal: context.signal };
  for (const role of ['candidate', 'baseline'] as const) {
    const subject = record.input[role];
    if (subject?.kind !== 'source') continue;
    phase(context, 'FREEZING_SOURCE', `正在固定${role === 'candidate' ? '被测' : '比较'}源码版本`);
    const pinned = await freezeSourceSubject(subject, { ...shared, remoteRoot: path.posix.join(record.workspace.run_root, 'subjects', role) });
    context.signal.throwIfAborted();
    context.store.updateTask(context.taskId, task => { task.subjects[role] = pinned; });
  }
  record = phase(context, 'CHECKING_MACHINE', '正在核对执行机器、资源与 Runner 能力');
  const probe = await context.runner.probe(context.signal);
  if (probe.health.resource_enforcement !== 'REQUIRED' || probe.health.capabilities?.controlled_validation !== 1) throw new Error('执行机器需要支持受控测试并启用资源约束，请由维护者更新 Runner。');
  if (record.input.candidate.kind === 'source' || record.input.baseline?.kind === 'source') {
    if (probe.health.capabilities?.source_archive_upload !== 1) throw new Error('请更新执行机器 Runner，以支持固定源码归档上传。');
  }
  const testPlan = record.plan.test_plan;
  if (!testPlan.execution_matrix && !testPlan.resources.cpu_set) throw new Error('测试方案尚未指定 CPU 集合，请先完善测试条件。');
  if (testPlan.execution_matrix && probe.health.capabilities?.resource_matrix !== 1) throw new Error('请更新 Runner，以支持多线程和绑核矩阵。');
  const online = probe.machine.cpu_topology?.online_cpus;
  const available = online ? new Set(expandCpuSet(online)) : null;
  const nodes = probe.machine.cpu_topology?.node_cpu_lists;
  for (const resources of testPlan.execution_matrix?.profiles ?? [testPlan.resources]) {
    if (available && expandCpuSet(resources.cpu_set).some(cpu => !available.has(cpu))) throw new Error('测试 CPU 集合包含目标机器未上线的 CPU，请修改测试条件。');
    if (nodes && Object.keys(nodes).length) {
      const node = nodes[`node${resources.numa_node}`] ?? nodes[String(resources.numa_node)];
      if (!node || expandCpuSet(resources.cpu_set).some(cpu => !new Set(expandCpuSet(node)).has(cpu))) throw new Error('测试 CPU 集合与所选 NUMA 节点不匹配，请修改测试条件。');
    }
  }
  context.store.updateTask(context.taskId, task => { task.machine.hardware = probe.machine; task.machine.runner_id = probe.health.runner_id; });
  for (const role of ['candidate', 'baseline'] as const) {
    record = context.store.task(context.taskId);
    const subject = record.input[role]; if (!subject) continue;
    phase(context, 'STAGING_SUBJECTS', `正在准备${role === 'candidate' ? '被测' : '比较'}库及依赖`);
    const subjectContext: TestingSubjectContext = { ...shared, localRoot: path.join(context.store.taskRoot(context.taskId), role),
      remoteRoot: path.posix.join(record.workspace.run_root, 'subjects', role), machineDigest: probe.machine.machine_identity_sha256 };
    let prepared = record.subjects[role];
    if (subject.kind === 'source') {
      buildSteps.push(await stageSourceSubject(prepared!, subjectContext));
    } else prepared = await stageBinarySubject(subject, subjectContext);
    context.signal.throwIfAborted();
    context.store.updateTask(context.taskId, task => { task.subjects[role] = prepared; });
  }
  record = phase(context, 'STAGING_TESTS', '正在上传本次固定版本的测试代码与输入清单');
  const localAssets = path.join(context.store.taskRoot(context.taskId), 'evaluator');
  await stageRemoteDevelopmentAssets({ evaluatorRoot: localAssets, transport: context.transport,
    remoteWorkspace: record.workspace.assets_root, signal: context.signal });
  record = context.store.task(context.taskId);
  const candidate = record.subjects.candidate!, baseline = record.subjects.baseline ?? candidate;
  const artifact = (subject: TestingPreparedSubject) => ({ artifactId: subjectIdentity(subject).id,
    path: subject.artifact_path, sha256: subject.artifact_sha256, dependencies: subject.dependencies });
  const expanded = createFormalEvaluatorSteps({ bundle: { ...context.resolved.bundle, root: localAssets }, stagedEvaluatorRoot: record.workspace.assets_root,
    runtimeRoot: record.workspace.runtime_root, candidateArtifact: artifact(candidate), baselineArtifact: artifact(baseline),
    ...(candidate.source ? { candidateSourceRoot: candidate.source.workspace } : {}), candidateLibraryPaths: candidate.library_paths,
    baselineLibraryPaths: baseline.library_paths, correctnessTimeoutMs: 120_000, performanceTimeoutMs: 120_000,
    includePerformance: record.input.mode !== 'correctness' });
  const steps = [...buildSteps, ...expanded.filter(step => record.input.mode !== 'performance' || step.step !== 'CORRECTNESS')
    .map(step => ({ ...step, execution_domain: undefined, command: { ...step.command, environment: { ...step.command.environment,
      COREPILOT_TEST_ASSETS_ROOT: record.workspace.assets_root,
      COREPILOT_CANDIDATE_ARTIFACT: candidate.artifact_path,
      COREPILOT_BASELINE_ARTIFACT: record.subjects.baseline ? baseline.artifact_path : '',
      ...(candidate.source ? { COREPILOT_CANDIDATE_SOURCE_ROOT: candidate.source.workspace } : {}),
      ...(baseline.source ? { COREPILOT_BASELINE_SOURCE_ROOT: baseline.source.workspace } : {}) } } }))];
  if (steps.length > 2048) throw new Error('测试计划超过 2048 条命令，请减少输入、采样或资源矩阵。');
  const experiment: Experiment = { schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
    experiment_id: record.task_id, task_id: record.task_id, candidate_id: subjectIdentity(candidate).id, type: 'DEVELOPMENT_FEEDBACK',
    status: 'PENDING', validity: 'UNKNOWN', failure_category: null, evaluator: { id: record.plan.evaluator.id,
      version: record.plan.evaluator.version, digest: record.plan.evaluator.digest }, baseline: record.subjects.baseline ? subjectIdentity(baseline) : { id: 'none' },
    declared_context: { classification: 'INDEPENDENT_TEST', mode: record.input.mode, formal_evidence: false,
      test_plan: record.plan.test_plan, evaluator_digest: record.plan.evaluator.digest,
      machine_identity_sha256: probe.machine.machine_identity_sha256, subjects: record.subjects },
    observed_context: null, evaluation: null, started_at: null, ended_at: null, created_at: record.created_at, updated_at: new Date().toISOString() };
  const plan: ExperimentExecutionPlan = { experiment, steps, output_directory: record.workspace.logs_root };
  phase(context, 'SUBMITTING', '正在向 Runner 提交固定测试计划');
  context.store.updateTask(context.taskId, task => { task.execution.submission_attempted = true; });
  const submitted = await context.runner.submitExperiment(plan);
  if (submitted.experiment_id !== context.taskId) throw new Error('Runner 提交回执与测试任务身份不一致。');
  record = context.store.updateTask(context.taskId, task => { task.execution.status = 'PENDING'; task.execution.phase = 'SUBMITTED';
    task.execution.message = '测试计划已提交，等待 Runner 执行。'; });
  if (record.execution.cancel_requested) await context.runner.cancelExperiment(context.taskId);
}
