import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { candidateRelativePath } from '../config/runtime-path.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskStore } from '../storage/task-store.js';
import { canRetryWorkflowValidation, isWorkflowValidationBlocked, type OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { PublicWorkflowRequest } from '../contracts/public-workflow.js';
import { loadPublicOptimizationPreflight } from './public-optimization.js';
import { createPiModels, COREPILOT_PI_PROVIDER_ID, type PiRuntimeModelConfig } from '../model/pi-provider.js';
import { verifyToolCalling } from '../model/tool-verification.js';
import { createModelTransport, type ModelTransport } from '../model/model-transport.js';
import type { AgentTool } from '../agent/pi-agent-runtime.js';
import { PiOptimizationSession, readOptimizationSessionEvents } from '../agent/pi-optimization-session.js';
import { resolveOptimizationBudget, type OptimizationSessionBudget, type OptimizationSessionEvents } from '../contracts/optimization-session.js';
import { buildCandidateFeedbackPrompt, runPublicAgentWorkflow, type PublicDevelopmentInvestigation, type PublicAgentWorkflowCheckpoint } from './public-agent-workflow.js';
import { ensureCandidateRepository, type CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import { snapshotEditingSource } from '../workspace/git-source-archive.js';
import { stageRpcSource } from '../workspace/rpc-source-staging.js';
import { freezeValidationTestpack } from '../testpack/validation-freeze.js';
import { stageRemoteBaseline, stageRemoteEvaluator, type StagedRemoteBaseline, type StagedRemoteEvaluator, type RemoteValidationTransport, type ValidationCycleResult, type RevalidationCycleResult, type CommandRunResult } from '../workspace/validation-runner.js';
import { stageVerifiedBinaryBaseline } from '../workspace/baseline-bundle-staging.js';
import { packageBaselineBinding } from '../library-package/task-definition.js';
import type { TargetConfig } from '../config/target-config.js';
import { initialOptimizationWorkflowRecord, SqliteOptimizationWorkflowStore } from './optimization-workflow.js';
import { OptimizationRuntime } from '../core/optimization-runtime.js';
import { RunnerClient, RunnerClientError } from '../client/runner-client.js';
import type { ExperimentExecutionPlan } from '../contracts/runner-rpc.js';
import { RunnerClientExperimentExecutionBackend } from '../core/experiment-execution-backend.js';
import { RpcExperimentTransitionAdapter, RemoteExperimentUnknownError } from '../core/rpc-experiment-transition-adapter.js';
import { RunnerDevelopmentInvestigation, stageRemoteDevelopmentAssets, type PreparedDevelopmentWorkspace } from '../core/development-investigation.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { packageOptimizationTaskInput } from '../library-package/task-definition.js';
import { buildOptimizationReport, renderOptimizationReport } from '../report/optimization-report.js';
import { writeOptimizationReport } from '../report/write-report.js';
import type { OptimizationReportResponse } from '../contracts/optimization-report.js';
import { ExecutionMachineService } from '../application/execution-machine-service.js';
import type { LibraryPackageLoader } from '../library-package/loader.js';
import { readValidationTestPlan } from '../evaluator/validation-test-plan.js';
import { ReproductionService } from '../application/reproduction-service.js';
import { WorkflowDeliveryService, type DeliveryResult } from '../application/workflow-delivery-service.js';
import { WorkflowApprovalService } from '../application/workflow-approval-service.js';
import { localWorktreeRoot } from './optimization-workflow-paths.js';
import { loadSourceOptimizationPreflight, sourceOptimizationContractDigest, sourceOptimizationIntake, type SourceOptimizationPreflight } from './source-optimization.js';
import { executeSourceOptimization } from './source-optimization-execution.js';

export interface OptimizationWorkflowServiceOptions {
  /** 保留 host 参数仅用于已有服务装配；public workflow 不依赖旧 task runner。 */
  host?: unknown;
  store: TaskStore;
  reportDir?: string;
  worktreeRoot?: string;
  evidenceRoot?: string;
  transportFactory: () => RemoteValidationTransport;
  publicValidationTransportFactory?: (target: TargetConfig) => RemoteValidationTransport;
  publicExecution?: boolean;
  publicEnablePerformance?: boolean;
  publicMaxRounds?: number;
  publicInitialFeedback?: Record<string, unknown>;
}

function summarizeCommand(result: CommandRunResult | null) {
  return result
    ? { ok: result.ok, exit_code: result.exit_code, timed_out: result.timed_out, cancelled: result.cancelled, duration_ms: result.duration_ms }
    : null;
}

function summarizeValidation(result: ValidationCycleResult): Record<string, unknown> {
  return { passed: result.passed, build: summarizeCommand(result.build), correctness: summarizeCommand(result.correctness), performance: result.performance ? summarizeCommand(result.performance) : null };
}

function summarizeRevalidation(result: RevalidationCycleResult): Record<string, unknown> {
  const one = (item: ValidationCycleResult | null) => item ? { passed: item.passed, build: summarizeCommand(item.build), correctness: summarizeCommand(item.correctness) } : null;
  return { passed: result.passed, formal: one(result.formal), independent: one(result.independent), performance_gate: result.performance_gate ?? null };
}

function developmentToolText(value: unknown) {
  return { isError: false, text: JSON.stringify(value) };
}

function redact(value: string, apiKey: string | null): string {
  return apiKey ? value.split(apiKey).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]') : value;
}

/** 新 public optimize 工作流的唯一后端入口。 */
export class OptimizationWorkflowService {
  readonly reproductions: ReproductionService;
  readonly deliveries: WorkflowDeliveryService;
  readonly approvals: WorkflowApprovalService;
  private readonly records: SqliteOptimizationWorkflowStore;
  private readonly runtime: OptimizationRuntime;
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly sessions = new Map<string, PiOptimizationSession>();
  private stopping = false;

  constructor(private readonly options: OptimizationWorkflowServiceOptions) {
    this.records = new SqliteOptimizationWorkflowStore(options.store);
    this.runtime = new OptimizationRuntime(options.store);
    this.reproductions = new ReproductionService(options.store, this.records);
    for (const record of this.records.list(200)) {
      if (record.reproduction && ['PREPARING', 'RUNNING'].includes(record.reproduction.status)) {
        record.reproduction.status = 'UNKNOWN'; record.reproduction.error = 'Control 已重启；继续时先查询原复现实验，不重复提交新 ID';
        this.records.save(record);
      }
      if (record.agent_session && ['CREATED', 'GENERATING'].includes(record.status)) {
        record.status = 'INTERRUPTED';
        record.progress = { ...record.progress, phase: 'INTERRUPTED', last_event: '后台已重新启动，优化现场已保留，可继续原会话。' };
        this.records.save(record);
        if (record.optimization_task_id) this.runtime.setTaskStatus(record.optimization_task_id, 'INTERRUPTED');
      }
    }
    this.approvals = new WorkflowApprovalService(options.store, this.records,
      options.evidenceRoot ?? (options.worktreeRoot ? path.join(path.dirname(options.worktreeRoot), 'evidence') : path.join(os.tmpdir(), 'corepilot-evidence')));
    this.deliveries = new WorkflowDeliveryService(options.store, this.records, this.approvals);
  }

  get(workflowId: string): OptimizationWorkflowRecord | null {
    return this.records.get(workflowId);
  }

  list(limit = 50): OptimizationWorkflowRecord[] { return this.records.list(limit); }

  /** Process attachment is an observation, never a persisted Experiment outcome. */
  activeWorkflowIds(): string[] { return [...this.controllers.keys()]; }

  report(workflowId: string): OptimizationReportResponse | null {
    const workflow = this.records.get(workflowId);
    if (!workflow) return null;
    const report = buildOptimizationReport(workflow, this.options.store);
    return { report, markdown: renderOptimizationReport(report) };
  }

  submitPublic(request: PublicWorkflowRequest, options: { cliApiKey?: string; requestId?: string; packageLoader?: LibraryPackageLoader } = {}): { workflowId: string } {
    if (this.stopping) throw new Error('后台正在停止，请稍后重试。');
    if (request.verification_mode === 'source_only' && request.enable_performance === true) throw new Error('仅优化源码不执行性能测试，请选择优化并验证。');
    const requestDigest = createHash('sha256').update(JSON.stringify({
      config_path: path.resolve(request.config_path),
      function_name: request.function_name,
      entry_file: request.entry_file,
      repository_root: path.resolve(request.repository_root ?? path.dirname(request.config_path)),
      ...(request.source_branch === undefined ? {} : { source_branch: request.source_branch }),
      ...(request.machine_id === undefined ? {} : { machine_id: request.machine_id }),
      enable_performance: request.verification_mode === 'source_only' ? false : request.enable_performance ?? this.options.publicEnablePerformance ?? false,
      ...(request.verification_mode === 'source_only' ? { verification_mode: 'source_only' } : {}),
      ...(request.budget ? { budget: request.budget } : {}),
    })).digest('hex');
    if (options.requestId) {
      const previous = this.options.store.getOptimizationWorkflowByRequestId(options.requestId);
      if (previous) {
        const record = JSON.parse(previous) as OptimizationWorkflowRecord;
        if (record.request_digest !== requestDigest) throw new Error('Idempotency-Key already used with different optimization inputs');
        return { workflowId: record.workflow_id };
      }
    }
    if (request.verification_mode === 'source_only') {
      const preflight = loadSourceOptimizationPreflight(request, { ...options, readMachine: id => this.options.store.getExecutionMachine(id) });
      const { record, task } = sourceOptimizationIntake(`workflow:${randomUUID()}`, preflight);
      record.optimization_task_id = this.runtime.createTask(task).task_id;
      if (options.requestId) { record.request_id = options.requestId; record.request_digest = requestDigest; }
      this.records.save(record);
      if (this.options.publicExecution === true) this.launchSourceWorkflow(record.workflow_id, preflight);
      return { workflowId: record.workflow_id };
    }
    const preflight = loadPublicOptimizationPreflight(request, { cliApiKey: options.cliApiKey, resolveMachine: id => new ExecutionMachineService(this.options.store).resolve(id), packageLoader: options.packageLoader });
    const workflowId = `workflow:${randomUUID()}`;
    const record = initialOptimizationWorkflowRecord(workflowId, {
      functionName: request.function_name,
      entryFile: request.entry_file,
      configPath: preflight.config.configPath,
      repositoryRoot: request.repository_root ?? preflight.config.configDir,
      configFileSha256: preflight.config.rawSha256,
      testpackDigest: String(preflight.audit.testpack.digest),
      enablePerformance: request.enable_performance ?? this.options.publicEnablePerformance,
    });
    const performanceBaseline = preflight.testpack.testpack.performance.baselines.comparison;
    record.session_budget = resolveOptimizationBudget(request.budget);
    record.execution_contract_digest = executionContractDigest(preflight);
    if (preflight.executionMachine) record.execution_machine = { ...preflight.executionMachine };
    if (preflight.source) { record.source_branch = preflight.source.branch; record.baseline_commit = preflight.source.commit; }
    if (options.requestId) { record.request_id = options.requestId; record.request_digest = requestDigest; }
    const taskInput = {
      workflowId,
      target: {
        kind: 'software_function',
        name: request.function_name,
        scope: {
          entry_file: request.entry_file,
          repository_root: request.repository_root ?? preflight.config.configDir,
          ...(preflight.source ? { source_branch: preflight.source.branch } : {}),
          testpack_id: preflight.testpack.testpack.testpack_id,
          function_family: preflight.testpack.testpack.function_family,
          operation: preflight.testpack.testpack.operation,
          data_type: preflight.testpack.testpack.data_type,
          build: structuredClone(preflight.config.config.build),
          development_feedback: {
            workload_ids: preflight.testpack.testpack.performance.cases.map((item) => item.case_id),
            tools: ['inspect_machine', 'inspect_binary', 'disassemble', 'run_dev_benchmark', 'profile_perf_stat'],
          },
          formal_evaluator: preflight.testpack.testpack.evaluator ? {
            id: preflight.testpack.testpack.evaluator.id,
            version: preflight.testpack.testpack.evaluator.version,
            digest: preflight.testpack.testpack.evaluator.sha256,
          } : null,
          acceptance_policy: structuredClone(preflight.testpack.testpack.performance.thresholds),
        },
      },
      sourceBaseline: preflight.source ? {
        id: `git:${preflight.source.commit}`, digest: preflight.source.commit,
        details: { repository: request.repository_root ?? preflight.config.configDir, source_branch: preflight.source.branch },
      } : {
        id: `repository:${path.resolve(request.repository_root ?? preflight.config.configDir)}`,
        details: { state: 'UNRESOLVED' },
      },
      performanceBaseline: {
        id: performanceBaseline.id,
        version: performanceBaseline.version,
        digest: performanceBaseline.sha256,
        details: { library: performanceBaseline.library, path: performanceBaseline.path },
      },
      evaluator: preflight.testpack.testpack.evaluator ? {
        id: preflight.testpack.testpack.evaluator.id,
        version: preflight.testpack.testpack.evaluator.version,
        digest: preflight.testpack.testpack.evaluator.sha256,
        details: { owner: preflight.testpack.testpack.evaluator.owner },
      } : {
        id: preflight.testpack.testpack.testpack_id,
        version: String(preflight.testpack.testpack.schema_version),
        digest: preflight.testpack.rawSha256,
        details: { trust: 'LEGACY_TESTPACK_ONLY' },
      },
      declaredContext: {
        ...(preflight.executionMachine ? { execution_machine: { ...preflight.executionMachine } } : {}),
        target: { ...preflight.config.config.target },
        resources: { ...preflight.testpack.testpack.resources },
        workload_inventory: preflight.testpack.testpack.performance.cases.map((item) => ({
          workload_id: item.case_id,
          parameters: { ...(item.parameters ?? {}) },
          threads: item.threads,
          critical: item.critical,
          weight: item.weight,
        })),
        sampling: { ...preflight.testpack.testpack.performance.sampling },
        acceptance_policy: { ...preflight.testpack.testpack.performance.thresholds },
      },
    };
    const task = this.runtime.createTask(preflight.libraryPackage
      ? packageOptimizationTaskInput(preflight.libraryPackage, {
        workflowId,
        sourceBaseline: taskInput.sourceBaseline,
        baselineArtifactPath: performanceBaseline.path,
        declaredContext: taskInput.declaredContext,
      })
      : taskInput);
    record.optimization_task_id = task.task_id;
    record.progress = { phase: 'PUBLIC_INTAKE_VALIDATED', last_event: 'public config and validation testpack accepted' };
    this.records.save(record);
    if (this.options.publicExecution === true) {
      const controller = new AbortController();
      this.controllers.set(workflowId, controller);
      const run = this.executePublic(workflowId, preflight, controller.signal).finally(() => {
        this.controllers.delete(workflowId);
        this.running.delete(workflowId);
      });
      this.running.set(workflowId, run);
    }
    return { workflowId };
  }

  private async executePublic(workflowId: string, preflight: ReturnType<typeof loadPublicOptimizationPreflight>, signal: AbortSignal, resume = false, continuationMessage?: string, retryValidation = false): Promise<void> {
    const update = (patch: Partial<OptimizationWorkflowRecord>) => {
      const record = this.records.get(workflowId);
      if (!record) return;
      Object.assign(record, patch, { updated_at: new Date().toISOString() });
      this.records.save(record);
    };
    const clean = (text: string) => redact(redact(text, preflight.credential.apiKey), preflight.runner.mode === 'rpc' ? preflight.runner.token : null);
    const taskId = this.records.get(workflowId)?.optimization_task_id;
    if (!taskId) {
      update({ status: 'FAILED', error: 'optimization task identity is missing', progress: { phase: 'FAILED', last_event: 'optimization task identity is missing' } });
      return;
    }
    let modelTransport: ModelTransport | undefined;
    let session: PiOptimizationSession | undefined;
    try {
      if (preflight.executionMachine && preflight.runner.mode === 'rpc') {
        update({ progress: { phase: 'CHECKING_EXECUTION_MACHINE', last_event: `正在连接执行机器 ${preflight.executionMachine.name}` } });
        const facts = await new RunnerClient({ baseUrl: preflight.runner.endpoint, token: preflight.runner.token, requestTimeoutMs: preflight.runner.requestTimeoutMs }).probe(signal);
        if (facts.health.resource_enforcement !== 'REQUIRED') throw new Error('所选机器尚未开启正式实验所需的资源约束，请联系维护者。');
      }
      modelTransport = createModelTransport(preflight.model_proxy);
      const modelFetch = modelTransport.fetch;
      const modelConfig: PiRuntimeModelConfig = {
        modelId: preflight.config.config.model.model_id,
        endpoint: preflight.config.config.model.endpoint,
        apiKey: preflight.credential.apiKey,
        reasoningEffort: preflight.config.config.model.reasoning_effort,
        maxOutputTokens: preflight.config.config.model.max_output_tokens,
      };
      const models = createPiModels(modelConfig);
      const baseModel = models.getModel(COREPILOT_PI_PROVIDER_ID, modelConfig.modelId);
      if (!baseModel) throw new Error(`模型未加载：${modelConfig.modelId}`);

      const repositoryRoot = preflight.request.repository_root ?? preflight.config.configDir;
      const prepared = ensureCandidateRepository(repositoryRoot);
      const baselineCommit = preflight.source?.commit ?? prepared.baselineCommit;
      const currentTask = this.runtime.getTask(taskId);
      this.runtime.updateTask(taskId, {
        status: 'RUNNING',
        source_baseline: {
          id: `git:${baselineCommit}`,
          digest: baselineCommit,
          details: { repository: prepared.repository, ...(preflight.source ? { source_branch: preflight.source.branch } : {}) },
        },
        declared_context: currentTask.declared_context,
      });
      const runId = workflowId.replace(/^workflow:/, '').replace(/[^A-Za-z0-9_-]/g, '_');
      const snapshotDir = path.join(preflight.config.config.output_dir, runId);
      const frozen = freezeValidationTestpack(preflight.testpack.testpack, snapshotDir);
      update({ status: 'GENERATING', repository_root: prepared.repository, baseline_commit: baselineCommit, testpack_snapshot_path: path.join(snapshotDir, 'validation-testpack.json'), target_identity: { ...preflight.config.config.target }, progress: { phase: 'PUBLIC_WORKSPACE_STARTING', last_event: `frozen validation testpack ${frozen.digest}` } });

      const previousSession = this.records.get(workflowId)?.agent_session;
      session = await PiOptimizationSession.open({
        id: previousSession?.id ?? runId, directory: previousSession?.directory ?? path.join(snapshotDir, 'agent'), models, model: baseModel,
        systemPrompt: '你是 CorePilot 性能工程 Agent。持续调查当前库、目标机器和历史实验，提出有依据的优化假设，完成所有相关源码编辑后调用 submit_candidate。系统会在同一会话返回构建、正确性、性能和复验结果；失败时读取诊断并自行修复或换一个方向。按需使用机器、二进制、反汇编、开发 benchmark 和 perf 工具，修改前保存结构化假设和调查结论。开发测量只用于调查。测试方案、比较基线、正式资源条件与验收规则由系统管理。没有可信优化方向时可以解释原因并停止，无需制造改动。用户可能在执行中补充要求。',
        thinkingLevel: preflight.config.config.model.reasoning_effort ?? 'off', fetch: modelFetch, timeoutMs: preflight.config.config.model.timeout_ms,
        onEvent: async event => {
          if (event.type === 'tool_end' && event.isError && session && await session.readRecord('development-job')) {
            this.controllers.get(workflowId)?.abort('runner state unknown');
          }
          const message = event.type === 'turn_start' ? 'Agent 正在分析下一步'
            : event.type === 'tool_start' ? `正在调用 ${event.toolName}`
            : event.type === 'tool_end' ? `${event.toolName} ${event.isError ? '返回错误，Agent 将读取反馈' : '完成'}`
            : event.type === 'compaction_start' ? '正在整理上下文，保留当前进展和证据引用'
            : event.type === 'compaction_end' ? '上下文整理完成，继续当前任务' : null;
          if (message) update({ ...(session ? { agent_session: await session.summary() } : {}), progress: { ...this.records.get(workflowId)?.progress, phase: this.records.get(workflowId)?.progress?.phase ?? 'AGENT_EDITING', last_event: message } });
        },
      });
      this.sessions.set(workflowId, session);
      update({ agent_session: await session.summary() });
      let resumeFrom = resume ? await session.readCheckpoint<PublicAgentWorkflowCheckpoint>() : undefined;
      let afterSavedEvaluation = !!resumeFrom && resumeFrom.phase !== 'AGENT';
      if (resume && !resumeFrom) throw new Error('当前任务没有可恢复的执行检查点，请保留旧报告并创建新任务。');
      if (retryValidation) {
        const candidate = this.runtime.getCandidate(this.records.get(workflowId)!.candidate_id!);
        if (!resumeFrom?.checkpoint || resumeFrom.candidateId !== candidate.candidate_id
          || resumeFrom.checkpoint.commit !== candidate.source.commit || resumeFrom.checkpoint.tree !== candidate.source.tree
          || resumeFrom.checkpoint.source_archive_sha256 !== candidate.source.archive_sha256
          || resumeFrom.workspace.candidate_commit !== candidate.source.commit || resumeFrom.workspace.candidate_tree !== candidate.source.tree) {
          throw new Error('保存的源码检查点与当前冻结候选不一致，未启动重试。');
        }
        resumeFrom = { ...resumeFrom, phase: 'VALIDATION', validationOnly: true, activeExperimentId: null,
          evaluationFeedback: null, pendingDecision: null, pendingParentHypothesisId: null,
          validation: null, performance: null, revalidation: null };
        await session.checkpoint(resumeFrom);
        await session.progress({ phase: 'RETRYING_VALIDATION', last_event: `重新验证冻结候选 ${candidate.candidate_id}；保持源码与测试口径，创建新实验。` });
      } else if (resumeFrom?.validationOnly && !resumeFrom.activeExperimentId && resumeFrom.evaluationFeedback
        && (resumeFrom.validation?.build.ok === false || resumeFrom.evaluationFeedback.correctness_status === 'FAILED'
          || resumeFrom.evaluationFeedback.performance_summary.status === 'FAILED')) {
        resumeFrom = { ...resumeFrom, phase: 'AGENT', validationOnly: false, pendingDecision: null,
          prompt: buildCandidateFeedbackPrompt(preflight, resumeFrom.evaluationFeedback) };
        afterSavedEvaluation = true;
        await session.checkpoint(resumeFrom);
      }
      if (!resumeFrom?.validationOnly) {
        const verification = await verifyToolCalling(modelConfig, { models, timeoutMs: preflight.config.config.model.timeout_ms, signal, fetch: modelFetch });
        if (!verification.ok) throw new Error(`模型工具调用能力验证失败：${verification.error ?? '未返回合法 tool call'}`);
      }
      const budget = this.records.get(workflowId)?.session_budget ?? resolveOptimizationBudget();
      const continuationStarted = Date.now();

      const transport = this.options.publicValidationTransportFactory?.(preflight.config.config.target) ?? this.options.transportFactory();
      let experimentExecution: RpcExperimentTransitionAdapter | undefined;
      let createDevelopmentInvestigation: ((workspace: CandidateWorkspaceState) => PublicDevelopmentInvestigation) | undefined;
      if (preflight.runner.mode === 'rpc') {
        const rpcRunner = preflight.runner;
        const evaluatorSpec = preflight.testpack.testpack.evaluator;
        if (!evaluatorSpec) throw new Error('RPC formal execution requires a verified evaluator bundle');
        const evaluatorStages = new Map<string, Promise<StagedRemoteEvaluator>>();
        let stagedBaseline: Promise<StagedRemoteBaseline> | undefined;
        const runnerClient = new RunnerClient({
          baseUrl: preflight.runner.endpoint,
          token: preflight.runner.token,
          requestTimeoutMs: preflight.runner.requestTimeoutMs,
        });
        const backend = new RunnerClientExperimentExecutionBackend(runnerClient);
        const pendingDevelopment = await session.readRecord<ExperimentExecutionPlan | null>('development-job');
        if (pendingDevelopment) {
          const id = pendingDevelopment.experiment.experiment_id;
          update({ progress: { phase: 'RECONCILING_DEVELOPMENT', last_event: `正在核对已有开发实验 ${id}` } });
          try {
            try { await backend.getExperiment(id, signal); }
            catch (error) {
              if (!(error instanceof RunnerClientError) || error.status !== 404) throw error;
              await backend.submitExperiment(pendingDevelopment, signal);
            }
            while (true) {
              signal.throwIfAborted();
              const status = await backend.getExperiment(id, signal);
              if (status.status === 'UNKNOWN') throw new Error('Runner 尚不能确认上次开发命令的终态');
              if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status.status)) break;
              await delay(rpcRunner.pollIntervalMs, undefined, { signal });
            }
            const facts = await backend.getCommandExecutions(id, signal);
            const diagnostic = facts.command_executions.at(-1);
            continuationMessage = `${continuationMessage ?? ''}\n上次开发实验已核对：${id}。${diagnostic ? JSON.stringify({ exit_code: diagnostic.exit_code, stdout: diagnostic.stdout.slice(-8192), stderr: diagnostic.stderr.slice(-8192) }) : '尚无命令输出。'}`;
            await session.record('development-job', null);
          } catch (error) { throw new RemoteExperimentUnknownError(id, `开发实验现场已保留：${(error as Error).message}`); }
        }
        const comparisonBaseline = preflight.testpack.testpack.performance.baselines.comparison;
        const prepareComparisonBaseline = async (stageSignal?: AbortSignal): Promise<StagedRemoteBaseline> => {
          const root = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
          const remoteWorkspace = path.posix.join(root, runId, 'baselines', safePathSegment(comparisonBaseline.id),
            safePathSegment(comparisonBaseline.version), comparisonBaseline.sha256.toLowerCase());
          stagedBaseline ??= (async () => {
            const binding = preflight.libraryPackage ? packageBaselineBinding(preflight.libraryPackage, comparisonBaseline.path) : null;
            if (binding?.bundle && binding.bundleRoot && binding.entryPath) {
              stageSignal?.throwIfAborted();
              return stageVerifiedBinaryBaseline({ bundle: binding.bundle, bundleRoot: binding.bundleRoot,
                entryPath: binding.entryPath, expectedDigest: comparisonBaseline.sha256, remoteRoot: remoteWorkspace,
                target: preflight.config.config.target, runner: rpcRunner });
            }
            return stageRemoteBaseline({ sourceArtifact: comparisonBaseline.path,
              ...(preflight.libraryPackage ? { sourceLocation: 'control' as const } : {}),
              expectedDigest: comparisonBaseline.sha256, transport, remoteWorkspace, signal: stageSignal });
          })();
          return stagedBaseline;
        };
        experimentExecution = new RpcExperimentTransitionAdapter({
          backend,
          runtime: this.runtime,
          onStatus: status => update({ progress: { ...(this.records.get(workflowId)?.progress ?? { phase: 'RUNNER_EXECUTION' }),
            runner_experiment_id: status.experiment_id, runner_status: status.status, runner_step: status.current_step,
            ...(status.queue ? { runner_queue: status.queue } : {}) } }),
          pollIntervalMs: preflight.runner.pollIntervalMs,
          stageCandidate: async ({ candidate, experiment, workspace }, stageSignal) => {
            const root = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
            const remoteWorkspace = path.posix.join(
              root,
              runId,
              'candidates',
              safePathSegment(candidate.candidate_id),
              safePathSegment(experiment.experiment_id),
            );
            const staged = await stageRpcSource({ repository: workspace.repository, commit: candidate.source.commit,
              runner: runnerClient, remoteRoot: remoteWorkspace, localDirectory: path.join(snapshotDir, 'source-archives'),
              expectedSourceDigest: candidate.source.archive_sha256, signal: stageSignal });
            return {
              candidateId: candidate.candidate_id,
              workspacePath: staged.workspace_path,
              sourceSha256: candidate.source.archive_sha256,
            };
          },
          stageEvaluator: async ({ evaluator, experiment }, stageSignal) => {
            if (evaluator.id !== evaluatorSpec.id || evaluator.version !== evaluatorSpec.version || evaluator.sha256 !== evaluatorSpec.sha256) {
              throw new Error('requested evaluator differs from the preflight-verified evaluator bundle');
            }
            const root = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
            const remoteWorkspace = path.posix.join(
              root,
              runId,
              'evaluators',
              'experiments',
              safePathSegment(experiment.experiment_id),
              safePathSegment(evaluator.id),
              safePathSegment(evaluator.version),
              evaluator.sha256,
            );
            let stagedEvaluator = evaluatorStages.get(experiment.experiment_id);
            if (!stagedEvaluator) {
              stagedEvaluator = stageRemoteEvaluator({
                evaluatorRoot: evaluator.root,
                expectedDigest: evaluator.sha256,
                transport,
                remoteWorkspace,
                signal: stageSignal,
              });
              evaluatorStages.set(experiment.experiment_id, stagedEvaluator);
            }
            const staged = await stagedEvaluator;
            return {
              evaluatorId: evaluator.id,
              version: evaluator.version,
              workspacePath: staged.remote_workspace,
              digest: staged.digest,
            };
          },
          stageBaseline: async ({ baseline }, stageSignal) => {
            const declared = preflight.testpack.testpack.performance.baselines.comparison;
            if (baseline.id !== declared.id || baseline.version !== declared.version ||
                baseline.sha256.toLowerCase() !== declared.sha256.toLowerCase() || baseline.path !== declared.path) {
              throw new Error('requested Baseline differs from the preflight-verified Baseline');
            }
            const staged = await prepareComparisonBaseline(stageSignal);
            return {
              baselineId: baseline.id,
              workspacePath: staged.remote_artifact,
              sha256: staged.digest,
              ...(staged.library_paths ? { libraryPaths: staged.library_paths } : {}),
              ...(staged.dependencies ? { dependencies: staged.dependencies } : {}),
            };
          },
        });
        const developmentBundle = loadFormalEvaluatorBundle(evaluatorSpec.root, {
          requireQualified: true,
          expected: { evaluatorId: evaluatorSpec.id, version: evaluatorSpec.version, digest: evaluatorSpec.sha256 },
        });
        await experimentExecution.preflight(signal);
        update({ progress: { phase: 'PREPARING_BASELINE', last_event: '正在将已固定比较基线同步到 Runner，并核验文件身份' } });
        const developmentBaseline = await prepareComparisonBaseline(signal);
        update({ progress: { phase: 'BASELINE_READY', last_event: `比较基线已准备：${developmentBaseline.remote_artifact}` } });
        const developmentBuild = preflight.config.config.build;
        createDevelopmentInvestigation = (workspace) => {
          const snapshots = new Map<string, Promise<PreparedDevelopmentWorkspace>>();
          let assets: ReturnType<typeof stageRemoteDevelopmentAssets> | undefined;
          const controller = new RunnerDevelopmentInvestigation({
            backend,
            taskId,
            buildCommand: {
              executable: developmentBuild.executable,
              args: [...developmentBuild.args],
              cwd: path.resolve(workspace.repository, developmentBuild.cwd),
              environment: { ...developmentBuild.environment },
              timeout_ms: developmentBuild.timeout_ms,
            },
            buildCwdRelative: developmentBuild.cwd,
            candidateArtifactRelativePath: candidateArtifactRelativePath(preflight.testpack.testpack.performance.baselines.current.path),
            baseline: {
              id: comparisonBaseline.id,
              version: comparisonBaseline.version,
              digest: comparisonBaseline.sha256,
              details: { path: developmentBaseline.remote_artifact, library: comparisonBaseline.library,
                libraryPaths: developmentBaseline.library_paths, dependencies: developmentBaseline.dependencies },
            },
            resources: {
              cpuSet: preflight.testpack.testpack.resources.cpu_set,
              numaNode: preflight.testpack.testpack.resources.numa_nodes[0] ?? 0,
            },
            workloads: developmentBundle.workloads.workloads.filter((item) => !preflight.libraryPackage ||
              preflight.libraryPackage.target.development_benchmark.workload_ids.includes(item.workload_id)),
            evaluatorSetup: {
              executable: developmentBundle.manifest.correctness.command.executable,
              script: 'scripts/build-evaluator.sh',
            },
            performanceCommand: developmentBundle.manifest.performance.command,
            testPlan: readValidationTestPlan(developmentBundle.root, developmentBundle.manifest, developmentBundle.manifest.domain.api),
            inspectionSymbols: [
              preflight.request.function_name,
              developmentBundle.manifest.domain.api,
            ],
            pollIntervalMs: rpcRunner.pollIntervalMs,
            onPlan: plan => session!.record('development-job', plan),
            onCompleted: () => session!.record('development-job', null),
            prepareWorkspace: async ({ signal: developmentSignal }) => {
              const source = await snapshotEditingSource(workspace);
              const existing = snapshots.get(source.tree);
              if (existing) return existing;
              const targetRoot = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
              const generation = this.records.get(workflowId)?.continuation_count ?? 0;
              const requestRoot = path.posix.join(targetRoot, runId, 'development', 'sources', source.tree, `${source.commit.slice(0, 12)}-c${generation}`);
              const prepared = (async (): Promise<PreparedDevelopmentWorkspace> => {
              const staged = await stageRpcSource({ repository: workspace.repository, commit: source.commit,
                runner: runnerClient, remoteRoot: requestRoot, localDirectory: path.join(snapshotDir, 'source-archives'), signal: developmentSignal });
              assets ??= stageRemoteDevelopmentAssets({
                evaluatorRoot: evaluatorSpec.root,
                transport,
                remoteWorkspace: path.posix.join(targetRoot, runId, 'development', 'assets'),
                signal: developmentSignal,
              });
              const stagedAssets = await assets;
              return {
                candidate: {
                  candidate_id: `development-source:${source.commit}`,
                  commit: source.commit,
                  tree: source.tree,
                  source_sha256: staged.source_sha256,
                  workspace_path: staged.workspace_path,
                },
                assetsRoot: stagedAssets.remote_workspace,
              };
              })();
              snapshots.set(source.tree, prepared);
              try { return await prepared; }
              catch (error) { snapshots.delete(source.tree); assets = undefined; throw error; }
            },
          });
          return {
            toolOptions: {
              requireDevelopmentFindingsBeforeMutation: true,
              inspectMachine: async (developmentSignal) => developmentToolText(await controller.inspectMachine(developmentSignal)),
              inspectBinary: async (toolInput, developmentSignal) => developmentToolText(await controller.inspectBinary(toolInput, developmentSignal)),
              disassemble: async (toolInput, developmentSignal) => developmentToolText(await controller.disassemble(toolInput, developmentSignal)),
              runDevBenchmark: async (toolInput, developmentSignal) => developmentToolText(await controller.runDevBenchmark(toolInput, developmentSignal)),
              profilePerfStat: async (toolInput, developmentSignal) => developmentToolText(await controller.profilePerfStat(toolInput, developmentSignal)),
            },
            runGate: (workloadIds, developmentSignal) => controller.runDevelopmentGate(workloadIds, developmentSignal),
          };
        };
      }
      const result = await runPublicAgentWorkflow({
        preflight,
        repository: prepared.repository,
        baselineCommit,
        ...(preflight.source ? { sourceBranch: preflight.source.branch } : {}),
        // 临时双工作树放在算法库之外，避免其本身让基准工作区变脏。
        worktreeRoot: localWorktreeRoot(repositoryRoot, this.options.worktreeRoot),
        runId,
        maxRounds: this.options.publicMaxRounds ?? budget.max_candidates,
        ...(resumeFrom ? { resumeFrom } : {}),
        saveCheckpoint: checkpoint => session!.checkpoint(JSON.parse(JSON.stringify(checkpoint, (key, value) => ['stdout', 'stderr'].includes(key) && typeof value === 'string' ? value.slice(-8192) : value))),
        ...(this.options.publicInitialFeedback === undefined ? {} : { initialFeedback: this.options.publicInitialFeedback }),
        enablePerformance: recordPerformance(this.records.get(workflowId), this.options.publicEnablePerformance),
        ...(preflight.runner.mode === 'legacy' && transport.transport_type !== 'mock'
          ? { remote: { transport, workspace_root: preflight.config.config.target.workspace_root } }
          : {}),
        ...(experimentExecution ? { experimentExecution } : {}),
        ...(createDevelopmentInvestigation ? { createDevelopmentInvestigation } : {}),
        reasoning: {
          history: () => this.runtime.reasoningHistory(taskId),
          propose: (proposal, parentHypothesisId) => this.runtime.proposeHypothesis({ taskId, parentHypothesisId, proposal, agentIdentity: { provider_id: COREPILOT_PI_PROVIDER_ID, model_id: modelConfig.modelId } }),
          abandon: (hypothesisId, reason) => this.runtime.abandonHypothesis(taskId, hypothesisId, reason),
        },
        signal,
        lifecycle: {
          candidateCheckpointed: ({ workspace, checkpoint, agent }) => {
            const candidate = this.runtime.recordCandidate({
              taskId,
              hypothesisId: agent.hypothesis_id!,
              workspace,
              checkpoint,
              hypothesis: (agent.hypothesis ?? agent.text) || null,
              developmentFindings: agent.development_findings,
              agentIdentity: {
                provider_id: COREPILOT_PI_PROVIDER_ID,
                model_id: modelConfig.modelId,
                reasoning_effort: modelConfig.reasoningEffort ?? null,
                turns: agent.turns,
                tool_calls: agent.tool_calls,
              },
            });
            update({ candidate_id: candidate.candidate_id });
            return candidate.candidate_id;
          },
          experimentStarted: ({ candidateId }) => {
            const experiment = this.runtime.startExperiment({
              taskId,
              candidateId,
              type: 'FORMAL_EVALUATION',
              initialStatus: preflight.runner.mode === 'rpc' ? 'PENDING' : 'RUNNING',
            });
            update({ experiment_id: experiment.experiment_id });
            return experiment.experiment_id;
          },
          experimentCompleted: ({ experimentId, validation, performance }) => {
            this.runtime.completeValidationExperiment({
              experimentId,
              validation,
              performance,
              factsAlreadyPersisted: preflight.runner.mode === 'rpc',
            });
          },
          revalidationStarted: ({ candidateId }) => {
            const experiment = this.runtime.startExperiment({
              taskId,
              candidateId,
              type: 'REVALIDATION',
              initialStatus: preflight.runner.mode === 'rpc' ? 'PENDING' : 'RUNNING',
            });
            update({ revalidation_experiment_id: experiment.experiment_id });
            return experiment.experiment_id;
          },
          revalidationCompleted: ({ experimentId, revalidation: result_ }) => {
            this.runtime.completeRevalidationExperiment({
              experimentId,
              revalidation: result_,
              factsAlreadyPersisted: preflight.runner.mode === 'rpc',
            });
          },
          experimentFailed: ({ experimentId, error, cancelled, remoteStateUnknown }) => {
            this.runtime.failExperiment({ experimentId, error: clean(error), cancelled, remoteStateUnknown });
          },
        },
        onProgress: async (progress) => { update({
          progress: { phase: progress.phase, ...(progress.round === undefined ? {} : { round: progress.round }), last_event: progress.last_event },
          ...(progress.workspace?.editing ? { workspace_editing: progress.workspace.editing } : {}),
          ...(progress.workspace?.validation ? { workspace_validation: progress.workspace.validation } : {}),
          ...(progress.workspace?.baseline_commit ? { baseline_commit: progress.workspace.baseline_commit } : {}),
          ...(progress.checkpoint ? { candidate_commit: progress.checkpoint.commit, candidate_tree: progress.checkpoint.tree, candidate_files: progress.checkpoint.files, source_archive_sha256: progress.checkpoint.source_archive_sha256 } : {}),
          ...(progress.validation ? { validation_result: summarizeValidation(progress.validation) } : {}),
          ...(progress.performance ? { performance_result: progress.performance as unknown as Record<string, unknown> } : {}),
          ...(progress.revalidation ? { revalidation_result: summarizeRevalidation(progress.revalidation) } : {}),
          ...(progress.development_findings !== undefined ? { development_findings: progress.development_findings } : {}),
          ...(progress.development_gate !== undefined ? { development_gate: progress.development_gate } : {}),
          ...(progress.candidate_evaluation_feedback !== undefined ? { candidate_evaluation_feedback: progress.candidate_evaluation_feedback } : {}),
          ...(progress.candidate_evaluation_decision !== undefined ? { candidate_evaluation_decision: progress.candidate_evaluation_decision } : {}),
          ...(progress.hypothesis_id ? { hypothesis_id: progress.hypothesis_id } : {}),
        }); await session!.progress({ phase: progress.phase, ...(progress.last_event ? { last_event: clean(progress.last_event) } : {}) }); },
        runAgent: async (tools: readonly AgentTool[], prompt: string, agentSignal: AbortSignal) => {
          const result = await session!.run(continuationMessage ? `${prompt}\n用户补充要求：${continuationMessage}` : prompt,
            tools, agentSignal, budget.time_limit_ms - (Date.now() - continuationStarted), afterSavedEvaluation);
          afterSavedEvaluation = false;
          continuationMessage = undefined;
          update({ agent_session: await session!.summary() });
          const pending = await session!.readRecord<ExperimentExecutionPlan | null>('development-job');
          if (pending) return { ...result, ok: false, no_source_mutation: false, interrupted: true,
            error: `Runner 开发实验 ${pending.experiment.experiment_id} 的状态尚未确认，现场已保留；继续时先核对原实验。` };
          return result;
        },
      });
      const terminalStatus = result.status;
      const stopReason = result.status === 'VALIDATION_BLOCKED' || resumeFrom?.validationOnly ? result.error ?? result.performance?.reason : result.agent?.text;
      update({
        status: terminalStatus,
        ...(['NO_CANDIDATE', 'PERFORMANCE_THRESHOLD_NOT_MET', 'VALIDATION_BLOCKED'].includes(result.status) && stopReason ? { stop_reason: clean(stopReason.slice(0, 8192)) } : {}),
        progress: { phase: result.status, round: result.rounds, last_event: clean(result.error ?? (result.status === 'BUDGET_EXHAUSTED' ? '本次探索预算已用完，工作区和会话已保留，可继续优化。' : result.status === 'WAITING_APPROVAL' ? '测试与独立复验完成，等待人工审阅。' : '本次优化已结束，过程和实验记录已保存。')) },
        workspace_editing: result.workspace.editing,
        workspace_validation: result.workspace.validation,
        baseline_commit: result.workspace.baseline_commit,
        ...(result.checkpoint ? { candidate_commit: result.checkpoint.commit, candidate_tree: result.checkpoint.tree, candidate_files: result.checkpoint.files, source_archive_sha256: result.checkpoint.source_archive_sha256 } : {}),
        ...(result.validation ? { validation_result: summarizeValidation(result.validation) } : {}),
        ...(result.performance ? { performance_result: result.performance as unknown as Record<string, unknown> } : {}),
        ...(result.revalidation ? { revalidation_result: summarizeRevalidation(result.revalidation) } : {}),
        ...(result.agent ? { development_findings: result.agent.development_findings } : {}),
        ...(result.development_gate !== undefined ? { development_gate: result.development_gate } : {}),
        ...(result.error ? { error: clean(result.error) } : {}),
      });
      this.runtime.setTaskStatus(taskId, result.status === 'WAITING_APPROVAL'
        ? 'WAITING_APPROVAL'
        : result.status === 'PERFORMANCE_THRESHOLD_NOT_MET' || result.status === 'NO_CANDIDATE'
          ? 'COMPLETED'
          : result.status === 'BUDGET_EXHAUSTED' || result.status === 'INTERRUPTED' || result.status === 'VALIDATION_BLOCKED' ? result.status
          : result.status === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED');
    } catch (error) {
      const message = clean((error as Error).message);
      const status = error instanceof RemoteExperimentUnknownError || signal.reason === 'backend shutting down' ? 'INTERRUPTED' : signal.aborted ? 'CANCELLED' : 'FAILED';
      update({ status, error: message, progress: { phase: status, last_event: message } });
      this.runtime.setTaskStatus(taskId, status);
    } finally {
      if (session) {
        try { update({ agent_session: await session.summary() }); await session.close(); }
        catch (error) { update({ report_error: clean(`Agent 会话关闭失败：${(error as Error).message}`) }); }
        this.sessions.delete(workflowId);
      }
      try {
        const report = this.report(workflowId);
        if (report) {
          const files = await writeOptimizationReport(path.join(preflight.config.config.output_dir, workflowId.replace(/^workflow:/, '').replace(/[^a-zA-Z0-9._-]/g, '_')), report);
          update({ report_files: files, report_error: null });
        }
      } catch (error) {
        update({ report_error: clean((error as Error).message) });
      }
      try {
        await modelTransport?.close();
      } catch {
        // Transport cleanup must not replace the workflow result.
      }
    }
  }

  async sessionEvents(workflowId: string, after = 0, limit = 100): Promise<OptimizationSessionEvents | null> {
    const record = this.records.get(workflowId);
    if (!record) return null;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid session event cursor or limit');
    if (!record.agent_session) return { events: [], next_cursor: after };
    const active = this.sessions.get(workflowId);
    return active ? active.events(after, limit) : readOptimizationSessionEvents(record.agent_session.directory, record.agent_session.id, after, limit);
  }

  async sendMessage(workflowId: string, message: string): Promise<void> {
    if (typeof message !== 'string' || !message.trim() || message.length > 16_384) throw new Error('补充要求需为 1–16384 字符');
    const session = this.sessions.get(workflowId);
    if (!session || !this.controllers.has(workflowId)) throw new Error('当前会话未运行，请使用「继续优化」并填写补充要求。');
    await session.steer(message.trim());
  }

  private launchSourceWorkflow(workflowId: string, preflight: SourceOptimizationPreflight, resume = false, message?: string): void {
    const controller = new AbortController();
    this.controllers.set(workflowId, controller);
    const running = executeSourceOptimization({ workflowId, preflight, runtime: this.runtime, store: this.options.store,
      records: this.records, worktreeRoot: this.options.worktreeRoot, signal: controller.signal, resume, message,
      attachSession: session => { if (session) this.sessions.set(workflowId, session); else this.sessions.delete(workflowId); },
    }).finally(() => { this.controllers.delete(workflowId); this.running.delete(workflowId); });
    this.running.set(workflowId, running);
  }

  private resumeSourceWorkflow(record: OptimizationWorkflowRecord, input: { message?: string; budget?: Partial<OptimizationSessionBudget>; cliApiKey?: string }): { workflow_id: string; status: string } {
    if (!record.agent_session || !['BUDGET_EXHAUSTED', 'INTERRUPTED', 'FAILED', 'NO_CANDIDATE', 'CANDIDATE_READY'].includes(record.status)) throw new Error('此任务没有可继续的源码会话。');
    const selectedMachine = this.runtime.getTask(record.optimization_task_id!).declared_context.requested_machine_id;
    const preflight = loadSourceOptimizationPreflight({ verification_mode: 'source_only', function_name: record.function_name,
      entry_file: record.entry_file, config_path: record.config_path, repository_root: record.repository_root,
      ...(typeof selectedMachine === 'string' ? { machine_id: selectedMachine } : {}),
    }, { cliApiKey: input.cliApiKey, readMachine: id => this.options.store.getExecutionMachine(id) });
    if (record.execution_contract_digest !== sourceOptimizationContractDigest(preflight)) throw new Error('源码范围、声明目标或构建上下文已改变，请创建新任务；原任务保持源码优化模式。');
    if (record.baseline_commit) preflight.source = { branch: record.source_branch ?? 'detached', commit: record.baseline_commit };
    record.session_budget = resolveOptimizationBudget(input.budget ?? record.session_budget);
    record.continuation_count = (record.continuation_count ?? 0) + 1;
    record.status = 'GENERATING'; record.error = null; delete record.stop_reason;
    record.progress = { phase: 'RESUMING', last_event: '正在恢复源码工作区与原 Agent 会话' };
    record.updated_at = new Date().toISOString(); this.records.save(record);
    this.launchSourceWorkflow(record.workflow_id, preflight, true, input.message);
    return { workflow_id: record.workflow_id, status: record.status };
  }

  resumePublic(workflowId: string, input: { message?: string; budget?: Partial<OptimizationSessionBudget>; cliApiKey?: string; packageLoader?: LibraryPackageLoader } = {}): { workflow_id: string; status: string } {
    if (this.stopping) throw new Error('后台正在停止，请稍后重试。');
    const record = this.records.get(workflowId);
    if (!record) throw new Error('workflow not found');
    if (record.delivery_operation && record.delivery_operation.status !== 'COMPLETED') throw new Error('当前交付尚未结束，请先核对或撤回交付请求。');
    if (this.controllers.has(workflowId)) return { workflow_id: workflowId, status: record.status };
    if (input.message !== undefined && (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16_384)) throw new Error('补充要求需为 1–16384 字符');
    if (record.verification_mode === 'source_only') return this.resumeSourceWorkflow(record, input);
    if (isWorkflowValidationBlocked(record)) throw new Error('验证环境异常不会通过修改候选修复；请使用「重新验证当前候选」或 workflow retry-validation。');
    if (!record.agent_session || !['BUDGET_EXHAUSTED', 'INTERRUPTED', 'FAILED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'NO_CANDIDATE', 'GENERATING', 'CREATED'].includes(record.status)) throw new Error('此任务没有可继续的 Agent 会话；旧记录仍可查看报告。');
    const budget = resolveOptimizationBudget(input.budget ?? record.session_budget);
    const preflight = this.continuationPreflight(record, input);
    record.session_budget = budget;
    record.continuation_count = (record.continuation_count ?? 0) + 1;
    record.status = 'GENERATING'; record.error = null; delete record.stop_reason;
    record.progress = { ...record.progress, phase: 'RESUMING', last_event: '正在恢复原会话、源码工作区和已有 Runner 实验' };
    record.updated_at = new Date().toISOString();
    this.records.save(record);
    const controller = new AbortController();
    this.controllers.set(workflowId, controller);
    const running = this.executePublic(workflowId, preflight, controller.signal, true, input.message).finally(() => {
      this.controllers.delete(workflowId); this.running.delete(workflowId);
    });
    this.running.set(workflowId, running);
    return { workflow_id: workflowId, status: 'GENERATING' };
  }

  retryValidationPublic(workflowId: string, input: { expectedCandidateId?: string; cliApiKey?: string; packageLoader?: LibraryPackageLoader } = {}): { workflow_id: string; status: string } {
    if (this.stopping) throw new Error('后台正在停止，请稍后重试。');
    const record = this.records.get(workflowId);
    if (!record) throw new Error('workflow not found');
    if (record.verification_mode === 'source_only') throw new Error('此任务仅生成未验证源码，请创建独立测试任务验证候选；不能切换为原任务内验证。');
    if (record.delivery_operation && record.delivery_operation.status !== 'COMPLETED') throw new Error('当前交付尚未结束，请先核对或撤回交付请求。');
    if (input.expectedCandidateId && record.candidate_id !== input.expectedCandidateId) throw new Error('当前候选已改变，请刷新后再操作。');
    if (this.controllers.has(workflowId)) return { workflow_id: workflowId, status: record.status };
    if (!canRetryWorkflowValidation(record)) throw new Error('当前任务没有已完成验证且可重新验证的冻结候选。');
    const experimentId = record.candidate_evaluation_feedback?.experiment_id;
    if (!experimentId) throw new Error('缺少上次实验身份，请先核对 Runner 状态。');
    const previous = this.runtime.getExperiment(experimentId);
    if (previous.candidate_id !== record.candidate_id || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(previous.status)) {
      throw new Error('上次实验状态尚未确认；请先核对原实验，不能重复启动。');
    }
    if (this.options.store.listExperiments(record.optimization_task_id!).some(experiment => experiment.candidate_id === record.candidate_id
      && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(experiment.status))) {
      throw new Error('当前候选仍有未确认终态的实验或复验；请先继续并核对原实验，不能重复启动。');
    }
    const preflight = this.continuationPreflight(record, input);
    record.status = 'GENERATING'; record.error = null; delete record.stop_reason;
    record.validation_retry_count = (record.validation_retry_count ?? 0) + 1;
    record.candidate_evaluation_decision = null;
    record.progress = { ...record.progress, phase: 'RETRYING_VALIDATION', last_event: '正在重新验证当前冻结候选，原实验保留；本次不调用模型。' };
    record.updated_at = new Date().toISOString(); this.records.save(record);
    const controller = new AbortController(); this.controllers.set(workflowId, controller);
    const running = this.executePublic(workflowId, preflight, controller.signal, true, undefined, true).finally(() => {
      this.controllers.delete(workflowId); this.running.delete(workflowId);
    });
    this.running.set(workflowId, running);
    return { workflow_id: workflowId, status: 'GENERATING' };
  }

  private continuationPreflight(record: OptimizationWorkflowRecord, input: { cliApiKey?: string; packageLoader?: LibraryPackageLoader }) {
    const preflight = loadPublicOptimizationPreflight({ function_name: record.function_name, entry_file: record.entry_file,
      config_path: record.config_path, repository_root: record.repository_root, enable_performance: record.enable_performance,
      ...(record.execution_machine ? { machine_id: record.execution_machine.machine_id } : {}) },
    { cliApiKey: input.cliApiKey, resolveMachine: id => new ExecutionMachineService(this.options.store).resolve(id), packageLoader: input.packageLoader });
    if (record.execution_contract_digest !== executionContractDigest(preflight)) throw new Error('构建、验证方案或执行机器已改变；请使用新配置创建任务，原会话的实验口径保持固定。模型与凭据可以更新后继续。');
    if (record.baseline_commit) preflight.source = { branch: record.source_branch ?? 'detached', commit: record.baseline_commit };
    return preflight;
  }

  approvePublic(workflowId: string, input: { expectedBaselineCommit?: string; commitMessage: string }): Promise<DeliveryResult> {
    return this.deliveries.submit(workflowId, input);
  }

  cancel(workflowId: string): { ok: boolean; status: string; message: string } {
    const record = this.records.get(workflowId);
    if (!record) return { ok: false, status: 'NOT_FOUND', message: `workflow '${workflowId}' not found` };
    if (['DELIVERABLE', 'FAILED', 'CANCELLED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'CANDIDATE_READY', 'NO_CANDIDATE'].includes(record.status)) return { ok: true, status: record.status, message: 'workflow already terminal' };
    const controller = this.controllers.get(workflowId);
    if (!controller) return { ok: false, status: record.status, message: 'workflow is not active in this backend process' };
    controller.abort('cancelled by user');
    // A request is not a confirmed process fact. executePublic records the
    // terminal workflow/task state only after the selected backend responds.
    record.progress = { ...(record.progress ?? { phase: 'CANCEL_REQUESTED' }), phase: 'CANCEL_REQUESTED', last_event: 'cancellation requested by user' };
    record.updated_at = new Date().toISOString();
    this.records.save(record);
    return { ok: true, status: 'CANCEL_REQUESTED', message: 'workflow cancellation requested' };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.deliveries.stop();
    await this.reproductions.stop();
    for (const controller of this.controllers.values()) controller.abort('backend shutting down');
    await Promise.allSettled([...this.running.values()]);
  }
}

function executionContractDigest(preflight: ReturnType<typeof loadPublicOptimizationPreflight>): string {
  return createHash('sha256').update(JSON.stringify({ function_name: preflight.request.function_name,
    build: preflight.config.config.build, testpack: preflight.testpack.rawSha256,
    machine: preflight.executionMachine?.machine_id ?? null,
    runner: preflight.runner.mode === 'rpc' ? preflight.runner.endpoint : 'legacy',
    workspace: preflight.config.config.target.workspace_root,
  })).digest('hex');
}

function recordPerformance(record: OptimizationWorkflowRecord | null, fallback = false): boolean {
  return record?.enable_performance ?? fallback;
}

function safePathSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('domain identity cannot be mapped to a staging path');
  return safe;
}

function candidateArtifactRelativePath(configured: string): string {
  const relative = candidateRelativePath(configured);
  if (relative === null) {
    throw new Error('development investigation requires the current library path under ${COREPILOT_CANDIDATE_ROOT}');
  }
  return relative;
}
