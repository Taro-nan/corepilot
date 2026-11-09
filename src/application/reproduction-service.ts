import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { SqliteOptimizationWorkflowStore } from '../workflow/optimization-workflow.js';
import type { ExperimentExecutionPlan, ExperimentStatusResponse } from '../contracts/runner-rpc.js';
import { OptimizationRuntime } from '../core/optimization-runtime.js';
import { isRunnerSubmissionRejected } from '../core/experiment-execution-backend.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import { loadOptimizationConfig, resolveRunnerConfig } from '../config/optimization-config.js';
import { isRegisteredRunner } from '../config/runner-config.js';
import { ExecutionMachineService } from './execution-machine-service.js';
import { readFrozenValidationTestpack } from '../testpack/validation-freeze.js';
import { exportGitSourceArchive } from '../workspace/git-source-archive.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { validationCycleFromCommandExecutions, evaluatePerformanceGate, parsePerformanceMeasurements } from '../workspace/validation-runner.js';
import { withRunnerValidationStatus } from '../workspace/validation-outcome.js';
import { redactRecord } from '../report/optimization-report.js';

const execute = promisify(execFile);
type Job = NonNullable<OptimizationWorkflowRecord['reproduction']>;
const unfinished = (job?: Job) => !!job && ['PREPARING', 'RUNNING', 'UNKNOWN'].includes(job.status);

/** Rebuild a frozen Candidate using its saved RPC plan; uses the same Runtime, Runner and evaluation functions. */
export class ReproductionService {
  private readonly runtime: OptimizationRuntime;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly store: TaskStore, private readonly records: Pick<SqliteOptimizationWorkflowStore, 'get' | 'save'>) { this.runtime = new OptimizationRuntime(store); }

  manifest(workflowId: string) {
    const record = this.required(workflowId);
    const candidate = record.candidate_id ? this.runtime.getCandidate(record.candidate_id) : null;
    const experiments = record.optimization_task_id ? this.store.listExperiments(record.optimization_task_id).filter(row => row.candidate_id === record.candidate_id) : [];
    const original = experiments.filter(row => row.type === 'FORMAL_EVALUATION' && row.declared_context.runner_execution_plan).at(-1);
    return redactRecord({ schema_version: 1, workflow_id: workflowId, source: candidate?.source ?? null, comparison: original?.baseline ?? null,
      evaluator: original?.evaluator ?? null, machine: original?.observed_context?.machine ?? null,
      build_and_test_plan: original?.declared_context.runner_execution_plan ?? null, testpack_snapshot: record.testpack_snapshot_path ?? null,
      reproduction: record.reproduction ?? null, delivery: record.delivery ?? null,
      unlinked_reproductions: experiments.filter(row => row.declared_context.purpose === 'DELIVERY_REPRODUCTION'
        && ['PENDING', 'RUNNING', 'UNKNOWN'].includes(row.status) && row.experiment_id !== record.reproduction?.experiment_id)
        .map(row => ({ experiment_id: row.experiment_id, status: row.status, reproduction_of: row.declared_context.reproduction_of ?? null })),
      command: `corepilot workflow reproduce ${workflowId}`,
      note: 'Reproduction creates a new independent REVALIDATION experiment, exports the frozen Git commit into a new Runner directory and builds there. It never calls a model or rewrites delivery/approval records. Saved baseline/evaluator identities are required.' });
  }

  start(workflowId: string) {
    const expectedWorkflowJson = this.store.getOptimizationWorkflowJson(workflowId);
    if (!expectedWorkflowJson) throw new Error('workflow not found');
    const record = JSON.parse(expectedWorkflowJson) as OptimizationWorkflowRecord;
    if (record.delivery_operation && record.delivery_operation.status !== 'COMPLETED') throw new Error('当前交付尚未结束，请先核对交付状态再重建复现。');
    if (this.active.has(workflowId)) return record.reproduction!;
    if (['CREATED', 'GENERATING'].includes(record.status)) throw new Error('优化任务仍在执行，请等待当前作业结束后再重建复现');
    if (!record.candidate_id || !record.optimization_task_id || !record.repository_root || !record.testpack_snapshot_path) throw new Error('任务缺少冻结候选、源码仓库或测试快照，不能重建复现');
    const candidate = this.runtime.getCandidate(record.candidate_id);
    const experiments = this.store.listExperiments(record.optimization_task_id).filter(row => row.candidate_id === record.candidate_id);
    const unresolved = experiments.find(row => ['PENDING', 'RUNNING', 'UNKNOWN'].includes(row.status) && row.experiment_id !== record.reproduction?.experiment_id);
    if (unresolved) {
      const detail = unresolved.declared_context.purpose === 'DELIVERY_REPRODUCTION' ? '存在未关联的历史复现实验' : '当前候选仍有未确认终态的实验';
      throw new Error(`${detail} ${unresolved.experiment_id}（${unresolved.status}），请维护者按原实验 ID 核对 Runner；系统不会自动重新提交或认定它已停止。`);
    }
    const original = experiments.filter(row => row.type === 'FORMAL_EVALUATION' && row.declared_context.runner_execution_plan).at(-1);
    if (!original) throw new Error('没有可复用的真实 RPC 执行计划；旧任务可查看报告，不能伪造复现');
    const identity = (original.observed_context?.machine as Record<string, unknown> | undefined)?.machine_identity_sha256;
    if (typeof identity !== 'string') throw new Error('原实验缺少机器身份，不能确认复现环境');
    const frozen = readFrozenValidationTestpack(record.testpack_snapshot_path);
    if (frozen.testpack.evaluator?.sha256 !== original.evaluator.digest) throw new Error('测试快照与原实验 evaluator 不一致');
    if (!unfinished(record.reproduction)) {
      const { runner_execution_plan: _plan, ...context } = original.declared_context;
      const experiment = this.runtime.prepareExperiment({ taskId: record.optimization_task_id, candidateId: candidate.candidate_id, type: 'REVALIDATION', initialStatus: 'PENDING',
        declaredContext: { ...context, purpose: 'DELIVERY_REPRODUCTION', reproduction_of: original.experiment_id } });
      const now = new Date().toISOString();
      record.reproduction = { experiment_id: experiment.experiment_id, original_experiment_id: original.experiment_id, status: 'PREPARING', phase: '准备干净源码和测试资产',
        source_commit: candidate.source.commit, evaluator_digest: original.evaluator.digest!, machine_identity: identity,
        remote_root: '', created_at: now, updated_at: now, error: null };
      record.updated_at = now;
      this.store.createReproductionExperiment(experiment, expectedWorkflowJson, JSON.stringify(record));
    }
    const experimentId = this.required(workflowId).reproduction!.experiment_id;
    const controller = new AbortController();
    const promise = this.run(workflowId, controller.signal).catch(() => {
      try { this.update(workflowId, experimentId, { status: 'UNKNOWN', error: '复现状态无法保存，请核对原实验和 Runner。' }); }
      catch { console.error(`无法保存复现状态；请核对工作流 ${workflowId.replace(/[^A-Za-z0-9:_-]/g, '_').slice(0, 160)} 的原实验。`); }
    }).finally(() => this.active.delete(workflowId));
    this.active.set(workflowId, { controller, promise });
    return this.required(workflowId).reproduction!;
  }

  async cancel(workflowId: string) {
    const record = this.required(workflowId);
    if (!record.reproduction || !unfinished(record.reproduction)) return;
    const experimentId = record.reproduction.experiment_id;
    if (!this.update(workflowId, experimentId, { cancel_requested: true })) return;
    let experiment = this.runtime.getExperiment(experimentId);
    if (this.canPrepare(experiment)) {
      const active = this.active.get(workflowId);
      if (active) { active.controller.abort('cancelled by user'); return; }
      try {
        this.runtime.failExperiment({ experimentId, error: 'cancelled before submission', cancelled: true, expectedExperiment: experiment });
        this.update(workflowId, experimentId, { status: 'CANCELLED', phase: '提交前已取消', error: null });
        return;
      } catch (error) {
        const current = this.runtime.getExperiment(experimentId);
        if (this.canPrepare(current)) throw error;
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.status)) return;
        experiment = current;
      }
    }
    const { client } = this.connection(record);
    try { await client.cancelExperiment(experiment.experiment_id); }
    catch {
      this.update(workflowId, experimentId, { status: 'UNKNOWN', error: `复现实验 ${experiment.experiment_id} 的取消尚未确认，请核对原 Runner。` });
      throw new Error('取消请求尚未确认；请核对原实验状态后继续。');
    }
  }

  async stop() { for (const active of this.active.values()) active.controller.abort('backend shutting down'); await Promise.allSettled([...this.active.values()].map(row => row.promise)); }
  private required(id: string) { const record = this.records.get(id); if (!record) throw new Error('workflow not found'); return record; }
  private update(id: string, experimentId: string, patch: Partial<Omit<Job, 'experiment_id'>>) {
    return this.store.updateReproduction(id, experimentId, patch);
  }
  private canPrepare(experiment: import('../contracts/optimization-domain.js').Experiment): boolean {
    return experiment.status === 'PENDING' && experiment.started_at === null && experiment.ended_at === null &&
      !experiment.declared_context.runner_execution_plan && !experiment.declared_context.reproduction_submission_intent &&
      !experiment.runner_terminal_facts && !this.store.listCommandExecutions(experiment.experiment_id).length &&
      !this.store.listMeasurements(experiment.experiment_id).length;
  }
  private connection(record: OptimizationWorkflowRecord) {
    const config = loadOptimizationConfig(record.config_path).config;
    const id = record.execution_machine?.machine_id ?? (isRegisteredRunner(config.runner) ? config.runner.machine_id : null);
    const machine = id ? new ExecutionMachineService(this.store).resolve(id) : null;
    const effective = machine ? { ...config, runner: machine.runner, target: machine.target } : config;
    const runner = resolveRunnerConfig(effective);
    if (runner.mode !== 'rpc') throw new Error('复现需要原机器的 RPC 连接');
    return { client: new RunnerClient({ baseUrl: runner.endpoint, token: runner.token, requestTimeoutMs: runner.requestTimeoutMs }),
      target: effective.target, secrets: [runner.token, config.model.api_key].filter((value): value is string => typeof value === 'string' && !!value) };
  }
  private async run(id: string, signal: AbortSignal) {
    const record = this.required(id), job = record.reproduction!;
    const { client, target, secrets } = this.connection(record);
    const original = this.runtime.getExperiment(job.original_experiment_id);
    const experiment = this.runtime.getExperiment(job.experiment_id);
    const frozen = readFrozenValidationTestpack(record.testpack_snapshot_path!).testpack;
    let plan = experiment.declared_context.runner_execution_plan as Omit<ExperimentExecutionPlan, 'experiment'> | undefined;
    // Any pre-existing plan may already have reached a Runner, including plans
    // written by older versions without a submission marker.
    let mayHaveSubmitted = !!plan || !!experiment.declared_context.reproduction_submission_intent || !this.canPrepare(experiment);
    let rejectedBeforeExecution = false;
    let acknowledged = false;
    try {
      if (!plan && !this.canPrepare(experiment)) throw new Error('无法证明原复现实验尚未提交，请核对原 Runner。');
      if (!plan && job.cancel_requested) {
        this.runtime.failExperiment({ experimentId: job.experiment_id, error: 'cancelled before submission', cancelled: true, expectedExperiment: experiment });
        this.update(id, job.experiment_id, { status: 'CANCELLED', phase: '提交前已取消', error: null });
        return;
      }
      const facts = await client.probe(signal);
      if (facts.machine.machine_identity_sha256 !== job.machine_identity) throw new Error('执行机器身份与原实验不一致；请恢复原机器连接');
      if (facts.health.capabilities?.exclusive_queue !== 1) throw new Error('请更新 Runner：复现要求统一排队，避免构建和采样相互干扰');
      if (facts.health.resource_enforcement !== 'REQUIRED') throw new Error('复现要求 Runner 启用资源约束与观测；请使用 resource enforcement REQUIRED');
      if (!plan) {
        const previous = original.declared_context.runner_execution_plan as Omit<ExperimentExecutionPlan, 'experiment'>;
        if (!previous.candidate || !previous.evaluator) throw new Error('原计划缺少源码或测试资产身份');
        const root = path.posix.join(target.workspace_root.replaceAll('\\', '/'), 'reproductions', id.replace(/[^A-Za-z0-9_-]/g, '_'),
          job.experiment_id.replace(/[^A-Za-z0-9_-]/g, '_'), randomUUID().replaceAll('-', ''));
        this.update(id, job.experiment_id, { status: 'PREPARING', phase: '导出冻结源码，准备全新构建目录', error: null });
        const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'corepilot-reproduce-'));
        try {
          const archive = await exportGitSourceArchive(record.repository_root!, job.source_commit, path.join(temporary, 'source.tar.gz'));
          const source = await client.uploadSourceArchive({ filename: archive.path, sha256: archive.sha256, workspacePath: path.posix.join(root, 'source') }, signal);
          if (source.source_sha256 !== previous.candidate.source_sha256) throw new Error('导出的冻结源码与原 Candidate 身份不同');
          const bundle = loadFormalEvaluatorBundle(frozen.evaluator!.root, { requireQualified: true, expected: { evaluatorId: previous.evaluator.evaluator_id, version: previous.evaluator.version, digest: previous.evaluator.digest } });
          const evaluatorArchive = path.join(temporary, 'evaluator.tar.gz');
          await execute('tar', ['-czf', evaluatorArchive, '-C', bundle.root, '.'], { windowsHide: true });
          const hash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(evaluatorArchive)).digest('hex');
          const evaluator = await client.uploadSourceArchive({ filename: evaluatorArchive, sha256: hash, workspacePath: path.posix.join(root, 'evaluator', 'source') }, signal);
          const previousRuntime = previous.steps.find(step => step.step === 'EVALUATOR_SETUP')?.command.args[1];
          if (!previousRuntime) throw new Error('原计划缺少 evaluator 运行目录，不能确认干净复现');
          const replacements = [[previous.build_directory ?? `${previous.candidate.workspace_path}.build`, path.posix.join(root, 'build')],
            [previous.candidate.workspace_path, source.workspace_path], [previous.evaluator.workspace_path, evaluator.workspace_path],
            [previousRuntime, path.posix.join(root, 'runtime')], ...(previous.output_directory ? [[previous.output_directory, path.posix.join(root, 'logs')]] : [])];
          const variants = replacements.flatMap(([from, to]) => [[from, to], [from.replaceAll('\\', '/'), to.replaceAll('\\', '/')], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]]).sort((a, b) => b[0].length - a[0].length);
          const replace = (value: unknown): unknown => typeof value === 'string' ? variants.reduce((text, [from, to]) => text.split(from).join(to), value)
            : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, val]) => [key, replace(val)])) : value;
          plan = replace(previous) as Omit<ExperimentExecutionPlan, 'experiment'>;
          plan.build_directory = path.posix.join(root, 'build'); plan.output_directory = path.posix.join(root, 'logs');
          signal.throwIfAborted();
          if (this.required(id).reproduction?.cancel_requested) throw new Error('提交前已请求取消');
          this.store.claimReproductionSubmission(id, experiment, plan as unknown as Record<string, unknown>, root, new Date().toISOString());
          mayHaveSubmitted = true;
          try {
            const receipt = await client.submitExperiment({ ...plan, experiment }, signal);
            if (receipt.experiment_id !== job.experiment_id) throw new Error('Runner 回执中的实验身份不一致');
            acknowledged = true;
          } catch (error) {
            if (!signal.aborted && isRunnerSubmissionRejected(error)) rejectedBeforeExecution = true;
            else if (error instanceof RunnerClientError && error.status === 409) { /* Reconcile the existing id below. */ }
            else throw error;
            if (rejectedBeforeExecution) throw error;
          }
        } finally {
          if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('corepilot-reproduce-')) throw new Error('Unexpected reproduction temporary path');
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
      this.update(id, job.experiment_id, { status: acknowledged ? 'RUNNING' : 'UNKNOWN',
        phase: acknowledged ? 'Runner 排队、构建和复验' : '正在核对原复现实验', error: null });
      let status: ExperimentStatusResponse;
      let cancelSent = false;
      while (true) {
        signal.throwIfAborted();
        if (!cancelSent && this.required(id).reproduction?.cancel_requested) {
          await client.cancelExperiment(job.experiment_id);
          cancelSent = true;
        }
        status = await client.getExperiment(job.experiment_id, signal);
        this.runtime.synchronizeRemoteExperiment(status);
        this.update(id, job.experiment_id, { status: status.status === 'UNKNOWN' ? 'UNKNOWN' : 'RUNNING', phase: status.queue?.reason ?? status.current_step ?? status.status });
        if (!['PENDING', 'RUNNING'].includes(status.status)) break;
        await delay(250, undefined, { signal });
      }
      if (status.status === 'UNKNOWN') throw new Error('Runner 原复现进程状态未知，请先核对原实验 ID');
      const [commands, measurements] = await Promise.all([client.getCommandExecutions(job.experiment_id), client.getMeasurements(job.experiment_id)]);
      this.runtime.synchronizeRemoteFacts({ experimentId: job.experiment_id, commandExecutions: commands.command_executions, measurements: measurements.measurements });
      if (!commands.command_executions.length) {
        this.update(id, job.experiment_id, { status: status.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED', error: status.failure?.message ?? '复现未执行构建', passed: false }); return;
      }
      const validation = withRunnerValidationStatus(validationCycleFromCommandExecutions({ testpack: frozen, commands: commands.command_executions, includePerformance: record.enable_performance, steps: plan.steps }), status);
      const gate = record.enable_performance && validation.performance?.ok ? evaluatePerformanceGate(frozen, parsePerformanceMeasurements(validation.performance.stdout)) : null;
      this.runtime.completeRevalidationExperiment({ experimentId: job.experiment_id, revalidation: { formal: validation, independent: null, performance_gate: gate, passed: validation.passed && (!record.enable_performance || gate?.passed === true) }, factsAlreadyPersisted: true });
      const passed = validation.passed && (!record.enable_performance || gate?.passed === true);
      this.update(id, job.experiment_id, { status: passed ? 'SUCCEEDED' : gate?.statistics?.verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : status.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED', passed,
        error: passed ? null : gate?.reason ?? status.failure?.message ?? '复现未通过正确性或完整性检查', phase: passed ? '干净构建与冻结契约复现通过' : '复现已结束，查看新实验记录' });
    } catch (error) {
      // A concurrent claimant may have persisted the intent after our earlier
      // snapshot. Never overwrite that work with a local failure or cancel.
      const current = this.runtime.getExperiment(job.experiment_id);
      if (!rejectedBeforeExecution && !this.canPrepare(current)) mayHaveSubmitted = true;
      if (mayHaveSubmitted && !rejectedBeforeExecution || signal.reason === 'backend shutting down') {
        let message = `复现实验 ${job.experiment_id} 的状态尚未确认，请核对原 Runner；系统不会重新提交。`;
        try { if (mayHaveSubmitted) this.runtime.markRemoteStateUnknown(job.experiment_id, message); }
        catch { message += ' 本地实验状态暂时无法保存。'; }
        this.update(id, job.experiment_id, { status: 'UNKNOWN', error: message });
      } else {
        const cancelled = signal.aborted || this.required(id).reproduction?.cancel_requested === true;
        const raw = cancelled ? '复现已在提交前取消。' : rejectedBeforeExecution && error instanceof RunnerClientError
          ? `Runner 拒绝复现计划（${error.code}），请核对测试配置。`
          : error instanceof Error ? error.message : typeof error === 'string' ? error : '复现准备失败，请核对任务与机器配置。';
        const message = secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), redactRecord(raw)).slice(0, 2048);
        this.runtime.failExperiment({ experimentId: job.experiment_id, error: message, cancelled, expectedExperiment: current });
        this.update(id, job.experiment_id, { status: cancelled ? 'CANCELLED' : 'FAILED', error: message });
      }
    }
  }
}
