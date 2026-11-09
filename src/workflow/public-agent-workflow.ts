import path from 'node:path';
import { Type } from 'typebox';
import { assertCandidateSourceScope } from '../library-package/candidate-scope.js';
import type { AgentTool, PiAgentRuntimeResult } from '../agent/pi-agent-runtime.js';
import { WorkspaceToolset, type WorkspaceToolOptions } from '../agent/workspace-tools.js';
import { checkpointCandidate, createCandidateWorkspace, restoreCandidateWorkspace, type CandidateCheckpoint, type CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import {
  evaluatePerformanceGate,
  parsePerformanceMeasurements,
  runRevalidationCycle,
  runValidationCommand,
  runValidationCycle,
  stageRemoteCandidate,
  type PerformanceCaseMeasurement,
  type PerformanceGateResult,
  type RemoteValidationSession,
  type RemoteValidationTransport,
  type RevalidationCycleResult,
  type ValidationCycleResult,
} from '../workspace/validation-runner.js';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import type { PublicOptimizationPreflight } from './public-optimization.js';
import { RemoteExperimentUnknownError, type RpcExperimentTransitionAdapter } from '../core/rpc-experiment-transition-adapter.js';
import type { DevelopmentFindings, DevelopmentGateResult } from '../contracts/development-investigation.js';
import type { CandidateEvaluationDecision, CandidateEvaluationFeedback } from '../contracts/candidate-evaluation-feedback.js';
import { candidateEvaluationFeedback } from '../workspace/candidate-evaluation-feedback.js';
import { candidateDecisionTool, hypothesisDecisionTool } from '../agent/candidate-feedback-tool.js';
import { hypothesisProposalTool } from '../agent/hypothesis-tool.js';
import { isValidationBlocked } from '../workspace/validation-outcome.js';
import type { HypothesisProposal, OptimizationHypothesis, OptimizationReasoningHistory } from '../contracts/optimization-hypothesis.js';

export type PublicAgentWorkflowStatus = 'WAITING_APPROVAL' | 'PERFORMANCE_THRESHOLD_NOT_MET' | 'NO_CANDIDATE' | 'BUDGET_EXHAUSTED' | 'INTERRUPTED' | 'VALIDATION_BLOCKED' | 'FAILED' | 'CANCELLED';

export interface PublicAgentWorkflowCheckpoint {
  version: 1;
  /** Retry frozen source without calling the model or reopening source editing. */
  validationOnly?: boolean;
  round: number;
  phase: 'AGENT' | 'CHECKPOINT' | 'DEVELOPMENT' | 'VALIDATION' | 'REVALIDATION';
  workspace: CandidateWorkspaceState;
  checkpoint: CandidateCheckpoint | null;
  candidateId: string | null;
  activeExperimentId: string | null;
  activeHypothesisId: string | null;
  evaluatedHypothesisId: string | null;
  evaluationFeedback: CandidateEvaluationFeedback | null;
  pendingDecision: CandidateEvaluationDecision | null;
  pendingParentHypothesisId: string | null;
  developmentFindings: DevelopmentFindings | null;
  developmentGate: DevelopmentGateResult | null;
  agent: PiAgentRuntimeResult | null;
  validation: ValidationCycleResult | null;
  performance: PerformanceGateResult | null;
  revalidation: RevalidationCycleResult | null;
  prompt: string;
}

export interface PublicAgentWorkflowResult {
  status: PublicAgentWorkflowStatus;
  rounds: number;
  workspace: CandidateWorkspaceState;
  checkpoint: CandidateCheckpoint | null;
  validation: ValidationCycleResult | null;
  performance: PerformanceGateResult | null;
  revalidation: RevalidationCycleResult | null;
  agent: PiAgentRuntimeResult | null;
  development_gate?: DevelopmentGateResult | null;
  error: string | null;
}

export interface PublicAgentProgress {
  phase: string;
  hypothesis_id?: string;
  round?: number;
  workspace?: Partial<CandidateWorkspaceState>;
  checkpoint?: CandidateCheckpoint | null;
  validation?: ValidationCycleResult | null;
  performance?: PerformanceGateResult | null;
  revalidation?: RevalidationCycleResult | null;
  development_gate?: DevelopmentGateResult | null;
  development_findings?: DevelopmentFindings | null;
  candidate_evaluation_feedback?: CandidateEvaluationFeedback;
  candidate_evaluation_decision?: CandidateEvaluationDecision;
  last_event?: string;
}

/** Durable lifecycle callbacks supplied by the existing Optimization Runtime. */
export interface PublicAgentLifecycleRecorder {
  candidateCheckpointed(input: {
    round: number;
    workspace: CandidateWorkspaceState;
    checkpoint: CandidateCheckpoint;
    agent: PiAgentRuntimeResult;
  }): string | Promise<string>;
  experimentStarted(input: { round: number; candidateId: string }): string | Promise<string>;
  experimentCompleted(input: {
    round: number;
    candidateId: string;
    experimentId: string;
    validation: ValidationCycleResult;
    performance: PerformanceGateResult | null;
  }): void | Promise<void>;
  revalidationStarted(input: { round: number; candidateId: string }): string | Promise<string>;
  revalidationCompleted(input: {
    round: number;
    candidateId: string;
    experimentId: string;
    revalidation: RevalidationCycleResult;
  }): void | Promise<void>;
  experimentFailed(input: {
    experimentId: string;
    error: string;
    cancelled: boolean;
    remoteStateUnknown: boolean;
  }): void | Promise<void>;
}

export interface PublicDevelopmentInvestigation {
  toolOptions: WorkspaceToolOptions;
  runGate?: (workloadIds: readonly string[], signal?: AbortSignal) => Promise<DevelopmentGateResult>;
}

export interface PublicOptimizationReasoning {
  history: () => OptimizationReasoningHistory | Promise<OptimizationReasoningHistory>;
  propose: (proposal: HypothesisProposal, parentHypothesisId: string | null) => OptimizationHypothesis | Promise<OptimizationHypothesis>;
  abandon: (hypothesisId: string, reason: string) => void | Promise<void>;
}

function buildCommand(preflight: PublicOptimizationPreflight, repository: string): ValidationCommand {
  const build = preflight.config.config.build;
  return {
    executable: build.executable,
    args: build.args,
    // build.cwd 的契约是相对候选源码根目录，而不是相对 YAML 所在目录。
    cwd: path.resolve(repository, build.cwd),
    environment: { ...build.environment },
    timeout_ms: build.timeout_ms,
  };
}

function toolText(value: unknown, isError = false) {
  return { isError, text: JSON.stringify(value) };
}

function investigationWorkloads(findings: DevelopmentFindings, declared: readonly string[]): string[] {
  const allowed = new Set(declared);
  return [...new Set(findings.supporting_measurements
    .filter((item) => item.tool === 'run_dev_benchmark' || item.tool === 'profile_perf_stat')
    .map((item) => item.subject_id)
    .filter((item) => allowed.has(item)))];
}

/** Build the first-turn brief entirely from the selected software domain. */
export function buildDomainAgentPrompt(preflight: PublicOptimizationPreflight): string {
  const testpack = preflight.testpack.testpack;
  const evaluator = testpack.evaluator;
  const target = {
    function: preflight.request.function_name,
    family: testpack.function_family,
    operation: testpack.operation,
    data_type: testpack.data_type,
    entry_file: preflight.request.entry_file,
    ...(preflight.libraryPackage ? { candidate_scope: preflight.libraryPackage.target.candidate_scope } : {}),
  };
  const validation = {
    evaluator: evaluator
      ? { id: evaluator.id, version: evaluator.version, digest: evaluator.sha256 }
      : { id: testpack.testpack_id, trust: 'LEGACY_DEVELOPMENT_ONLY' },
    correctness_cases: testpack.correctness.cases.map((item) => item.case_id),
    performance_workloads: testpack.performance.cases.map((item) => item.case_id),
    key_workloads: testpack.performance.key_cases,
    development_workloads: preflight.libraryPackage?.target.development_benchmark.workload_ids ?? testpack.performance.cases.map((item) => item.case_id),
    acceptance_policy: testpack.performance.thresholds,
    resources: testpack.resources,
  };
  return [
    `Investigate and optimize the configured software target ${preflight.request.function_name}.`,
    `Domain configuration:\n${JSON.stringify(target, null, 2)}`,
    `Build configuration:\n${JSON.stringify({ executable: preflight.config.config.build.executable, args: preflight.config.config.build.args, cwd: preflight.config.config.build.cwd }, null, 2)}`,
    `Validation configuration:\n${JSON.stringify(validation, null, 2)}`,
    'Analyze the configured entry point, relevant source and call path, runtime implementation, and built binary before proposing a change. Do not assume the implementation is assembly, threaded, or BLAS-specific unless source and measurements establish that.',
    'Use DEVELOPMENT_ONLY target tools on relevant workloads when available. Record concise structured findings with record_development_findings. Modify source only when those findings support one focused transformation; otherwise stop without manufacturing a Candidate. Never modify the Formal Evaluator.',
  ].join('\n\n');
}

export function buildCandidateFeedbackPrompt(preflight: PublicOptimizationPreflight, feedback: CandidateEvaluationFeedback, decision: CandidateEvaluationDecision | null = null): string {
  return [
    buildDomainAgentPrompt(preflight),
    'Candidate Evaluation Feedback:\n' + JSON.stringify(feedback, null, 2),
    'Inspect the failed correctness cases, their domain parameters, command output, observed/reference summaries, failure reason and resource validity before any next change. Raw command diagnostics are not accepted Formal Evidence; development speedups cannot excuse a correctness failure.',
    'Call record_candidate_decision with the exact candidate_id and experiment_id: REPAIR the Candidate, ABANDON it and stop without approval, or propose a NEW_HYPOTHESIS grounded in the failure evidence. NEW_HYPOTHESIS requires a hypothesis and may finish this round without mutation; another investigation round uses the existing budget.',
    'Record development findings before a source mutation when required. Never change the oracle, correctness cases, evaluator, baseline, resource policy or acceptance policy to make a Candidate pass. Missing evaluator/resource metadata requires contract investigation, not relaxed correctness.',
    ...(decision ? ['Previous Agent decision:\n' + JSON.stringify(decision, null, 2)] : []),
  ].join('\n\n');
}

/** public Agent 主循环：编辑树写入，checkpoint 后在干净验证树构建、正确性、性能和复验。 */
export async function runPublicAgentWorkflow(input: {
  preflight: PublicOptimizationPreflight;
  repository: string;
  worktreeRoot: string;
  runId: string;
  /** Optional frozen source checkpoint to continue an existing single lineage. */
  baselineCommit?: string;
  sourceBranch?: string;
  runAgent: (tools: readonly AgentTool[], prompt: string, signal: AbortSignal) => Promise<PiAgentRuntimeResult>;
  maxRounds?: number;
  initialFeedback?: Record<string, unknown>;
  enablePerformance?: boolean;
  readPerformanceMeasurements?: (validation: ValidationCycleResult) => Promise<readonly PerformanceCaseMeasurement[]>;
  remote?: { transport: RemoteValidationTransport; workspace_root: string };
  /** Present only when configuration explicitly selects the RPC backend. */
  experimentExecution?: RpcExperimentTransitionAdapter;
  /** Runner-backed DEVELOPMENT_ONLY tools, isolated from Formal Evidence. */
  createDevelopmentInvestigation?: (workspace: CandidateWorkspaceState) => PublicDevelopmentInvestigation;
  reasoning?: PublicOptimizationReasoning;
  lifecycle?: PublicAgentLifecycleRecorder;
  onProgress?: (progress: PublicAgentProgress) => void | Promise<void>;
  signal?: AbortSignal;
  resumeFrom?: PublicAgentWorkflowCheckpoint;
  saveCheckpoint?: (checkpoint: PublicAgentWorkflowCheckpoint) => void | Promise<void>;
}): Promise<PublicAgentWorkflowResult> {
  const saved = input.resumeFrom;
  const workspace = saved ? restoreCandidateWorkspace(saved.workspace) : createCandidateWorkspace({
    repository: input.repository,
    worktreeRoot: input.worktreeRoot,
    runId: input.runId,
    ...(input.baselineCommit ? { baselineCommit: input.baselineCommit } : {}),
    ...(input.sourceBranch ? { sourceBranch: input.sourceBranch } : {}),
  });
  const build = buildCommand(input.preflight, workspace.repository);
  const formalRpc = input.preflight.runner?.mode === 'rpc';
  const development = input.createDevelopmentInvestigation?.(workspace);
  let evaluationFeedback = saved?.evaluationFeedback ?? null;
  let activeHypothesisId = saved?.activeHypothesisId ?? null;
  let evaluatedHypothesisId = saved?.evaluatedHypothesisId ?? null;
  let pendingDecision = saved?.pendingDecision ?? null;
  let pendingParentHypothesisId = saved?.pendingParentHypothesisId ?? null;
  const decisions: CandidateEvaluationDecision[] = [];
  const toolset = new WorkspaceToolset(workspace.editing, {
    baselineCommit: workspace.baseline_commit,
    candidateSubmission: true,
    buildContext: () => ({ command: build, repository: workspace.repository }),
    targetProfile: () => ({ ...input.preflight.config.config.target }),
    performanceEvidence: () => ({
      testpack_id: input.preflight.testpack.testpack.testpack_id,
      resources: input.preflight.testpack.testpack.resources,
      baselines: input.preflight.testpack.testpack.performance.baselines,
      thresholds: input.preflight.testpack.testpack.performance.thresholds,
      cases: input.preflight.testpack.testpack.performance.cases,
      key_cases: input.preflight.testpack.testpack.performance.key_cases,
    }),
    ...(formalRpc ? {} : {
      runBuild: async (signal: AbortSignal) => toolText(await runValidationCommand(build, workspace.editing, { sourceRoot: workspace.repository, testpackDir: input.preflight.testpack.testpackDir, signal })),
      runCorrectness: async (signal: AbortSignal) => {
        const result = await runValidationCommand(input.preflight.testpack.testpack.correctness.command, workspace.editing, { sourceRoot: workspace.repository, testpackDir: input.preflight.testpack.testpackDir, signal });
        return toolText(result, !result.ok);
      },
      runPerformance: async (signal: AbortSignal) => {
        const result = await runValidationCommand(input.preflight.testpack.testpack.performance.command, workspace.editing, { sourceRoot: workspace.repository, testpackDir: input.preflight.testpack.testpackDir, signal });
        return toolText(result, !result.ok);
      },
    }),
    ...(development?.toolOptions ?? {}),
    ...(input.preflight.libraryPackage ? { candidateSourceScope: input.preflight.libraryPackage.target.candidate_scope } : {}),
    beforeSourceMutation: () => {
      const decision = decisions.at(-1) ?? (input.reasoning ? pendingDecision : null);
      if (evaluationFeedback && (!decision || decision.action === 'ABANDON')) throw new Error('record_candidate_decision must select REPAIR or NEW_HYPOTHESIS before modifying a failed Candidate');
      if (input.reasoning && (!activeHypothesisId || decision?.action === 'NEW_HYPOTHESIS' && activeHypothesisId === pendingParentHypothesisId)) throw new Error('record_hypothesis must persist the producing Hypothesis before modifying source');
    },
  });
  const tools = toolset.asAgentTools();
  const maxCandidates = input.maxRounds ?? 8;
  let checkpoint = saved?.checkpoint ?? null;
  let candidateId = saved?.candidateId ?? null;
  let validation = saved?.validation ?? null;
  let performance = saved?.performance ?? null;
  let revalidation = saved?.revalidation ?? null;
  let remote: RemoteValidationSession | undefined;
  let agent = saved?.agent ?? null;
  let developmentGate = saved?.developmentGate ?? null;
  let activeExperimentId = saved?.activeExperimentId ?? null;
  let prompt = saved?.prompt ?? buildDomainAgentPrompt(input.preflight);
  let phase = saved?.phase ?? 'AGENT';
  let currentRound = saved?.round ?? 1;
  const capture = async (nextPhase = phase, nextRound = currentRound) => {
    phase = nextPhase;
    currentRound = nextRound;
    await input.saveCheckpoint?.({ version: 1, phase, round: currentRound, workspace, checkpoint, candidateId,
      ...(saved?.validationOnly ? { validationOnly: true } : {}),
      activeExperimentId, activeHypothesisId, evaluatedHypothesisId, evaluationFeedback, pendingDecision,
      pendingParentHypothesisId, developmentFindings: toolset.developmentFindings(), developmentGate,
      agent: agent ? { ...agent, messages: [] } : null, validation, performance, revalidation, prompt });
  };
  if (saved?.developmentFindings) toolset.restoreDevelopmentFindings(saved.developmentFindings);
  let evaluatedThisContinuation = saved && !['AGENT', 'CHECKPOINT'].includes(saved.phase) ? 1 : 0;
  const stopValidation = async (failedValidation: ValidationCycleResult, feedback: CandidateEvaluationFeedback): Promise<PublicAgentWorkflowResult | null> => {
    const blocked = isValidationBlocked(failedValidation.runner_status);
    if (!blocked && !saved?.validationOnly) return null;
    const error = blocked
      ? `验证环境异常：${feedback.failure?.code ?? feedback.failure_category ?? 'INVALID_EXPERIMENT'}。${feedback.failure?.message ?? '本次实验无法形成有效结论'}。候选已保留；修复环境后可重新验证当前候选。`
      : feedback.performance_summary.reason ?? '当前候选未通过验证，请查看用例与命令诊断。';
    await capture();
    const status = blocked ? 'VALIDATION_BLOCKED' : feedback.performance_summary.status === 'FAILED' && feedback.correctness_status === 'PASSED' ? 'PERFORMANCE_THRESHOLD_NOT_MET' : 'FAILED';
    await input.onProgress?.({ phase: status, round: currentRound, candidate_evaluation_feedback: feedback, last_event: error });
    return { status, rounds: currentRound, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error };
  };

  try {
    await input.onProgress?.({ phase: 'EDITING_WORKSPACE_READY', workspace, last_event: 'editing and validation worktrees created from baseline' });
    if (input.initialFeedback) {
      prompt += `\nBefore changing code, analyze this structured measurement from the same Formal Evaluator, machine, and current source baseline. Inspect the configured source, relevant call path/runtime implementation, target binary, and focused target measurements. Record development findings, then create at most one focused Candidate only if the evidence supports it. Do not modify the Formal Evaluator.\n${JSON.stringify(input.initialFeedback, null, 2)}`;
    }
    if (!saved && input.preflight.request.entry_file) {
      const entry = await toolset.execute('read_file', { path: input.preflight.request.entry_file }, input.signal ?? new AbortController().signal);
      if (entry.isError) return { status: 'FAILED', rounds: 0, workspace, checkpoint, validation, performance, revalidation, agent, error: `cannot read entry file ${input.preflight.request.entry_file}: ${entry.text}` };
      const limit = 64 * 1024;
      const preview = entry.text.length > limit ? `${entry.text.slice(0, limit)}\n[entry file preview truncated; use read_file for the complete file]` : entry.text;
      prompt += `\n入口文件 ${input.preflight.request.entry_file} 已在第一次模型调用前优先读取；它只是调查入口，不是读取或修改白名单。内容如下：\n${preview}`;
    }
    for (let round = currentRound; evaluatedThisContinuation < maxCandidates || phase !== 'AGENT'; round += 1) {
      currentRound = round;
      input.signal?.throwIfAborted();
      if (phase === 'AGENT') {
        if (evaluationFeedback && validation) {
          const stopped = await stopValidation(validation, evaluationFeedback);
          if (stopped) return stopped;
        }
        if (saved?.validationOnly) throw new Error('validation-only recovery cannot enter source editing');
        if (!(saved?.phase === 'AGENT' && saved.round === round)) toolset.beginInvestigationRound();
        decisions.length = 0;
        let proposedThisRound = false;
        developmentGate = null;
        await input.onProgress?.({ phase: 'AGENT_EDITING', round, workspace, last_event: 'agent is investigating and editing the complete repository' });
        const recordDecision = (decision: CandidateEvaluationDecision) => {
          if (decisions.length > 0) throw new Error('candidate decision was already recorded for this round');
          decisions.push(decision);
          pendingDecision = decision;
          pendingParentHypothesisId = decision.action === 'NEW_HYPOTHESIS' ? activeHypothesisId : null;
        };
        const roundTools = evaluationFeedback ? [...tools, candidateDecisionTool(evaluationFeedback, recordDecision)] : [...tools];
        if (!evaluationFeedback && input.reasoning && activeHypothesisId) roundTools.push(hypothesisDecisionTool(activeHypothesisId, recordDecision));
        let roundPrompt = prompt;
        if (input.reasoning) {
          roundTools.push({ name: 'read_optimization_history', label: 'Read optimization history',
            description: 'Retrieve earlier hypotheses, candidate lineage, experiments and outcomes without putting the complete history into every prompt.',
            parameters: Type.Object({ hypothesis_id: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
            execute: async (_id, args) => {
              const query = args as { hypothesis_id?: string; limit?: number };
              const history = await input.reasoning!.history();
              const hypotheses = query.hypothesis_id ? history.hypotheses.filter(item => item.hypothesis.hypothesis_id === query.hypothesis_id) : history.hypotheses.slice(-(query.limit ?? 6));
              return { content: [{ type: 'text', text: JSON.stringify({ ...history, hypotheses }) }], details: {} };
            } });
          roundTools.push(hypothesisProposalTool(activeHypothesisId, async proposal => {
            if (proposedThisRound) throw new Error('one Hypothesis proposal is allowed per investigation round');
            if (activeHypothesisId && (decisions.at(-1) ?? pendingDecision)?.action !== 'NEW_HYPOTHESIS') throw new Error('REPAIR reuses its Hypothesis; choose NEW_HYPOTHESIS before replacing it');
            const hypothesis = await input.reasoning!.propose(proposal, activeHypothesisId);
            activeHypothesisId = hypothesis.hypothesis_id;
            proposedThisRound = true;
            await input.onProgress?.({ phase: 'HYPOTHESIS_PROPOSED', round, hypothesis_id: hypothesis.hypothesis_id, last_event: hypothesis.description });
            return hypothesis;
          }));
          const history = await input.reasoning.history();
          roundPrompt += `\nRecent Optimization Reasoning History:\n${JSON.stringify({ ...history, hypotheses: history.hypotheses.slice(-6) })}\nActive hypothesis_id: ${activeHypothesisId ?? 'NONE'}. Persist a structured Hypothesis before the first source mutation. REPAIR keeps its Hypothesis; NEW_HYPOTHESIS records a child. Experimental support is not Human Approval.\n${pendingDecision ? JSON.stringify({ pending_decision: pendingDecision }) : ''}`;
        }
        await capture('AGENT');
        agent = await input.runAgent(roundTools.map(tool => ({ ...tool, execute: async (...args) => {
          try { return await tool.execute(...args); }
          finally { await capture(); }
        } })), roundPrompt, input.signal ?? new AbortController().signal);
        if (activeHypothesisId) agent.hypothesis_id = activeHypothesisId;
        const decision = decisions.at(-1) ?? pendingDecision;
        if (decision) {
          agent.candidate_evaluation_decision = decision;
          await input.onProgress?.({ phase: 'CANDIDATE_DECISION_RECORDED', round, candidate_evaluation_decision: decision, last_event: `Agent selected ${decision.action} for the evaluated Candidate` });
          if (!input.signal?.aborted && agent.no_source_mutation && decision.action === 'ABANDON') {
            const abandonedHypothesisId = evaluationFeedback ? evaluatedHypothesisId : activeHypothesisId;
            if (input.reasoning && abandonedHypothesisId) await input.reasoning.abandon(abandonedHypothesisId, decision.reason);
            await input.onProgress?.({ phase: 'CANDIDATE_ABANDONED', round, last_event: decision.reason });
            return { status: checkpoint ? 'PERFORMANCE_THRESHOLD_NOT_MET' : 'NO_CANDIDATE', rounds: round - 1, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: null };
          }
          if (!input.signal?.aborted && agent.no_source_mutation && decision.action === 'NEW_HYPOTHESIS' && (evaluationFeedback || input.reasoning)) {
            if (evaluationFeedback) prompt = buildCandidateFeedbackPrompt(input.preflight, evaluationFeedback, decision);
            await capture('AGENT', round + 1);
            continue;
          }
        }
        agent.development_findings = toolset.developmentFindings();
        if (agent.development_findings) {
          await input.onProgress?.({
            phase: 'DEVELOPMENT_FINDINGS_RECORDED',
            round,
            workspace,
            development_findings: agent.development_findings,
            last_event: agent.development_findings.chosen_transformation
              ? 'development diagnosis supports one focused transformation'
              : 'development diagnosis does not justify a source mutation',
          });
        }
        if (!agent.ok) {
          if (agent.interrupted) { await capture('AGENT'); return { status: 'INTERRUPTED', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: agent.error }; }
          if (agent.budget_exhausted) { await capture('AGENT'); return { status: 'BUDGET_EXHAUSTED', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: null }; }
          if (!input.signal?.aborted && agent.no_source_mutation) {
            await input.onProgress?.({ phase: 'PERFORMANCE_THRESHOLD_NOT_MET', round: round - 1, workspace, checkpoint, validation, performance, revalidation, last_event: 'agent stopped without proposing another source mutation' });
          return { status: checkpoint ? 'PERFORMANCE_THRESHOLD_NOT_MET' : 'NO_CANDIDATE', rounds: round - 1, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: null };
          }
          return { status: input.signal?.aborted ? input.signal.reason === 'backend shutting down' ? 'INTERRUPTED' : 'CANCELLED' : 'FAILED', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, error: agent.error };
        }
        validation = null;
        performance = null;
        revalidation = null;
        evaluationFeedback = null;
        pendingDecision = null;
        pendingParentHypothesisId = null;
        await capture('CHECKPOINT');
      }
      if (!agent) throw new Error('saved candidate evaluation is missing its Agent result');

      if (phase === 'CHECKPOINT') {
        checkpoint = checkpointCandidate(workspace, `corepilot candidate checkpoint round ${round}`);
        if (input.preflight.libraryPackage) assertCandidateSourceScope(input.preflight.libraryPackage.target.candidate_scope, checkpoint.files.map((item) => item.path));
        candidateId = input.lifecycle
          ? await input.lifecycle.candidateCheckpointed({ round, workspace, checkpoint, agent })
          : null;
        evaluatedThisContinuation += 1;
        await capture('DEVELOPMENT');
      }
      if (phase === 'DEVELOPMENT') {
        const findings = agent.development_findings;
        if (development?.runGate && findings?.chosen_transformation) {
          const workloadIds = investigationWorkloads(findings, input.preflight.libraryPackage?.target.development_benchmark.workload_ids ?? input.preflight.testpack.testpack.performance.cases.map((item) => item.case_id));
          if (workloadIds.length > 0) {
            developmentGate = await development.runGate(workloadIds, input.signal);
            await input.onProgress?.({
              phase: developmentGate.failure ? 'DEVELOPMENT_BUILD_FAILED' : developmentGate.passed ? 'DEVELOPMENT_GATE_PASSED' : 'DEVELOPMENT_GATE_REJECTED',
              round,
              workspace,
              checkpoint,
              development_gate: developmentGate,
              last_event: developmentGate.reason,
            });
            if (!developmentGate.passed) {
              prompt = `The previous complete Candidate did not pass DEVELOPMENT_ONLY validation and did not enter Formal Evaluation. A build failure is not a performance regression. Inspect the exact command failure and changed paths, then repair the Candidate or abandon the hypothesis. revert_file restores the original source baseline, including files deleted by the failed Candidate. Finish all edits and call submit_candidate only when the replacement is complete.\n${JSON.stringify({ candidate_id: candidateId, checkpoint, findings, development_gate: developmentGate }, null, 2)}`;
              await capture('AGENT', round + 1);
              continue;
            }
          }
        }
        await capture('VALIDATION');
      }
      if (phase === 'VALIDATION') {
        activeExperimentId ??= candidateId && input.lifecycle
          ? await input.lifecycle.experimentStarted({ round, candidateId })
          : null;
        await capture('VALIDATION');
        const experimentId = activeExperimentId;
        if (!input.experimentExecution && input.remote) {
          remote = await stageRemoteCandidate({
            workspace,
            transport: input.remote.transport,
            remoteWorkspace: path.posix.join(input.remote.workspace_root.replace(/\\/g, '/'), input.runId, 'validation'),
            signal: input.signal,
          });
        }
        await input.onProgress?.({ phase: 'CHECKPOINT_READY', round, workspace, checkpoint, last_event: 'candidate source checkpoint created' });
        validation = input.experimentExecution && activeExperimentId
          ? await input.experimentExecution.executeValidation({
              experimentId: activeExperimentId,
              workspace,
              testpack: input.preflight.testpack.testpack,
              build,
              sourceRoot: workspace.repository,
              includePerformance: input.enablePerformance === true,
              signal: input.signal,
              resume: saved?.phase === 'VALIDATION' && saved.activeExperimentId === activeExperimentId,
            })
          : await runValidationCycle({
              workspace: workspace.validation,
              testpack: input.preflight.testpack.testpack,
              build,
              sourceRoot: workspace.repository,
              testpackDir: input.preflight.testpack.testpackDir,
              includePerformance: input.enablePerformance === true,
              remote,
              signal: input.signal,
            });
        const completeExperiment = async (performanceResult: PerformanceGateResult | null) => {
          if (!input.lifecycle || !candidateId || !activeExperimentId) return;
          await input.lifecycle.experimentCompleted({
            round,
            candidateId,
            experimentId: activeExperimentId,
            validation: validation as ValidationCycleResult,
            performance: performanceResult,
          });
          activeExperimentId = null;
        };
        const feedback = (performanceResult: PerformanceGateResult | null = null) => candidateEvaluationFeedback({ validation: validation as ValidationCycleResult, candidateId, experimentId, performance: performanceResult, developmentGate });
        evaluatedHypothesisId = activeHypothesisId;
        evaluationFeedback = feedback();
        const correctnessPassed = validation.correctness?.ok === true && (!validation.runner_status || validation.runner_status.status === 'SUCCEEDED');
        await input.onProgress?.({ phase: validation.build.ok && correctnessPassed ? 'CORRECTNESS_PASSED' : 'VALIDATION_FAILED', round, workspace, checkpoint, validation, candidate_evaluation_feedback: evaluationFeedback, last_event: validation.build.ok && correctnessPassed ? 'build and correctness passed' : 'build or correctness failed' });

        if (!validation.build.ok || !correctnessPassed) {
          await completeExperiment(null);
          const stopped = await stopValidation(validation, evaluationFeedback);
          if (stopped) return stopped;
          prompt = buildCandidateFeedbackPrompt(input.preflight, evaluationFeedback);
          await capture('AGENT', round + 1);
          continue;
        }

        if (input.enablePerformance === true) {
          if (!validation.performance?.ok) {
            await completeExperiment(null);
            const stopped = await stopValidation(validation, evaluationFeedback);
            if (stopped) return stopped;
            prompt = buildCandidateFeedbackPrompt(input.preflight, evaluationFeedback);
            await capture('AGENT', round + 1);
            continue;
          }
          const measurements = await input.readPerformanceMeasurements?.(validation) ?? parsePerformanceMeasurements(validation.performance?.stdout ?? '');
          performance = evaluatePerformanceGate(input.preflight.testpack.testpack, measurements);
          evaluationFeedback = feedback(performance);
          await completeExperiment(performance);
          await input.onProgress?.({ phase: performance.passed ? 'PERFORMANCE_PASSED' : 'PERFORMANCE_THRESHOLD_NOT_MET', round, workspace, checkpoint, validation, performance, candidate_evaluation_feedback: evaluationFeedback, last_event: performance.reason });
          if (!performance.passed) {
            if (performance.statistics?.verdict === 'INCONCLUSIVE' || performance.statistics?.verdict === 'INVALID') {
              await capture('VALIDATION');
              await input.onProgress?.({ phase: 'MEASUREMENT_INCONCLUSIVE', round, candidate_evaluation_feedback: evaluationFeedback, last_event: performance.reason });
              return { status: 'VALIDATION_BLOCKED', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: performance.reason };
            }
            const stopped = await stopValidation(validation, evaluationFeedback);
            if (stopped) return stopped;
            prompt = buildCandidateFeedbackPrompt(input.preflight, evaluationFeedback);
            await capture('AGENT', round + 1);
            continue;
          }
        }

        await completeExperiment(null);
        await capture('REVALIDATION');
      }

      activeExperimentId ??= candidateId && input.lifecycle
        ? await input.lifecycle.revalidationStarted({ round, candidateId })
        : null;
      await capture('REVALIDATION');
      const revalidationExperimentId = activeExperimentId;
      revalidation = input.experimentExecution && activeExperimentId
        ? await input.experimentExecution.executeRevalidation({
            experimentId: activeExperimentId,
            workspace,
            testpack: input.preflight.testpack.testpack,
            build,
            sourceRoot: workspace.repository,
            signal: input.signal,
            resume: saved?.phase === 'REVALIDATION' && saved.activeExperimentId === activeExperimentId,
          })
        : await runRevalidationCycle({ workspace, testpack: input.preflight.testpack.testpack, build, sourceRoot: workspace.repository, testpackDir: input.preflight.testpack.testpackDir, remote, signal: input.signal });
      if (input.experimentExecution && revalidation.formal?.performance?.ok) {
        const revalidationMeasurements = parsePerformanceMeasurements(revalidation.formal.performance.stdout);
        const revalidationGate = evaluatePerformanceGate(input.preflight.testpack.testpack, revalidationMeasurements);
        revalidation = {
          ...revalidation,
          performance_gate: revalidationGate,
          passed: revalidation.passed && revalidationGate.passed,
        };
      }
      if (input.lifecycle && candidateId && activeExperimentId) {
        await input.lifecycle.revalidationCompleted({ round, candidateId, experimentId: activeExperimentId, revalidation });
        activeExperimentId = null;
      }
      await input.onProgress?.({ phase: revalidation.passed ? 'REVALIDATION_PASSED' : 'REVALIDATION_FAILED', round, workspace, checkpoint, validation, performance, revalidation, last_event: revalidation.passed ? 'formal and independent revalidation passed' : 'revalidation failed' });
      if (revalidation.passed) return { status: 'WAITING_APPROVAL', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: null };
      if (!validation) throw new Error('saved revalidation is missing its original validation result');
      const failedRevalidation = revalidation.formal && (!revalidation.formal.passed || revalidation.performance_gate?.passed === false) ? revalidation.formal : revalidation.independent;
      evaluationFeedback = candidateEvaluationFeedback({ validation: failedRevalidation ?? validation, candidateId, experimentId: revalidationExperimentId, performance: revalidation.performance_gate });
      if (revalidation.performance_gate?.statistics?.verdict === 'INCONCLUSIVE' || revalidation.performance_gate?.statistics?.verdict === 'INVALID') {
        await capture('REVALIDATION');
        await input.onProgress?.({ phase: 'MEASUREMENT_INCONCLUSIVE', round, candidate_evaluation_feedback: evaluationFeedback, last_event: revalidation.performance_gate.reason });
        return { status: 'VALIDATION_BLOCKED', rounds: round, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: revalidation.performance_gate.reason };
      }
      await input.onProgress?.({ phase: 'CANDIDATE_FEEDBACK_READY', round, candidate_evaluation_feedback: evaluationFeedback, last_event: 'revalidation failure evidence is ready for Agent review' });
      const stopped = await stopValidation(failedRevalidation ?? validation, evaluationFeedback);
      if (stopped) return stopped;
      prompt = buildCandidateFeedbackPrompt(input.preflight, evaluationFeedback);
      await capture('AGENT', round + 1);
    }
    return {
      status: 'BUDGET_EXHAUSTED',
      rounds: Math.max(0, currentRound - 1),
      workspace,
      checkpoint,
      validation,
      performance,
      revalidation,
      agent,
      development_gate: developmentGate,
      error: null,
    };
  } catch (error) {
    if (activeExperimentId && input.lifecycle) {
      try {
        await input.lifecycle.experimentFailed({
          experimentId: activeExperimentId,
          error: (error as Error).message,
          cancelled: input.signal?.aborted === true,
          remoteStateUnknown: error instanceof RemoteExperimentUnknownError,
        });
      } catch {
        // Preserve the original workflow error; the RUNNING record remains
        // visible for recovery if persisting the terminal fact also failed.
      }
      activeExperimentId = null;
    }
    return { status: error instanceof RemoteExperimentUnknownError || input.signal?.reason === 'backend shutting down' ? 'INTERRUPTED' : input.signal?.aborted ? 'CANCELLED' : 'FAILED', rounds: currentRound, workspace, checkpoint, validation, performance, revalidation, agent, development_gate: developmentGate, error: (error as Error).message };
  }
}
