import path from 'node:path';
import { PiOptimizationSession } from '../agent/pi-optimization-session.js';
import { resolveOptimizationBudget } from '../contracts/optimization-session.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { OptimizationRuntime } from '../core/optimization-runtime.js';
import { createPiModels, COREPILOT_PI_PROVIDER_ID } from '../model/pi-provider.js';
import { createModelTransport, type ModelTransport } from '../model/model-transport.js';
import { verifyToolCalling } from '../model/tool-verification.js';
import { buildOptimizationReport, renderOptimizationReport } from '../report/optimization-report.js';
import { writeOptimizationReport } from '../report/write-report.js';
import type { TaskStore } from '../storage/task-store.js';
import { ensureCandidateRepository } from '../workspace/candidate-workspace.js';
import { finishWorkflowExecution, type OptimizationWorkflowStore } from './optimization-workflow.js';
import { localWorktreeRoot } from './optimization-workflow-paths.js';
import { runSourceAgentWorkflow, type SourceAgentCheckpoint } from './source-agent-workflow.js';
import type { SourceOptimizationPreflight } from './source-optimization.js';

export async function executeSourceOptimization(input: {
  workflowId: string;
  preflight: SourceOptimizationPreflight;
  runtime: OptimizationRuntime;
  store: TaskStore;
  records: OptimizationWorkflowStore;
  worktreeRoot?: string;
  signal: AbortSignal;
  resume?: boolean;
  message?: string;
  attachSession: (session: PiOptimizationSession | null) => void;
}): Promise<void> {
  const { workflowId, preflight, runtime, records, signal } = input;
  const clean = (text: string) => text.split(preflight.credential.apiKey).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  const update = (patch: Partial<OptimizationWorkflowRecord>) => {
    const current = records.get(workflowId);
    if (current) records.save({ ...current, ...patch, updated_at: new Date().toISOString() });
  };
  const record = records.get(workflowId)!;
  const taskId = record.optimization_task_id!;
  const runId = workflowId.replace(/^workflow:/, '').replace(/[^A-Za-z0-9_-]/g, '_');
  const outputDir = path.join(preflight.config.config.output_dir, runId);
  let transport: ModelTransport | undefined;
  let session: PiOptimizationSession | undefined;
  try {
    signal.throwIfAborted();
    const prepared = ensureCandidateRepository(preflight.repository);
    const baselineCommit = record.baseline_commit ?? preflight.source?.commit ?? prepared.baselineCommit;
    runtime.updateTask(taskId, { status: 'RUNNING', source_baseline: {
      id: `git:${baselineCommit}`, digest: baselineCommit,
      details: { repository: prepared.repository, ...(preflight.source ? { source_branch: preflight.source.branch } : {}) },
    } });
    update({ status: 'GENERATING', repository_root: prepared.repository, baseline_commit: baselineCommit,
      target_identity: { ...preflight.targetContext },
      progress: { phase: 'PUBLIC_WORKSPACE_STARTING', last_event: '正在准备源码优化会话；测试将作为独立任务执行。' } });
    transport = createModelTransport(preflight.model_proxy);
    const modelConfig = {
      modelId: preflight.config.config.model.model_id, endpoint: preflight.config.config.model.endpoint,
      apiKey: preflight.credential.apiKey, reasoningEffort: preflight.config.config.model.reasoning_effort,
      maxOutputTokens: preflight.config.config.model.max_output_tokens,
    };
    const models = createPiModels(modelConfig);
    const model = models.getModel(COREPILOT_PI_PROVIDER_ID, modelConfig.modelId);
    if (!model) throw new Error(`模型未加载：${modelConfig.modelId}`);
    session = await PiOptimizationSession.open({
      id: record.agent_session?.id ?? runId, directory: record.agent_session?.directory ?? path.join(outputDir, 'agent'),
      models, model, fetch: transport.fetch, thinkingLevel: modelConfig.reasoningEffort ?? 'off', timeoutMs: preflight.config.config.model.timeout_ms,
      systemPrompt: '你是 CorePilot 性能工程 Agent。本次仅调查并优化源码，生成一个完整的未验证候选补丁。使用现有源码工具调查，记录假设后编辑，完成后调用 submit_candidate。没有依据时调用 finish_optimization。本任务没有构建、测试、测量、批准或交付权限；不能声称正确性或性能已通过。声明的硬件信息未经本次探测。',
      onEvent: async event => {
        const message = event.type === 'turn_start' ? 'Agent 正在分析下一步'
          : event.type === 'tool_start' ? `正在调用 ${event.toolName}`
            : event.type === 'tool_end' ? `${event.toolName}${event.isError ? ' 返回错误，Agent 将读取反馈' : ' 已完成'}`
              : event.type === 'compaction_start' ? '正在整理会话上下文' : null;
        if (message) update({ ...(session ? { agent_session: await session.summary() } : {}),
          progress: { phase: records.get(workflowId)?.progress?.phase ?? 'AGENT_EDITING', last_event: message } });
      },
    });
    input.attachSession(session);
    update({ agent_session: await session.summary() });
    const saved = input.resume ? await session.readCheckpoint<SourceAgentCheckpoint>() : undefined;
    if (input.resume && !saved) throw new Error('未找到可恢复的源码检查点，请保留原记录并新建任务。');
    const verification = await verifyToolCalling(modelConfig, { models, fetch: transport.fetch, timeoutMs: preflight.config.config.model.timeout_ms, signal });
    if (!verification.ok) throw new Error(`模型工具调用能力验证失败：${verification.error ?? '未返回合法工具调用'}`);
    const budget = record.session_budget ?? resolveOptimizationBudget();
    const started = Date.now();
    const result = await runSourceAgentWorkflow({
      preflight, runtime, store: input.store, taskId, repository: prepared.repository, baselineCommit,
      worktreeRoot: localWorktreeRoot(prepared.repository, input.worktreeRoot), runId,
      agentIdentity: { provider_id: COREPILOT_PI_PROVIDER_ID, model_id: modelConfig.modelId, verification_mode: 'source_only' },
      ...(saved ? { resumeFrom: saved } : {}), signal,
      saveCheckpoint: checkpoint => session!.checkpoint(checkpoint),
      onProgress: async (phase, message, state) => {
        update({ progress: { phase, last_event: clean(message) },
          workspace_editing: state.workspace.editing, workspace_validation: state.workspace.validation,
          ...(state.hypothesis_id ? { hypothesis_id: state.hypothesis_id } : {}),
          ...(state.candidate_id ? { candidate_id: state.candidate_id } : {}),
          ...(state.checkpoint ? { candidate_commit: state.checkpoint.commit, candidate_tree: state.checkpoint.tree,
            candidate_files: state.checkpoint.files, source_archive_sha256: state.checkpoint.source_archive_sha256 } : {}),
        });
        await session!.progress({ phase, last_event: clean(message) });
      },
      runAgent: (tools, prompt, agentSignal, afterSubmission) => session!.run(input.message ? `${prompt}\n用户补充要求：${input.message}` : prompt,
        tools, agentSignal, budget.time_limit_ms - (Date.now() - started), afterSubmission),
    });
    const { state, status } = result;
    const message = result.error ?? (status === 'CANDIDATE_READY' ? '候选补丁已准备，可查看差异或创建独立测试任务。尚未验证正确性与性能。'
      : status === 'BUDGET_EXHAUSTED' ? '本次预算已用完，源码和会话已保存，可继续优化。'
        : status === 'NO_CANDIDATE' ? '本次调查未提交新候选，调查记录已保存。' : status === 'CANCELLED' ? '源码优化已取消，工作区已保留。' : '源码与会话已保存。');
    finishWorkflowExecution(input.store, workflowId, taskId, { status, error: result.error ? clean(result.error) : null, progress: { phase: status, last_event: clean(message) },
      workspace_editing: state.workspace.editing, workspace_validation: state.workspace.validation,
      ...(state.agent?.text ? { stop_reason: clean(state.agent.text.slice(0, 8192)) } : {}),
    }, clean);
  } catch (error) {
    const status = signal.aborted ? signal.reason === 'backend shutting down' ? 'INTERRUPTED' : 'CANCELLED' : 'FAILED';
    const message = clean((error as Error).message);
    finishWorkflowExecution(input.store, workflowId, taskId, { status, error: message, progress: { phase: status, last_event: message } }, clean);
  } finally {
    if (session) {
      try { update({ agent_session: await session.summary() }); await session.close(); }
      catch (error) { update({ report_error: clean(`会话关闭失败：${(error as Error).message}`) }); }
    }
    input.attachSession(null);
    try {
      const current = records.get(workflowId)!;
      const report = buildOptimizationReport(current, input.store);
      const files = await writeOptimizationReport(outputDir, { report, markdown: renderOptimizationReport(report) });
      update({ report_files: files });
    } catch (error) { update({ report_error: clean((error as Error).message) }); }
    try { await transport?.close(); } catch { /* Preserve the source result when transport cleanup fails. */ }
  }
}
