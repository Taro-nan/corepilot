import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PiOptimizationSession } from '../src/agent/pi-optimization-session.js';
import { createPiModels, COREPILOT_PI_PROVIDER_ID } from '../src/model/pi-provider.js';
import { loadOptimizationConfig } from '../src/config/optimization-config.js';
import { OptimizationRuntime } from '../src/core/optimization-runtime.js';
import { createCandidateWorkspace, checkpointCandidate } from '../src/workspace/candidate-workspace.js';
import { candidateEvaluationFeedback } from '../src/workspace/candidate-evaluation-feedback.js';
import type { ValidationCycleResult, CommandRunResult } from '../src/workspace/validation-runner.js';
import type { PublicAgentWorkflowCheckpoint } from '../src/workflow/public-agent-workflow.js';
import { proposeFixtureHypothesis } from './hypothesis-fixture.js';
import { loadPublicOptimizationPreflight } from '../src/workflow/public-optimization.js';
import type { startWebFixture } from './web-fixture.js';

/** Reconstructs the historical bug: a frozen candidate, invalid zero-exit output,
 * no accepted measurement, and a stale ABANDON decision in the native session. */
export async function seedBlockedValidation(f: Awaited<ReturnType<typeof startWebFixture>>, enablePerformance = false, legacyUnscoped = false) {
  const hasPackage = !!loadOptimizationConfig(f.configPath).config.validation.library_package;
  if (legacyUnscoped && hasPackage) throw new Error('legacy unscoped fixture requires a non-Package task');
  const { workflowId } = f.service.submitPublic({ function_name: 'kernel', entry_file: 'kernel.c',
    config_path: f.configPath, repository_root: f.repo, source_branch: 'main', enable_performance: enablePerformance,
    ...(hasPackage ? {} : { candidate_scope: { include: ['kernel.c'], exclude: [] } }) },
    { packageLoader: f.projects.packageLoader });
  const record = f.service.get(workflowId)!;
  const runtime = new OptimizationRuntime(f.store);
  const workspace = createCandidateWorkspace({ repository: f.repo, worktreeRoot: path.join(f.root, 'worktrees'), runId: 'recovery', baselineCommit: f.git('rev-parse', 'HEAD') });
  fs.writeFileSync(path.join(workspace.editing, 'kernel.c'), 'int kernel(void) { return 2; }\n');
  const checkpoint = checkpointCandidate(workspace);
  const hypothesis = proposeFixtureHypothesis(runtime, record.optimization_task_id!, 'Fold constant expression', ['kernel.c']);
  const agent = { ok: true, no_source_mutation: false, text: 'Frozen fixture candidate', hypothesis: hypothesis.description,
    hypothesis_id: hypothesis.hypothesis_id, development_findings: null, turns: 1, tool_calls: 1, messages: [], error: null };
  const candidate = runtime.recordCandidate({ taskId: record.optimization_task_id!, hypothesisId: hypothesis.hypothesis_id,
    workspace, checkpoint, hypothesis: hypothesis.description, agentIdentity: { fixture: true } });
  const experiment = runtime.startExperiment({ taskId: record.optimization_task_id!, candidateId: candidate.candidate_id, type: 'FORMAL_EVALUATION' });
  const command: CommandRunResult = { command_execution_id: 'command:recovery-correctness', command: 'fixture', args: [], cwd: workspace.validation,
    start_time: experiment.created_at, end_time: experiment.created_at, timeout_ms: 1000, duration_ms: 1,
    ok: true, exit_code: 0, timed_out: false, cancelled: false, stderr: '', stdout: 'COREPILOT_MEASUREMENT {"kind":"CORRECTNESS_CASE","subject_id":"c1","value":"PASS"}\n' };
  const failure = { code: 'EVALUATOR_IDENTITY_MISMATCH' as const, step: 'CORRECTNESS' as const,
    command_execution_id: command.command_execution_id!, message: 'Evaluator bundle changed after import' };
  const status = { ...experiment, status: 'FAILED' as const, validity: 'INVALID' as const, failure_category: 'EVALUATOR_FAILURE' as const,
    ended_at: experiment.created_at, current_step: null, cancel_requested: false, failure };
  const validation: ValidationCycleResult = { build: { ...command, command_execution_id: 'command:recovery-build', stdout: '' },
    correctness: command, correctness_cases: [{ case_id: 'c1', status: 'PASSED', parameters: { size: 1, threads: 1 }, command, error: null }],
    correctness_coverage: { planned: 1, executed: 1, passed: 1, failed: 0, complete: true },
    formal_correctness_complete: true, performance: null, passed: false, runner_status: status };
  for (const [index, step] of ['BUILD', 'CORRECTNESS'].entries()) f.store.appendCommandExecution({ ...command,
    command_execution_id: index ? command.command_execution_id! : 'command:recovery-build', schema_version: 1, experiment_id: experiment.experiment_id,
    evaluator: null, step: step as 'BUILD' | 'CORRECTNESS', sequence: index + 1 });
  runtime.synchronizeRemoteExperiment(status);
  runtime.completeValidationExperiment({ experimentId: experiment.experiment_id, validation, performance: null, factsAlreadyPersisted: true });
  const feedback = candidateEvaluationFeedback({ validation, candidateId: candidate.candidate_id, experimentId: experiment.experiment_id });
  const decision = { action: 'ABANDON' as const, candidate_id: candidate.candidate_id, experiment_id: experiment.experiment_id,
    reason: 'Cannot repair evaluator from candidate scope', hypothesis: null };
  runtime.abandonHypothesis(record.optimization_task_id!, hypothesis.hypothesis_id, decision.reason);
  const model = loadOptimizationConfig(f.configPath).config.model;
  const models = createPiModels({ endpoint: model.endpoint, modelId: model.model_id, apiKey: model.api_key! });
  const session = await PiOptimizationSession.open({ id: 'recovery-session', directory: path.join(f.root, 'session'),
    models, model: models.getModel(COREPILOT_PI_PROVIDER_ID, model.model_id)!, systemPrompt: 'Offline recovery fixture.' });
  const saved: PublicAgentWorkflowCheckpoint = { version: 1, phase: 'AGENT', round: 4, workspace, checkpoint,
    candidateId: candidate.candidate_id, activeExperimentId: null, activeHypothesisId: hypothesis.hypothesis_id,
    evaluatedHypothesisId: hypothesis.hypothesis_id, evaluationFeedback: feedback, pendingDecision: decision,
    pendingParentHypothesisId: null, developmentFindings: null, developmentGate: null, agent,
    validation, performance: null, revalidation: null, prompt: 'Stale failure feedback' };
  await session.checkpoint(saved);
  record.agent_session = await session.summary(); await session.close();
  Object.assign(record, { status: 'PERFORMANCE_THRESHOLD_NOT_MET', candidate_id: candidate.candidate_id,
    hypothesis_id: hypothesis.hypothesis_id, experiment_id: experiment.experiment_id, candidate_evaluation_feedback: feedback,
    candidate_evaluation_decision: decision, candidate_commit: checkpoint.commit, candidate_tree: checkpoint.tree,
    baseline_commit: workspace.baseline_commit, workspace_editing: workspace.editing, workspace_validation: workspace.validation,
    stop_reason: 'Historical ABANDON after repeated evaluator errors', repository_root: f.repo });
  if (legacyUnscoped) {
    // Model an old record, whose original contract and Candidate predate source authorizations.
    const task = runtime.getTask(candidate.task_id);
    delete task.target.scope.candidate_scope;
    f.store.saveOptimizationTask(task);
    delete record.source_scope_authorization;
    const preflight = loadPublicOptimizationPreflight({ function_name: 'kernel', entry_file: 'kernel.c', config_path: f.configPath,
      repository_root: f.repo, enable_performance: enablePerformance }, { allowUnscopedHistorical: true });
    record.execution_contract_digest = createHash('sha256').update(JSON.stringify({ function_name: 'kernel',
      build: preflight.config.config.build, testpack: preflight.testpack.rawSha256,
      machine: preflight.executionMachine?.machine_id ?? null,
      runner: preflight.runner.mode === 'rpc' ? preflight.runner.endpoint : 'legacy',
      workspace: preflight.config.config.target.workspace_root })).digest('hex');
  }
  f.store.saveOptimizationWorkflowJson(workflowId, JSON.stringify(record));
  return { workflowId, candidate, experiment, hypothesis, workspace, checkpoint, validation, saved };
}
