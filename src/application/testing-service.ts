import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CreateTestingTask, TestingPlanRef, TestingPlanPreview, TestingRequestStatus, TestingTaskDetails, TestingTaskRecord } from '../contracts/testing.js';
import type { ResolvedExecutionMachine } from '../contracts/execution-machine.js';
import type { ProjectRecord } from '../contracts/project.js';
import type { TargetConfig } from '../config/target-config.js';
import type { RemoteValidationTransport } from '../workspace/validation-runner.js';
import { ApiError } from '../core/api-error.js';
import { isRunnerSubmissionRejected } from '../core/experiment-execution-backend.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import { resolveRunnerConfig } from '../config/optimization-config.js';
import { AsyncSshTransport } from '../testpack/remote-transport.js';
import { LibraryPackageLoader } from '../library-package/loader.js';
import { stageAndInspectBaselineBundle } from '../workspace/baseline-bundle-staging.js';
import { testingRequestIdentity, TestingStore } from '../storage/testing-store.js';
import { TestingAssetService } from './testing-assets.js';
import { previewTestingPlan } from './testing-plan.js';
import { parseTestingInput, testingRequestDigest } from './testing-input.js';
import { snapshotValidationAssets } from './validation-asset-files.js';
import { assertGeneratedHarnessApis, assertGeneratedHarnessResolution } from '../evaluator/generated-harness-compatibility.js';
import { summarizeTestingTask } from './testing-results.js';
import { prepareTestingExecution, testingConnectionKey } from './testing-execution.js';
import type { TestingBinaryStager, TestingRunner } from './testing-subjects.js';

export interface TestingServiceOptions {
  dataDir: string;
  projects: { get(id: string): ProjectRecord };
  machines: { resolve(id: string): ResolvedExecutionMachine };
  catalog?: LibraryPackageLoader;
  runnerFactory?: (machine: ResolvedExecutionMachine) => TestingRunner;
  transportFactory?: (target: TargetConfig) => RemoteValidationTransport;
  stageBinary?: TestingBinaryStager;
}
const terminal = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

/** One shared application entry for Web/API/CLI independent tests; Runner owns execution. */
export class TestingService {
  readonly assets: TestingAssetService;
  private readonly store: TestingStore;
  private readonly catalog: LibraryPackageLoader;
  private readonly preparing = new Map<string, AbortController>();
  private readonly reading = new Map<string, Promise<TestingTaskDetails>>();
  private refreshing: Promise<void> | null = null;
  constructor(private readonly options: TestingServiceOptions) {
    this.store = new TestingStore(options.dataDir); this.assets = new TestingAssetService(this.store);
    this.catalog = options.catalog ?? new LibraryPackageLoader({ catalogRoot: path.join(options.dataDir, 'catalog') });
  }
  plan(ref: TestingPlanRef): TestingPlanPreview {
    try { return previewTestingPlan(this.catalog, ref).preview; }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, 'INVALID_TESTING_PLAN', `无法读取测试方案：${(error as Error).message}`); }
  }
  private runner(machine: ResolvedExecutionMachine): TestingRunner {
    if (this.options.runnerFactory) return this.options.runnerFactory(machine);
    const runner = resolveRunnerConfig({ runner: machine.runner });
    if (runner.mode !== 'rpc') throw new ApiError(400, 'TESTING_RUNNER_REQUIRED', '请选择 Runner RPC 执行机器。');
    return new RunnerClient({ baseUrl: runner.endpoint, token: runner.token, requestTimeoutMs: runner.requestTimeoutMs });
  }
  private connection(task: TestingTaskRecord): ResolvedExecutionMachine {
    const machine = this.options.machines.resolve(task.machine.machine_id);
    if (testingConnectionKey(machine) !== task.machine.connection_key) throw new ApiError(409, 'TESTING_MACHINE_CHANGED', '机器连接已变化，无法用新连接核对原作业。请由维护者恢复原连接后查询原任务；系统不会重复提交。');
    return machine;
  }
  private runnerForExistingTask(task: TestingTaskRecord): TestingRunner {
    const instance = task.machine.runner_store_instance_id;
    if (!instance) throw new ApiError(409, 'TESTING_RUNNER_IDENTITY_UNKNOWN', '历史测试没有固定 Runner 数据库身份；请维护者核对原 Runner 和任务，系统不会自动查询或取消。');
    const runner = this.runner(this.connection(task));
    runner.bindStoreIdentity(instance);
    return runner;
  }
  private diagnostic(error: unknown, machine?: ResolvedExecutionMachine): string {
    let message = error instanceof Error ? error.message : String(error);
    if (machine?.runner.token) message = message.split(machine.runner.token).join('[redacted]');
    try { const runner = machine && resolveRunnerConfig({ runner: machine.runner }); if (runner?.mode === 'rpc' && runner.token) message = message.split(runner.token).join('[redacted]'); } catch { /* Preserve the original diagnostic. */ }
    return message.slice(0, 6000);
  }
  requestStatus(requestId: string): TestingRequestStatus {
    const decision = this.store.requestDecision(requestId);
    return decision.state === 'CREATED' ? { state: 'CREATED', task_id: decision.task.task_id } : { state: decision.state };
  }
  closeRequest(requestId: string): TestingRequestStatus {
    const decision = this.store.closeRequest(requestId);
    return decision.state === 'CREATED' ? { state: 'CREATED', task_id: decision.task.task_id } : { state: decision.state };
  }
  async start(value: CreateTestingTask, options: { requestId?: string } = {}): Promise<TestingTaskRecord> {
    const input = parseTestingInput(value), digest = testingRequestDigest(input);
    const requestId = options.requestId ?? null;
    const identity = requestId === null ? null : testingRequestIdentity(requestId);
    const previous = (decision: ReturnType<TestingStore['requestDecision']>): TestingTaskRecord | null => {
      if (decision.state === 'CLOSED') throw new ApiError(409, 'TESTING_REQUEST_CLOSED', '原测试创建请求已关闭，请使用新的请求标识。');
      if (decision.state === 'NOT_FOUND') return null;
      if (decision.task.request_digest !== digest) throw new ApiError(409, 'TESTING_REQUEST_CONFLICT', '同一请求标识已用于其他测试条件，请核对原请求。');
      return this.localRecord(decision.task);
    };
    const existing = requestId === null ? null : previous(this.store.requestDecision(requestId));
    if (existing) return existing;
    let resolved: ReturnType<LibraryPackageLoader['resolveSelection']>;
    let preview: TestingPlanPreview;
    try { ({ resolved, preview } = previewTestingPlan(this.catalog, input.plan)); }
    catch (error) { throw new ApiError(400, 'INVALID_TESTING_PLAN', `无法读取测试方案：${(error as Error).message}`); }
    if ((input.expected_evaluator_digest && input.expected_evaluator_digest !== preview.evaluator.digest) ||
      (input.expected_package_digest && input.expected_package_digest !== preview.package_digest)) throw new ApiError(409, 'TESTING_PLAN_CHANGED', '测试方案或构建设置已变化，请重新读取并确认后开始。');
    try {
      assertGeneratedHarnessResolution(resolved.bundle);
      assertGeneratedHarnessApis(resolved.bundle, { correctness: input.mode !== 'performance', performance: input.mode !== 'correctness', baseline: !!input.baseline });
    } catch (error) { throw new ApiError(400, 'TESTING_GENERATED_HARNESS_UNSAFE', (error as Error).message); }
    if (!preview.code.setup || (input.mode !== 'performance' && !preview.code.correctness) || (input.mode !== 'correctness' && !preview.code.performance)) throw new ApiError(400, 'TESTING_CODE_NOT_READY', '所选测试代码尚未完成，请上传或生成代码后再开始。');
    for (const subject of [input.candidate, input.baseline]) if (subject?.kind === 'binary' && this.assets.get(subject.asset_id).state !== 'READY') throw new ApiError(400, 'TEST_ASSET_NOT_READY', '请先选择上传库的入口并固定版本。');
    const machine = this.options.machines.resolve(input.machine_id), createdAt = new Date().toISOString();
    const runner = this.runner(machine);
    const transport = this.options.transportFactory?.(machine.target) ?? new AsyncSshTransport(machine.target);
    const workspaceRoot = machine.target.workspace_root.replaceAll('\\', '/').replace(/\/+$/, '');
    if (!path.posix.isAbsolute(workspaceRoot)) throw new ApiError(400, 'INVALID_TESTING_WORKSPACE', '执行机器需要 Linux 绝对工作目录，请由维护者完成配置。');
    const taskId = identity?.taskId ?? `testing:${randomUUID()}`, label = (input.name ?? preview.function_name).replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 48) || 'test';
    const run = path.posix.join(workspaceRoot, 'testing', `${createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${label}-${taskId.slice(-8)}`);
    const task: TestingTaskRecord = { schema_version: 1, task_id: taskId, name: input.name ?? `${preview.function_name} 测试`, request_id: requestId,
      request_digest: digest, input, plan: preview, machine: { ...machine.identity, connection_key: testingConnectionKey(machine), runner_id: null, hardware: null },
      subjects: { candidate: null, baseline: null }, workspace: { run_root: run, logs_root: path.posix.join(run, 'logs'),
        assets_root: path.posix.join(run, 'development', 'assets'), runtime_root: path.posix.join(run, 'development', 'runtime') },
      execution: { status: 'PREPARING', phase: 'SNAPSHOTTING', message: '正在固定测试方案与两端版本', cancel_requested: false, submission_attempted: false, failure: null },
      created_at: createdAt, updated_at: createdAt, formal_evidence: false };
    if (requestId === null) this.store.saveTask(task);
    else {
      const claimed = this.store.claimRequest(task);
      if (!claimed.created) {
        const existingTask = previous(claimed.decision);
        if (existingTask) return existingTask;
        throw new ApiError(503, 'TESTING_REQUEST_UNCONFIRMED', '测试请求状态尚未确认，请按原请求标识核对。');
      }
    }
    try { snapshotValidationAssets(resolved.bundle.root, path.join(this.store.taskRoot(taskId), 'evaluator'), preview.evaluator.digest); }
    catch (error) { return this.store.updateTask(taskId, record => { record.execution.status = 'FAILED'; record.execution.failure = {
      code: 'TESTING_SNAPSHOT_FAILED', stage: 'SNAPSHOTTING', message: this.diagnostic(error) }; record.execution.message = '无法固定测试方案，请重新读取方案后创建新的测试。'; }); }
    const controller = new AbortController(); this.preparing.set(taskId, controller);
    void prepareTestingExecution({ store: this.store, taskId, resolved, assets: this.assets, projects: this.options.projects, machine,
      runner, transport,
      stageBinary: this.options.stageBinary ?? stageAndInspectBaselineBundle, signal: controller.signal })
      .catch(error => {
        try {
          this.store.updateTask(taskId, record => {
            if (terminal.has(record.execution.status)) return;
            const cancelled = (controller.signal.aborted || record.execution.cancel_requested) && !record.execution.submission_attempted;
            // Only a documented rejection of the submit request proves that the
            // Runner did not store it. A later cancellation error, or a proxy's
            // HTTP response, cannot prove that an accepted job has stopped.
            const rejected = record.execution.phase === 'SUBMITTING' && isRunnerSubmissionRejected(error);
            const storageUnknown = error instanceof ApiError && ['TESTING_STATE_LOCK_UNAVAILABLE', 'TESTING_STATE_UNCONFIRMED'].includes(error.code);
            const unknown = storageUnknown || record.execution.submission_attempted && !rejected;
            record.execution.status = cancelled && !storageUnknown ? 'CANCELLED' : unknown ? 'UNKNOWN' : 'FAILED';
            record.execution.message = cancelled && !storageUnknown ? '准备已取消，未提交 Runner 实验。' : unknown ? '测试状态尚未确认，请查询原任务；系统不会自动重复提交。' : '测试准备失败，请查看原因并修改条件后创建新的测试。';
            record.execution.failure = cancelled && !storageUnknown ? null : { code: storageUnknown ? error.code : unknown ? 'TESTING_SUBMISSION_UNKNOWN' : 'TESTING_PREPARATION_FAILED', stage: record.execution.phase, message: this.diagnostic(error, machine) };
          });
        } catch {
          // A storage failure must not be converted into a test result or an unhandled rejection.
          console.error(`[corepilot-testing] 无法保存测试 ${taskId} 的准备状态，请检查数据目录并核对原任务。`);
        }
      }).finally(() => this.preparing.delete(taskId));
    return task;
  }
  private localRecord(task: TestingTaskRecord): TestingTaskRecord {
    if (task.execution.status === 'PREPARING' && !this.preparing.has(task.task_id)) {
      return { ...task, execution: { ...task.execution, status: 'UNKNOWN', message: task.execution.submission_attempted
        ? '正在核对原 Runner 作业；系统不会重复提交。' : '无法确认原控制进程是否仍在准备；请核对原任务，系统不会自动重试。' } };
    }
    return task;
  }
  list(): TestingTaskRecord[] { return this.store.tasks().map(task => this.localRecord(task)); }
  /** Refresh persisted list projections without holding the browser request open. */
  refreshActive(): void {
    if (this.refreshing) return;
    const ids = this.store.tasks().filter(task => task.execution.submission_attempted && !terminal.has(task.execution.status)).map(task => task.task_id);
    this.refreshing = (async () => {
      for (let offset = 0; offset < ids.length; offset += 4) await Promise.allSettled(ids.slice(offset, offset + 4).map(id => this.get(id)));
    })().finally(() => { this.refreshing = null; });
  }
  private details(task: TestingTaskRecord): TestingTaskDetails {
    const cached = this.store.cache(task.task_id);
    const currentCache = cached && isDeepStrictEqual(cached.task.execution, task.execution);
    return { task, status: currentCache ? cached.status : null, commands: cached?.commands ?? [], measurements: cached?.measurements ?? [], output: cached?.output ?? null,
      summary: summarizeTestingTask(task, cached?.measurements ?? []), formal_evidence: false };
  }
  get(taskId: string): Promise<TestingTaskDetails> {
    const current = this.reading.get(taskId);
    if (current) return current;
    const reading = this.readDetails(taskId).finally(() => { this.reading.delete(taskId); });
    this.reading.set(taskId, reading);
    return reading;
  }
  private async readDetails(taskId: string): Promise<TestingTaskDetails> {
    const observed = this.store.task(taskId);
    let task = this.localRecord(observed);
    const cached = this.store.cache(taskId);
    const currentCache = cached && isDeepStrictEqual(cached.task.execution, task.execution);
    if (!task.execution.submission_attempted || (terminal.has(task.execution.status) && (currentCache || !task.machine.runner_store_instance_id || task.execution.failure?.code === 'TESTING_PREPARATION_FAILED')) ||
      (this.preparing.has(taskId) && task.execution.phase !== 'SUBMITTED')) return this.details(task);
    try {
      const runner = this.runnerForExistingTask(task);
      let status = await runner.getExperiment(taskId);
      if (status.experiment_id !== taskId) throw new Error('Runner 返回了其他测试任务，无法确认本次状态。');
      const current = this.store.task(taskId);
      if (current.execution.cancel_requested && !terminal.has(current.execution.status) && !terminal.has(status.status) && !status.cancel_requested) {
        const receipt = await runner.cancelExperiment(taskId);
        if (receipt.experiment_id !== taskId) throw new Error('Runner 取消回执与测试任务身份不一致。');
        status = await runner.getExperiment(taskId);
        if (status.experiment_id !== taskId) throw new Error('Runner 返回了其他测试任务，无法确认本次状态。');
      }
      const [commands, measurements, output] = await Promise.all([runner.getCommandExecutions(taskId), runner.getMeasurements(taskId), runner.getExecutionOutput(taskId)]);
      if (commands.experiment_id !== taskId || measurements.experiment_id !== taskId ||
        commands.command_executions.some(command => command.experiment_id !== taskId) || measurements.measurements.some(measurement => measurement.experiment_id !== taskId)) throw new Error('Runner 测量或命令记录与测试任务身份不一致。');
      let applied = false;
      task = this.store.updateTask(taskId, record => {
        if (!isDeepStrictEqual(record.execution, observed.execution) || terminal.has(record.execution.status) && record.execution.status !== status.status) return;
        applied = true; record.execution.status = status.status; record.execution.phase = status.current_step ?? status.status;
        record.execution.cancel_requested ||= status.cancel_requested; record.execution.message = status.queue?.reason ?? (status.cancel_requested && !terminal.has(status.status) ? '已请求取消，等待 Runner 确认停止。' : null);
        record.execution.failure = status.failure ? { code: status.failure.code, stage: status.failure.step ?? 'RUNNER', message: status.failure.message } : null; });
      if (!applied) return this.details(this.localRecord(task));
      const details: TestingTaskDetails = { task, status, commands: commands.command_executions, measurements: measurements.measurements, output,
        summary: summarizeTestingTask(task, measurements.measurements), formal_evidence: false };
      if (!this.store.saveResult(details)) return this.details(this.localRecord(this.store.task(taskId)));
      return details;
    } catch (error) {
      const machine = (() => { try { return this.options.machines.resolve(task.machine.machine_id); } catch { return undefined; } })();
      const identityProblem = error instanceof RunnerClientError && ['RUNNER_STORE_MISMATCH', 'RUNNER_STORE_IDENTITY_UNAVAILABLE', 'RUNNER_STORE_GUARD_UNAVAILABLE'].includes(error.code);
      task = this.store.updateTask(taskId, record => {
        if (!isDeepStrictEqual(record.execution, observed.execution) || terminal.has(record.execution.status)) return;
        record.execution.status = 'UNKNOWN'; record.execution.message = error instanceof ApiError ? error.message : identityProblem
        ? this.diagnostic(error, machine) : '暂时无法核对 Runner 状态，请继续查询原任务；系统不会重复提交。';
        record.execution.failure = { code: error instanceof ApiError ? error.code : error instanceof RunnerClientError ? error.code : 'TESTING_RECONCILIATION_FAILED', stage: 'RECONCILE', message: this.diagnostic(error, machine) }; });
      return this.details(task);
    }
  }
  async cancel(taskId: string): Promise<TestingTaskDetails> {
    let task = this.store.updateTask(taskId, record => {
      if (terminal.has(record.execution.status)) return;
      record.execution.cancel_requested = true;
      if (!record.execution.submission_attempted && !this.preparing.has(taskId)) {
        record.execution.status = 'UNKNOWN'; record.execution.message = '已请求取消，无法确认原控制进程是否仍在准备；请继续核对原任务。';
      } else record.execution.message = '已请求取消，正在等待停止确认。';
    });
    if (terminal.has(task.execution.status)) return this.get(taskId);
    if (!task.execution.submission_attempted) {
      const controller = this.preparing.get(taskId);
      if (controller) controller.abort();
      return this.details(task);
    }
    try {
      const receipt = await this.runnerForExistingTask(task).cancelExperiment(taskId);
      if (receipt.experiment_id !== taskId) throw new Error('Runner 取消回执与测试任务身份不一致。');
      task = this.store.updateTask(taskId, record => { if (!terminal.has(record.execution.status)) record.execution.status = receipt.status; record.execution.cancel_requested = true; });
    } catch (error) {
      task = this.store.updateTask(taskId, record => { if (terminal.has(record.execution.status)) return;
        record.execution.status = 'UNKNOWN'; record.execution.message = '取消尚未确认，请继续查询原任务；不会将仍可能运行的作业标成已停止。';
        record.execution.failure = { code: 'TESTING_CANCEL_UNKNOWN', stage: 'CANCEL', message: this.diagnostic(error) }; });
    }
    return this.get(taskId);
  }
}
