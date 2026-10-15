import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { PublicWorkflowRequest } from '../contracts/public-workflow.js';
import { loadPublicOptimizationPreflight } from './public-optimization.js';
import { createPiModels, PHYOPT_PI_PROVIDER_ID, type PiRuntimeModelConfig } from '../model/pi-provider.js';
import { verifyToolCalling } from '../model/tool-verification.js';
import { createModelTransport, type ModelTransport } from '../model/model-transport.js';
import { createPiRuntimeStream, runPiAgentRuntime, type AgentTool } from '../agent/pi-agent-runtime.js';
import { runPublicAgentWorkflow, type PublicDevelopmentInvestigation } from './public-agent-workflow.js';
import { approveAndCleanup } from '../workspace/candidate-approval.js';
import { currentCandidateSourceIdentity, ensureCandidateRepository, type CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import { freezeValidationTestpack } from '../testpack/validation-freeze.js';
import { stageRemoteBaseline, stageRemoteCandidate, stageRemoteEvaluator, type StagedRemoteBaseline, type StagedRemoteEvaluator, type RemoteValidationTransport, type ValidationCycleResult, type RevalidationCycleResult, type CommandRunResult } from '../workspace/validation-runner.js';
import type { TargetConfig } from '../config/target-config.js';
import { initialOptimizationWorkflowRecord, SqliteOptimizationWorkflowStore } from './optimization-workflow.js';
import { OptimizationRuntime } from '../core/optimization-runtime.js';
import { RunnerClient } from '../client/runner-client.js';
import { RunnerClientExperimentExecutionBackend } from '../core/experiment-execution-backend.js';
import { RpcExperimentTransitionAdapter } from '../core/rpc-experiment-transition-adapter.js';
import { RunnerDevelopmentInvestigation, stageRemoteDevelopmentAssets } from '../core/development-investigation.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { packageOptimizationTaskInput } from '../library-package/task-definition.js';

export interface OptimizationWorkflowServiceOptions {
  /** 保留 host 参数仅用于已有服务装配；public workflow 不依赖旧 task runner。 */
  host?: unknown;
  store: TaskStore;
  reportDir?: string;
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

function localWorktreeRoot(repository: string): string {
  const identity = createHash('sha256').update(path.resolve(repository)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'phyopt-worktrees', identity);
}

/** 新 public optimize 工作流的唯一后端入口。 */
export class OptimizationWorkflowService {
  private readonly records: SqliteOptimizationWorkflowStore;
  private readonly runtime: OptimizationRuntime;
  private readonly running = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly options: OptimizationWorkflowServiceOptions) {
    this.records = new SqliteOptimizationWorkflowStore(options.store);
    this.runtime = new OptimizationRuntime(options.store);
  }

  get(workflowId: string): OptimizationWorkflowRecord | null {
    return this.records.get(workflowId);
  }

  submitPublic(request: PublicWorkflowRequest, options: { cliApiKey?: string } = {}): { workflowId: string } {
    const preflight = loadPublicOptimizationPreflight(request, { cliApiKey: options.cliApiKey });
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
    const taskInput = {
      workflowId,
      target: {
        kind: 'software_function',
        name: request.function_name,
        scope: {
          entry_file: request.entry_file,
          repository_root: request.repository_root ?? preflight.config.configDir,
          testpack_id: preflight.testpack.testpack.testpack_id,
          function_family: preflight.testpack.testpack.function_family,
          operation: preflight.testpack.testpack.operation,
          data_type: preflight.testpack.testpack.data_type,
          build: {
            executable: preflight.config.config.build.executable,
            args: [...preflight.config.config.build.args],
            cwd: preflight.config.config.build.cwd,
          },
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
      sourceBaseline: {
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

  private async executePublic(workflowId: string, preflight: ReturnType<typeof loadPublicOptimizationPreflight>, signal: AbortSignal): Promise<void> {
    const update = (patch: Partial<OptimizationWorkflowRecord>) => {
      const record = this.records.get(workflowId);
      if (!record) return;
      Object.assign(record, patch, { updated_at: new Date().toISOString() });
      this.records.save(record);
    };
    const clean = (text: string) => redact(text, preflight.credential.apiKey);
    const taskId = this.records.get(workflowId)?.optimization_task_id;
    if (!taskId) {
      update({ status: 'FAILED', error: 'optimization task identity is missing', progress: { phase: 'FAILED', last_event: 'optimization task identity is missing' } });
      return;
    }
    let modelTransport: ModelTransport | undefined;
    try {
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
      const baseModel = models.getModel(PHYOPT_PI_PROVIDER_ID, modelConfig.modelId);
      if (!baseModel) throw new Error(`模型未加载：${modelConfig.modelId}`);
      const verification = await verifyToolCalling(modelConfig, { models, timeoutMs: preflight.config.config.model.timeout_ms, signal, fetch: modelFetch });
      if (!verification.ok) throw new Error(`模型工具调用能力验证失败：${verification.error ?? '未返回合法 tool call'}`);

      const repositoryRoot = preflight.request.repository_root ?? preflight.config.configDir;
      const prepared = ensureCandidateRepository(repositoryRoot);
      const currentTask = this.runtime.getTask(taskId);
      this.runtime.updateTask(taskId, {
        status: 'RUNNING',
        source_baseline: {
          id: `git:${prepared.baselineCommit}`,
          digest: prepared.baselineCommit,
          details: { repository: prepared.repository },
        },
        declared_context: currentTask.declared_context,
      });
      const runId = workflowId.replace(/^workflow:/, '').replace(/[^A-Za-z0-9_-]/g, '_');
      const snapshotDir = path.join(preflight.config.config.output_dir, runId);
      const frozen = freezeValidationTestpack(preflight.testpack.testpack, snapshotDir);
      update({ status: 'GENERATING', repository_root: prepared.repository, baseline_commit: prepared.baselineCommit, testpack_snapshot_path: path.join(snapshotDir, 'validation-testpack.json'), target_identity: { ...preflight.config.config.target }, progress: { phase: 'PUBLIC_WORKSPACE_STARTING', last_event: `frozen validation testpack ${frozen.digest}` } });

      const model = baseModel;
      const transport = this.options.publicValidationTransportFactory?.(preflight.config.config.target) ?? this.options.transportFactory();
      let experimentExecution: RpcExperimentTransitionAdapter | undefined;
      let createDevelopmentInvestigation: ((workspace: CandidateWorkspaceState) => PublicDevelopmentInvestigation) | undefined;
      if (preflight.runner.mode === 'rpc') {
        const rpcRunner = preflight.runner;
        const evaluatorSpec = preflight.testpack.testpack.evaluator;
        if (!evaluatorSpec) throw new Error('RPC formal execution requires a verified evaluator bundle');
        let stagedEvaluator: Promise<StagedRemoteEvaluator> | undefined;
        let stagedBaseline: Promise<StagedRemoteBaseline> | undefined;
        const backend = new RunnerClientExperimentExecutionBackend(new RunnerClient({
          baseUrl: preflight.runner.endpoint,
          token: preflight.runner.token,
          requestTimeoutMs: preflight.runner.requestTimeoutMs,
        }));
        experimentExecution = new RpcExperimentTransitionAdapter({
          backend,
          runtime: this.runtime,
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
            const staged = await stageRemoteCandidate({
              workspace,
              transport,
              remoteWorkspace,
              signal: stageSignal,
            });
            return {
              candidateId: candidate.candidate_id,
              workspacePath: staged.remote_workspace,
              sourceSha256: candidate.source.archive_sha256,
            };
          },
          stageEvaluator: async ({ evaluator }, stageSignal) => {
            if (evaluator.id !== evaluatorSpec.id || evaluator.version !== evaluatorSpec.version || evaluator.sha256 !== evaluatorSpec.sha256) {
              throw new Error('requested evaluator differs from the preflight-verified evaluator bundle');
            }
            const root = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
            const remoteWorkspace = path.posix.join(
              root,
              runId,
              'evaluators',
              safePathSegment(evaluator.id),
              safePathSegment(evaluator.version),
              evaluator.sha256,
            );
            stagedEvaluator ??= stageRemoteEvaluator({
              evaluatorRoot: evaluator.root,
              expectedDigest: evaluator.sha256,
              transport,
              remoteWorkspace,
              signal: stageSignal,
            });
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
            const root = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
            const remoteWorkspace = path.posix.join(
              root,
              runId,
              'baselines',
              safePathSegment(baseline.id),
              safePathSegment(baseline.version),
              baseline.sha256.toLowerCase(),
            );
            stagedBaseline ??= stageRemoteBaseline({
              sourceArtifact: baseline.path,
              expectedDigest: baseline.sha256,
              transport,
              remoteWorkspace,
              signal: stageSignal,
            });
            const staged = await stagedBaseline;
            return {
              baselineId: baseline.id,
              workspacePath: staged.remote_artifact,
              sha256: staged.digest,
            };
          },
        });
        const developmentBundle = loadFormalEvaluatorBundle(evaluatorSpec.root, {
          requireQualified: true,
          expected: { evaluatorId: evaluatorSpec.id, version: evaluatorSpec.version, digest: evaluatorSpec.sha256 },
        });
        const comparisonBaseline = preflight.testpack.testpack.performance.baselines.comparison;
        const developmentBuild = preflight.config.config.build;
        createDevelopmentInvestigation = (workspace) => {
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
              details: { path: comparisonBaseline.path, library: comparisonBaseline.library },
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
            inspectionSymbols: [
              preflight.request.function_name,
              developmentBundle.manifest.domain.api,
            ],
            pollIntervalMs: rpcRunner.pollIntervalMs,
            prepareWorkspace: async ({ requestId, signal: developmentSignal }) => {
              const source = currentCandidateSourceIdentity(workspace);
              const targetRoot = preflight.config.config.target.workspace_root.replace(/\\/g, '/').replace(/\/+$/, '');
              const requestRoot = path.posix.join(targetRoot, runId, 'development', safePathSegment(requestId));
              const staged = await stageRemoteCandidate({
                workspace,
                transport,
                remoteWorkspace: path.posix.join(requestRoot, 'candidate'),
                signal: developmentSignal,
              });
              const assets = await stageRemoteDevelopmentAssets({
                evaluatorRoot: evaluatorSpec.root,
                transport,
                remoteWorkspace: path.posix.join(requestRoot, 'assets'),
                signal: developmentSignal,
              });
              return {
                candidate: {
                  candidate_id: `development-source:${source.commit}`,
                  commit: source.commit,
                  tree: source.tree,
                  source_sha256: source.source_sha256,
                  workspace_path: staged.remote_workspace,
                },
                assetsRoot: assets.remote_workspace,
              };
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
        await experimentExecution.preflight(signal);
      }
      const result = await runPublicAgentWorkflow({
        preflight,
        repository: prepared.repository,
        // 临时双工作树放在算法库之外，避免其本身让基准工作区变脏。
        worktreeRoot: localWorktreeRoot(repositoryRoot),
        runId,
        ...(this.options.publicMaxRounds === undefined ? {} : { maxRounds: this.options.publicMaxRounds }),
        ...(this.options.publicInitialFeedback === undefined ? {} : { initialFeedback: this.options.publicInitialFeedback }),
        enablePerformance: recordPerformance(this.records.get(workflowId), this.options.publicEnablePerformance),
        ...(preflight.runner.mode === 'legacy' && transport.transport_type !== 'mock'
          ? { remote: { transport, workspace_root: preflight.config.config.target.workspace_root } }
          : {}),
        ...(experimentExecution ? { experimentExecution } : {}),
        ...(createDevelopmentInvestigation ? { createDevelopmentInvestigation } : {}),
        reasoning: {
          history: () => this.runtime.reasoningHistory(taskId),
          propose: (proposal, parentHypothesisId) => this.runtime.proposeHypothesis({ taskId, parentHypothesisId, proposal, agentIdentity: { provider_id: PHYOPT_PI_PROVIDER_ID, model_id: modelConfig.modelId } }),
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
                provider_id: PHYOPT_PI_PROVIDER_ID,
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
        onProgress: (progress) => update({
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
        }),
        runAgent: (tools: readonly AgentTool[], prompt: string, agentSignal: AbortSignal) => runPiAgentRuntime(prompt, {
          systemPrompt: '你是 PhyOpt 性能优化 Agent。每轮必须先分析源码和上一轮失败 workload，再按需要调用 inspect_machine、inspect_binary、disassemble、run_dev_benchmark、profile_perf_stat 获取真实目标机诊断。调查完成后调用 record_development_findings 保存 observations、suspected bottleneck、supporting measurements、chosen transformation 和 rejected alternatives。只有证据支持修改时才形成一个聚焦 Candidate；证据不足时应停止。禁止把 DEVELOPMENT_ONLY 结果当成 Formal Evidence。Before the first source-mutating tool call, emit exactly one concise line beginning with `Hypothesis:` that states the expected performance mechanism and affected workloads.',
          model,
          tools,
          streamFn: createPiRuntimeStream(models, {
            fetch: modelFetch,
            timeoutMs: preflight.config.config.model.timeout_ms,
          }),
          thinkingLevel: preflight.config.config.model.reasoning_effort ?? 'off',
          sessionId: workflowId,
          stopAfterSuccessfulTools: ['write_file', 'create_file', 'replace_text', 'delete_file', 'move_file'],
          requireSuccessfulStopTool: true,
          textOnlyFollowUp: {
            maxAttempts: 4,
            message: 'Continue the current investigation. Inspect Optimization Reasoning History and failed evidence. Record a structured Hypothesis before source mutation. For feedback select REPAIR, ABANDON, or NEW_HYPOTHESIS using record_candidate_decision; repairs retain the Hypothesis and new hypotheses must be persisted as children. Do not manufacture a Candidate when evidence is insufficient.',
          },
          signal: agentSignal,
          onEvent: (event) => {
            let lastEvent: string | null = null;
            if (event.type === 'turn_start') lastEvent = 'Pi Agent model turn started';
            if (event.type === 'tool_execution_start') lastEvent = `Pi Agent tool started: ${event.toolName}`;
            if (event.type === 'tool_execution_end') lastEvent = `Pi Agent tool ${event.isError ? 'failed' : 'completed'}: ${event.toolName}`;
            if (!lastEvent) return;
            const currentProgress = this.records.get(workflowId)?.progress;
            update({
              progress: {
                phase: currentProgress?.phase ?? 'AGENT_EDITING',
                ...(currentProgress?.round === undefined ? {} : { round: currentProgress.round }),
                last_event: lastEvent,
              },
            });
          },
        }),
      });
      const terminalStatus = result.status === 'WAITING_APPROVAL'
        ? 'WAITING_APPROVAL'
        : result.status === 'PERFORMANCE_THRESHOLD_NOT_MET'
          ? 'PERFORMANCE_THRESHOLD_NOT_MET'
          : result.status === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED';
      update({
        status: terminalStatus,
        progress: { phase: result.status, round: result.rounds, last_event: clean(result.error ?? 'public Agent execution finished') },
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
        : result.status === 'PERFORMANCE_THRESHOLD_NOT_MET'
          ? 'COMPLETED'
          : result.status === 'CANCELLED'
            ? 'CANCELLED'
            : 'FAILED');
    } catch (error) {
      const message = clean((error as Error).message);
      update({ status: signal.aborted ? 'CANCELLED' : 'FAILED', error: message, progress: { phase: signal.aborted ? 'CANCELLED' : 'FAILED', last_event: message } });
      this.runtime.setTaskStatus(taskId, signal.aborted ? 'CANCELLED' : 'FAILED');
    } finally {
      try {
        await modelTransport?.close();
      } catch {
        // Transport cleanup must not replace the workflow result.
      }
    }
  }

  approvePublic(workflowId: string, input: { expectedBaselineCommit?: string; commitMessage: string }): { ok: true; commit: string; tree: string } | { ok: false; message: string } {
    const record = this.records.get(workflowId);
    if (!record) return { ok: false, message: `workflow '${workflowId}' not found` };
    if (record.status !== 'WAITING_APPROVAL') return { ok: false, message: `workflow is not waiting for approval (status: ${record.status})` };
    if (!record.repository_root || !record.workspace_editing || !record.workspace_validation || !record.candidate_commit || !record.baseline_commit) return { ok: false, message: 'workflow is missing candidate workspace identity' };
    const workspace: CandidateWorkspaceState = { repository: record.repository_root, baseline_commit: record.baseline_commit, run_id: path.basename(path.dirname(record.workspace_editing)), editing: record.workspace_editing, validation: record.workspace_validation, editing_created: true, validation_created: true, candidate_commit: record.candidate_commit, candidate_tree: record.candidate_tree ?? null };
    try {
      const merged = approveAndCleanup({ workspace, expectedBaselineCommit: input.expectedBaselineCommit ?? record.baseline_commit, commitMessage: input.commitMessage });
      record.status = 'DELIVERABLE';
      record.progress = { phase: 'DELIVERABLE', last_event: 'candidate approved and merged into baseline' };
      record.updated_at = new Date().toISOString();
      this.records.save(record);
      if (record.optimization_task_id) this.runtime.setTaskStatus(record.optimization_task_id, 'COMPLETED');
      return { ok: true, ...merged };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  cancel(workflowId: string): { ok: boolean; status: string; message: string } {
    const record = this.records.get(workflowId);
    if (!record) return { ok: false, status: 'NOT_FOUND', message: `workflow '${workflowId}' not found` };
    if (['DELIVERABLE', 'FAILED', 'CANCELLED'].includes(record.status)) return { ok: true, status: record.status, message: 'workflow already terminal' };
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

  stop(): void {
    for (const controller of this.controllers.values()) controller.abort('backend shutting down');
    this.controllers.clear();
    this.running.clear();
  }
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
  const normalized = configured.replace(/\\/g, '/');
  const marker = '${PHYOPT_CANDIDATE_ROOT}/';
  if (!normalized.startsWith(marker) || normalized.length === marker.length) {
    throw new Error('development investigation requires the current library path under ${PHYOPT_CANDIDATE_ROOT}');
  }
  return normalized.slice(marker.length);
}
