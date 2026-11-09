import type { AgentTool, PiAgentRuntimeResult } from '../agent/pi-agent-runtime.js';
import { hypothesisProposalTool, optimizationHistoryTool } from '../agent/hypothesis-tool.js';
import { WorkspaceToolset } from '../agent/workspace-tools.js';
import type { OptimizationRuntime } from '../core/optimization-runtime.js';
import type { OptimizationStore } from '../storage/optimization-store.js';
import { checkpointCandidate, createCandidateWorkspace, restoreCandidateWorkspace, type CandidateCheckpoint, type CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import type { SourceOptimizationPreflight } from './source-optimization.js';

export interface SourceAgentCheckpoint {
  version: 1;
  verification_mode: 'source_only';
  phase: 'AGENT' | 'CHECKPOINT' | 'COMPLETE';
  workspace: CandidateWorkspaceState;
  hypothesis_id: string | null;
  candidate_id: string | null;
  checkpoint: CandidateCheckpoint | null;
  agent: PiAgentRuntimeResult | null;
}

export type SourceAgentStatus = 'CANDIDATE_READY' | 'NO_CANDIDATE' | 'BUDGET_EXHAUSTED' | 'INTERRUPTED' | 'CANCELLED' | 'FAILED';

/** Pi owns the tool loop; this boundary only freezes its completed source proposal. */
export async function runSourceAgentWorkflow(input: {
  preflight: SourceOptimizationPreflight;
  runtime: OptimizationRuntime;
  store: OptimizationStore;
  taskId: string;
  agentIdentity: Record<string, unknown>;
  repository: string;
  baselineCommit: string;
  worktreeRoot: string;
  runId: string;
  resumeFrom?: SourceAgentCheckpoint;
  signal: AbortSignal;
  runAgent: (tools: readonly AgentTool[], prompt: string, signal: AbortSignal, afterSubmission: boolean) => Promise<PiAgentRuntimeResult>;
  saveCheckpoint: (checkpoint: SourceAgentCheckpoint) => Promise<void>;
  onProgress: (phase: string, message: string, state: SourceAgentCheckpoint) => Promise<void>;
}): Promise<{ status: SourceAgentStatus; state: SourceAgentCheckpoint; error: string | null }> {
  const saved = input.resumeFrom;
  if (saved && saved.verification_mode !== 'source_only') throw new Error('保存的检查点不属于源码优化模式。');
  const state: SourceAgentCheckpoint = saved ? { ...saved, workspace: restoreCandidateWorkspace(saved.workspace) } : {
    version: 1, verification_mode: 'source_only', phase: 'AGENT',
    workspace: createCandidateWorkspace({ repository: input.repository, baselineCommit: input.baselineCommit,
      worktreeRoot: input.worktreeRoot, runId: input.runId, ...(input.preflight.source ? { sourceBranch: input.preflight.source.branch } : {}) }),
    hypothesis_id: null, candidate_id: null, checkpoint: null, agent: null,
  };
  const parentHypothesisId = state.phase === 'COMPLETE' ? state.hypothesis_id : null;
  if (state.phase === 'COMPLETE') { state.phase = 'AGENT'; state.hypothesis_id = null; state.agent = null; }
  const capture = () => input.saveCheckpoint(state);
  const toolset = new WorkspaceToolset(state.workspace.editing, {
    baselineCommit: state.workspace.baseline_commit, candidateSubmission: true, candidateValidation: 'deferred',
    buildContext: () => ({ configured: input.preflight.config.config.build, execution: 'NOT_EXECUTED' }),
    targetProfile: () => ({ ...input.preflight.targetContext, current_probe: 'NOT_EXECUTED' }),
    beforeSourceMutation: () => { if (!state.hypothesis_id) throw new Error('修改源码前请先调用 record_hypothesis，记录源码调查依据。'); },
  });
  let prompt = [
    `为 ${input.preflight.request.function_name} 调查并实现一个有依据的源码优化。`,
    '本任务为 source_only：仅生成未验证的候选补丁，不执行构建、正确性或性能测试，不产生性能收益、批准或交付结论。',
    '使用源码搜索和读取工具调查实现与调用关系；修改前记录结构化假设。保持原有 API 语义；测试、基线和验收规则不属于候选修改范围。',
    '完成所有相关编辑后调用 submit_candidate。没有可信改进方向时调用 finish_optimization，不制造改动。',
    `当前假设：${state.hypothesis_id ?? '无'}；新假设父 ID：${parentHypothesisId ?? 'null'}。声明的目标配置仅是上下文，未探测或验证机器能力。`,
    `目标上下文：${JSON.stringify(input.preflight.targetContext)}。REGISTRY_CACHE 是指定 observed_at 的历史观测，不是本次硬件验证；unresolved 表示尚未解析指定机器，不能使用其他机器配置代替。`,
  ].join('\n');
  if (!saved && input.preflight.request.entry_file) {
    const entry = await toolset.execute('read_file', { path: input.preflight.request.entry_file }, input.signal);
    if (entry.isError) throw new Error(`无法读取入口文件：${entry.text}`);
    prompt += `\n优先调查入口（不是修改白名单）：\n${entry.text.slice(0, 64 * 1024)}`;
  }
  try {
    input.signal.throwIfAborted();
    await capture();
    if (state.phase === 'AGENT') {
      await input.onProgress('AGENT_EDITING', 'Agent 正在调查源码并准备优化补丁', state);
      const tools: AgentTool[] = [
        ...toolset.asAgentTools().filter(tool => tool.name !== 'read_performance_evidence'),
        optimizationHistoryTool(() => input.runtime.reasoningHistory(input.taskId)),
        hypothesisProposalTool(parentHypothesisId, async proposal => {
          if (state.hypothesis_id) throw new Error('本次候选已有假设，请完成当前实现后再开始新方向。');
          const hypothesis = input.runtime.proposeHypothesis({ taskId: input.taskId, parentHypothesisId, proposal, agentIdentity: input.agentIdentity });
          state.hypothesis_id = hypothesis.hypothesis_id;
          await input.onProgress('HYPOTHESIS_PROPOSED', hypothesis.description, state);
          return hypothesis;
        }),
      ];
      const agent = await input.runAgent(tools.map(tool => ({ ...tool, execute: async (...args) => {
        try { return await tool.execute(...args); } finally { await capture(); }
      } })), prompt, input.signal, saved?.phase === 'COMPLETE');
      // Pi stores the transcript; the workflow checkpoint needs only the run summary.
      state.agent = { ...agent, messages: [] };
      await capture();
      if (input.signal.aborted) return { status: input.signal.reason === 'backend shutting down' ? 'INTERRUPTED' : 'CANCELLED', state, error: null };
      if (state.agent.budget_exhausted) return { status: 'BUDGET_EXHAUSTED', state, error: null };
      if (state.agent.interrupted) return { status: 'INTERRUPTED', state, error: state.agent.error };
      if (!state.agent.ok) return { status: state.agent.no_source_mutation ? 'NO_CANDIDATE' : 'FAILED', state, error: state.agent.no_source_mutation ? null : state.agent.error };
      if (!state.hypothesis_id) throw new Error('候选提交缺少产生它的优化假设。');
      state.checkpoint = null;
      state.candidate_id = null;
      state.phase = 'CHECKPOINT';
      await capture();
    }
    input.signal.throwIfAborted();
    if (!state.checkpoint || state.workspace.candidate_commit !== state.checkpoint.commit || saved?.phase === 'COMPLETE') {
      state.checkpoint = checkpointCandidate(state.workspace, 'corepilot unverified source candidate');
      state.candidate_id = null;
      await capture();
    }
    const existing = input.store.listCandidates(input.taskId).find(candidate => candidate.source.commit === state.checkpoint!.commit && candidate.hypothesis_id === state.hypothesis_id);
    const candidate = existing ?? input.runtime.recordCandidate({ taskId: input.taskId, hypothesisId: state.hypothesis_id!,
      workspace: state.workspace, checkpoint: state.checkpoint, hypothesis: state.agent?.text ?? null,
      agentIdentity: { ...input.agentIdentity, turns: state.agent?.turns, tool_calls: state.agent?.tool_calls } });
    state.candidate_id = candidate.candidate_id;
    state.phase = 'COMPLETE';
    await capture();
    await input.onProgress('CANDIDATE_READY', '候选补丁已冻结；构建、正确性和性能均未测试。下一步可创建测试任务。', state);
    return { status: 'CANDIDATE_READY', state, error: null };
  } catch (error) {
    await capture();
    return { status: input.signal.aborted ? input.signal.reason === 'backend shutting down' ? 'INTERRUPTED' : 'CANCELLED' : 'FAILED', state, error: (error as Error).message };
  }
}
