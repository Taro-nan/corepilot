import path from 'node:path';
import { resolveCandidateRoot } from '../config/runtime-path.js';
import { withRunnerValidationStatus } from '../workspace/validation-outcome.js';
import { RunnerClientError } from '../client/runner-client.js';
import type { Candidate, Experiment } from '../contracts/optimization-domain.js';
import type {
  ExperimentExecutionPlan,
  ExperimentExecutionStep,
  ExperimentStatusResponse,
  RunnerMachineInfo,
  StagedEvaluatorIdentity,
} from '../contracts/runner-rpc.js';
import type { TrustedEvaluatorBundle, ValidationBaseline, ValidationCommand, ValidationTestpack } from '../contracts/validation-testpack.js';
import type { CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import {
  validationCycleFromCommandExecutions,
  type RevalidationCycleResult,
  type ValidationCycleResult,
} from '../workspace/validation-runner.js';
import { isRunnerSubmissionRejected, type ExperimentExecutionBackend } from './experiment-execution-backend.js';
import { OptimizationRuntime } from './optimization-runtime.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../evaluator/formal-plan.js';
import { validateFormalTestpackCompatibility } from '../evaluator/testpack-compatibility.js';
import { remoteWorkspaceBuild } from '../workspace/remote-build.js';

const CONFIRMED_TERMINAL = new Set<ExperimentStatusResponse['status']>(['SUCCEEDED', 'FAILED', 'CANCELLED']);

export interface CandidateStageRequest {
  candidate: Candidate;
  experiment: Experiment;
  workspace: CandidateWorkspaceState;
}

export interface CandidateStageResult {
  candidateId: string;
  workspacePath: string;
  sourceSha256: string;
}

export type CandidateStager = (input: CandidateStageRequest, signal?: AbortSignal) => Promise<CandidateStageResult>;

export interface EvaluatorStageRequest {
  evaluator: TrustedEvaluatorBundle;
  experiment: Experiment;
}

export interface EvaluatorStageResult {
  evaluatorId: string;
  version: string;
  workspacePath: string;
  digest: string;
}

export type EvaluatorStager = (input: EvaluatorStageRequest, signal?: AbortSignal) => Promise<EvaluatorStageResult>;

export interface BaselineStageRequest {
  baseline: ValidationBaseline;
  experiment: Experiment;
}

export interface BaselineStageResult {
  baselineId: string;
  workspacePath: string;
  sha256: string;
  libraryPaths?: string[];
  dependencies?: Array<{ path: string; sha256: string }>;
}

export type BaselineStager = (input: BaselineStageRequest, signal?: AbortSignal) => Promise<BaselineStageResult>;

export interface RpcExperimentTransitionAdapterOptions {
  backend: ExperimentExecutionBackend;
  runtime: OptimizationRuntime;
  stageCandidate: CandidateStager;
  stageEvaluator: EvaluatorStager;
  stageBaseline?: BaselineStager;
  pollIntervalMs: number;
  onStatus?: (status: ExperimentStatusResponse) => void;
  cancelConfirmationMs?: number;
  /** Bootstrap-only allowance for one exact TARGET_VALIDATED evaluator digest. */
  allowTargetValidatedDigest?: string;
}

export class RemoteExperimentUnknownError extends Error {
  constructor(readonly experimentId: string, message: string) {
    super(message);
    this.name = 'RemoteExperimentUnknownError';
  }
}

/** The Runner has confirmed cancellation of this exact experiment. */
export class RemoteExperimentCancelledError extends Error {
  constructor(readonly experimentId: string) {
    super(`Runner confirmed cancellation of experiment ${experimentId}`);
    this.name = 'RemoteExperimentCancelledError';
  }
}

/**
 * Transition adapter used by the existing public Agent workflow. It maps the
 * current validation contract to runner commands, then synchronizes runner
 * facts back into the existing OptimizationRuntime.
 */
export class RpcExperimentTransitionAdapter {
  private readonly pollIntervalMs: number;
  private readonly cancelConfirmationMs: number;
  private preflightResult: { runnerId: string; machine: RunnerMachineInfo } | null = null;

  constructor(private readonly options: RpcExperimentTransitionAdapterOptions) {
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 1) throw new Error('runner poll interval must be a positive integer');
    this.pollIntervalMs = options.pollIntervalMs;
    this.cancelConfirmationMs = options.cancelConfirmationMs ?? 10_000;
  }

  async preflight(signal?: AbortSignal): Promise<{ runnerId: string; machine: RunnerMachineInfo }> {
    const result = await this.options.backend.preflight(signal);
    this.preflightResult = { runnerId: result.health.runner_id, machine: result.machine };
    return this.preflightResult;
  }

  async executeValidation(input: {
    experimentId: string;
    workspace: CandidateWorkspaceState;
    build: ValidationCommand;
    testpack: ValidationTestpack;
    sourceRoot: string;
    includePerformance: boolean;
    signal?: AbortSignal;
    resume?: boolean;
  }): Promise<ValidationCycleResult> {
    if (input.resume) return this.resumeValidation(input.experimentId, input.testpack, input.includePerformance, input.signal);
    const experiment = this.pendingExperiment(input.experimentId);
    const candidate = this.options.runtime.getCandidate(experiment.candidate_id);
    const staged = await this.stage(experiment, candidate, input.workspace, input.signal);
    const evaluator = await this.stageEvaluator(experiment, requireEvaluator(input.testpack), input.signal);
    const baseline = input.includePerformance
      ? await this.stageBaseline(experiment, input.testpack.performance.baselines.comparison, input.signal)
      : null;
    const plan = validationPlan({
      experiment,
      candidate,
      staged,
      evaluator,
      baseline,
      build: input.build,
      testpack: input.testpack,
      sourceRoot: input.sourceRoot,
      includePerformance: input.includePerformance,
      allowTargetValidatedDigest: this.options.allowTargetValidatedDigest,
    });
    const terminal = await this.submitAndWait(plan, input.signal);
    if (terminal.status === 'UNKNOWN') throw this.unknown(experiment.experiment_id, remoteFailureMessage(terminal));
    const facts = await this.synchronizeTerminalFacts(experiment.experiment_id);
    if (terminal.status === 'CANCELLED') throw new RemoteExperimentCancelledError(experiment.experiment_id);
    if (facts.commands.length === 0) throw this.unknown(experiment.experiment_id, `原实验已结束，但没有可核对的命令记录：${remoteFailureMessage(terminal)}`);
    try {
      const validation = validationCycleFromCommandExecutions({ testpack: input.testpack, commands: facts.commands,
        includePerformance: input.includePerformance, steps: plan.steps });
      return withRunnerValidationStatus(validation, terminal);
    } catch (error) {
      if (input.signal?.aborted) throw this.unknown(experiment.experiment_id, `实验已结束，但结果尚未完成解析：${(error as Error).message}`);
      throw error;
    }
  }

  async executeRevalidation(input: {
    experimentId: string;
    workspace: CandidateWorkspaceState;
    build: ValidationCommand;
    testpack: ValidationTestpack;
    sourceRoot: string;
    signal?: AbortSignal;
    resume?: boolean;
  }): Promise<RevalidationCycleResult> {
    if (input.resume) {
      const formal = await this.resumeValidation(input.experimentId, input.testpack, true, input.signal);
      return { formal, independent: null, performance_gate: null, passed: formal.passed };
    }
    const experiment = this.pendingExperiment(input.experimentId);
    const candidate = this.options.runtime.getCandidate(experiment.candidate_id);
    const staged = await this.stage(experiment, candidate, input.workspace, input.signal);
    const evaluator = await this.stageEvaluator(experiment, requireEvaluator(input.testpack), input.signal);
    const baseline = await this.stageBaseline(experiment, input.testpack.performance.baselines.comparison, input.signal);
    const mapped = validationPlan({
      experiment,
      candidate,
      staged,
      evaluator,
      baseline,
      build: input.build,
      testpack: input.testpack,
      sourceRoot: input.sourceRoot,
      includePerformance: true,
    });
    const terminal = await this.submitAndWait(mapped, input.signal);
    if (terminal.status === 'UNKNOWN') throw this.unknown(experiment.experiment_id, remoteFailureMessage(terminal));
    const facts = await this.synchronizeTerminalFacts(experiment.experiment_id);
    if (terminal.status === 'CANCELLED') throw new RemoteExperimentCancelledError(experiment.experiment_id);
    if (facts.commands.length === 0) throw this.unknown(experiment.experiment_id, `原实验已结束，但没有可核对的命令记录：${remoteFailureMessage(terminal)}`);
    try {
      const validation = validationCycleFromCommandExecutions({ testpack: input.testpack, commands: facts.commands,
        includePerformance: true, steps: mapped.steps });
      const formal = withRunnerValidationStatus(validation, terminal);
      return { formal, independent: null, performance_gate: null, passed: formal.passed };
    } catch (error) {
      if (input.signal?.aborted) throw this.unknown(experiment.experiment_id, `实验已结束，但结果尚未完成解析：${(error as Error).message}`);
      throw error;
    }
  }

  /** Query by the same Domain id and idempotently synchronize any durable facts. */
  async reconcile(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    let status: ExperimentStatusResponse;
    try {
      status = await this.options.backend.reconcileExperiment(experimentId, signal);
    } catch (error) {
      throw this.unknown(experimentId, isNotFound(error)
        ? 'Runner 未找到原实验；无法确认作业是否曾执行，请核对原 Runner 和实验 ID。'
        : `无法核对原实验：${(error as Error).message}`);
    }
    try {
      this.options.runtime.synchronizeRemoteExperiment(status);
      if (CONFIRMED_TERMINAL.has(status.status) || status.status === 'UNKNOWN') await this.synchronizeFacts(experimentId, signal);
    } catch (error) { throw this.unknown(experimentId, `无法同步原实验状态：${(error as Error).message}`); }
    return status;
  }

  private pendingExperiment(experimentId: string): Experiment {
    const experiment = this.options.runtime.getExperiment(experimentId);
    if (experiment.status !== 'PENDING') throw new Error(`RPC experiment '${experimentId}' must be PENDING before submission (status: ${experiment.status})`);
    return experiment;
  }

  private async resumeValidation(experimentId: string, testpack: ValidationTestpack, includePerformance: boolean, signal?: AbortSignal): Promise<ValidationCycleResult> {
    const experiment = this.options.runtime.getExperiment(experimentId);
    const saved = experiment.declared_context.runner_execution_plan as Omit<ExperimentExecutionPlan, 'experiment'> | undefined;
    if (!saved) {
      throw this.unknown(experimentId, 'Saved Runner execution plan is missing; remote work was not restarted.');
    }
    // A 404 does not prove that an earlier submission never reached a Runner:
    // the request can still be in flight, or the Runner store can have changed.
    // Never automatically resubmit a historical experiment from a checkpoint.
    const terminal = await this.waitForTerminal(experimentId, signal);
    if (terminal.status === 'UNKNOWN') throw this.unknown(experimentId, remoteFailureMessage(terminal));
    const facts = await this.synchronizeTerminalFacts(experimentId);
    if (terminal.status === 'CANCELLED') throw new RemoteExperimentCancelledError(experimentId);
    if (!facts.commands.length) throw this.unknown(experimentId, remoteFailureMessage(terminal));
    try {
      const validation = validationCycleFromCommandExecutions({ testpack, commands: facts.commands, includePerformance, steps: saved.steps });
      return withRunnerValidationStatus(validation, terminal);
    } catch (error) {
      if (signal?.aborted) throw this.unknown(experimentId, `实验已结束，但结果尚未完成解析：${(error as Error).message}`);
      throw error;
    }
  }

  private async stage(
    experiment: Experiment,
    candidate: Candidate,
    workspace: CandidateWorkspaceState,
    signal?: AbortSignal,
  ): Promise<CandidateStageResult> {
    signal?.throwIfAborted();
    const staged = await this.options.stageCandidate({ candidate, experiment, workspace }, signal);
    if (staged.candidateId !== candidate.candidate_id) throw new Error('candidate staging returned a different candidate identity');
    if (staged.sourceSha256.toLowerCase() !== candidate.source.archive_sha256.toLowerCase()) {
      throw new Error('candidate staging returned a source identity different from the frozen Candidate');
    }
    if (!path.isAbsolute(staged.workspacePath)) throw new Error('candidate staging workspace must be absolute');
    return staged;
  }

  private async stageEvaluator(
    experiment: Experiment,
    evaluator: TrustedEvaluatorBundle,
    signal?: AbortSignal,
  ): Promise<StagedEvaluatorIdentity> {
    signal?.throwIfAborted();
    if (experiment.evaluator.id !== evaluator.id || experiment.evaluator.version !== evaluator.version ||
        experiment.evaluator.digest?.toLowerCase() !== evaluator.sha256.toLowerCase()) {
      throw new Error('experiment evaluator identity differs from the verified testpack evaluator');
    }
    const staged = await this.options.stageEvaluator({ evaluator, experiment }, signal);
    if (staged.evaluatorId !== evaluator.id || staged.version !== evaluator.version) {
      throw new Error('evaluator staging returned a different evaluator identity');
    }
    if (staged.digest.toLowerCase() !== evaluator.sha256.toLowerCase()) {
      throw new Error('evaluator staging returned content different from the verified evaluator bundle');
    }
    if (!path.isAbsolute(staged.workspacePath)) throw new Error('evaluator staging workspace must be absolute');
    return {
      evaluator_id: staged.evaluatorId,
      version: staged.version,
      digest: staged.digest.toLowerCase(),
      workspace_path: staged.workspacePath,
    };
  }

  private async stageBaseline(
    experiment: Experiment,
    baseline: ValidationBaseline,
    signal?: AbortSignal,
  ): Promise<BaselineStageResult> {
    signal?.throwIfAborted();
    if (!this.options.stageBaseline) throw new Error('RPC formal performance requires a known Baseline stager');
    if (experiment.baseline.id !== baseline.id || experiment.baseline.version !== baseline.version ||
        experiment.baseline.digest?.toLowerCase() !== baseline.sha256.toLowerCase()) {
      throw new Error('experiment Baseline identity differs from the verified testpack Baseline');
    }
    const staged = await this.options.stageBaseline({ baseline, experiment }, signal);
    if (staged.baselineId !== baseline.id) throw new Error('baseline staging returned a different baseline identity');
    if (staged.sha256.toLowerCase() !== baseline.sha256.toLowerCase()) throw new Error('baseline staging returned content different from the declared Baseline');
    if (!path.isAbsolute(staged.workspacePath)) throw new Error('baseline staging workspace must be absolute');
    return { ...staged, sha256: staged.sha256.toLowerCase() };
  }

  private async submitAndWait(plan: ExperimentExecutionPlan, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    if (!this.preflightResult) await this.preflight(signal);
    signal?.throwIfAborted();
    const { experiment: _experiment, ...stagedPlan } = plan;
    this.options.runtime.recordRemoteExecutionPlan(plan.experiment.experiment_id, stagedPlan);
    try {
      const submitted = await this.options.backend.submitExperiment(plan, signal);
      if (submitted.experiment_id !== plan.experiment.experiment_id) throw new Error('runner acknowledged a different experiment identity');
    } catch (error) {
      // Only protocol errors emitted before persistence prove rejection. A
      // 409, 5xx or interrupted request may refer to already accepted work.
      if (!signal?.aborted && isRunnerSubmissionRejected(error)) throw error;
      // Submission acknowledgement can be lost after the runner durably accepts
      // the plan. Query the supplied Domain id; never submit a replacement.
      try {
        return await this.waitForTerminal(plan.experiment.experiment_id, signal);
      } catch (reconcileError) {
        if (reconcileError instanceof RemoteExperimentUnknownError) throw reconcileError;
        throw this.unknown(plan.experiment.experiment_id, `提交结果未确认；请核对原实验：${(reconcileError as Error).message}`);
      }
    }
    return this.waitForTerminal(plan.experiment.experiment_id, signal);
  }

  private async waitForTerminal(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    let cancelRequested = false;
    let cancelDeadline = 0;
    let observationError = '';
    while (true) {
      if (signal?.aborted && signal.reason === 'backend shutting down') {
        throw this.unknown(experimentId, 'Control service stopped; the existing Runner execution is preserved for reconciliation.');
      }
      if (signal?.aborted && !cancelRequested) {
        cancelRequested = true;
        cancelDeadline = Date.now() + this.cancelConfirmationMs;
        try {
          await this.options.backend.cancelExperiment(experimentId);
        } catch (error) {
          observationError = `取消请求无法确认：${(error as Error).message}`;
        }
      }

      let status: ExperimentStatusResponse | undefined;
      try {
        status = await this.options.backend.reconcileExperiment(experimentId);
      } catch (error) {
        if (isNotFound(error)) {
          throw this.unknown(experimentId, 'Runner 未找到原实验；无法确认作业是否曾执行，请核对原 Runner 和实验 ID。');
        }
        observationError = `无法核对原实验：${(error as Error).message}`;
        if (!cancelRequested) throw this.unknown(experimentId, observationError);
      }
      if (status) {
        try { this.options.runtime.synchronizeRemoteExperiment(status); }
        catch (error) {
          throw this.unknown(experimentId, `无法同步 Runner 实验状态：${(error as Error).message}`);
        }
        try { this.options.onStatus?.(status); }
        catch (error) { throw this.unknown(experimentId, `无法保存实验进度：${(error as Error).message}`); }
        if (CONFIRMED_TERMINAL.has(status.status) || status.status === 'UNKNOWN') return status;
      }

      if (cancelRequested && Date.now() >= cancelDeadline) {
        throw this.unknown(experimentId, `Runner 未在时限内确认停止。${observationError}`);
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async synchronizeTerminalFacts(experimentId: string) {
    try {
      return await this.synchronizeFacts(experimentId);
    } catch (error) {
      throw this.unknown(experimentId, `实验终态已记录，但无法同步原始结果；请恢复连接并核对原实验：${(error as Error).message}`);
    }
  }

  private unknown(experimentId: string, message: string): RemoteExperimentUnknownError {
    try { this.options.runtime.markRemoteStateUnknown(experimentId, message); }
    catch (error) { message += `；保存未知状态失败：${(error as Error).message}`; }
    return new RemoteExperimentUnknownError(experimentId, message);
  }

  private async synchronizeFacts(experimentId: string, signal?: AbortSignal) {
    const [commands, measurements] = await Promise.all([
      this.options.backend.getCommandExecutions(experimentId, signal),
      this.options.backend.getMeasurements(experimentId, signal),
    ]);
    this.options.runtime.synchronizeRemoteFacts({
      experimentId,
      commandExecutions: commands.command_executions,
      measurements: measurements.measurements,
    });
    return { commands: commands.command_executions, measurements: measurements.measurements };
  }
}

function validationPlan(input: {
  experiment: Experiment;
  candidate: Candidate;
  staged: CandidateStageResult;
  evaluator: StagedEvaluatorIdentity;
  baseline: BaselineStageResult | null;
  build: ValidationCommand;
  testpack: ValidationTestpack;
  sourceRoot: string;
  includePerformance: boolean;
  allowTargetValidatedDigest?: string;
}): ExperimentExecutionPlan {
  const evaluatorSpec = input.testpack.evaluator as TrustedEvaluatorBundle;
  const bundle = loadFormalEvaluatorBundle(evaluatorSpec.root, {
    requireQualified: true,
    ...(input.allowTargetValidatedDigest ? { allowTargetValidatedDigest: input.allowTargetValidatedDigest } : {}),
    expected: { evaluatorId: evaluatorSpec.id, version: evaluatorSpec.version, digest: evaluatorSpec.sha256 },
  });
  validateFormalTestpackCompatibility(input.testpack, bundle);
  const mappedBuild = mapCandidateCommand(input.build, input.sourceRoot, input.staged.workspacePath);
  const buildRoot = `${input.staged.workspacePath}.build`;
  const preparedBuild = remoteWorkspaceBuild({ build: input.build,
    cwdRelative: path.relative(path.resolve(input.sourceRoot), path.resolve(input.build.cwd)) || '.',
    sourceRoot: input.staged.workspacePath, buildRoot,
    artifactPath: mapFormalArtifactPath(input.testpack.performance.baselines.current.path, input.sourceRoot, input.staged.workspacePath) });
  const steps: ExperimentExecutionStep[] = [{
    step: 'BUILD',
    execution_domain: 'CANDIDATE',
    command: { ...preparedBuild.command, cwd: mappedBuild.cwd },
  }];
  const candidateArtifactPath = preparedBuild.artifactPath;
  const baselineArtifactPath = input.baseline?.workspacePath ?? mapFormalArtifactPath(
    input.testpack.performance.baselines.comparison.path,
    input.sourceRoot,
    input.staged.workspacePath,
  );
  steps.push(...createFormalEvaluatorSteps({
    bundle,
    stagedEvaluatorRoot: input.evaluator.workspace_path,
    candidateSourceRoot: input.staged.workspacePath,
    runtimeRoot: joinForTarget(
      input.staged.workspacePath,
      `.corepilot-formal-evaluator/${`${bundle.manifest.evaluator_id}-${bundle.manifest.version}`.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
    ),
    candidateArtifact: {
      artifactId: input.testpack.performance.baselines.current.id,
      path: candidateArtifactPath,
      sha256: null,
    },
    baselineArtifact: {
      artifactId: input.testpack.performance.baselines.comparison.id,
      path: baselineArtifactPath,
      sha256: input.baseline?.sha256 ?? input.testpack.performance.baselines.comparison.sha256,
      ...(input.baseline?.dependencies ? { dependencies: input.baseline.dependencies } : {}),
    },
    ...(input.baseline?.libraryPaths ? { baselineLibraryPaths: input.baseline.libraryPaths } : {}),
    correctnessTimeoutMs: input.testpack.correctness.command.timeout_ms,
    performanceTimeoutMs: input.testpack.performance.command.timeout_ms,
    includePerformance: input.includePerformance,
  }));
  return { ...plan(input.experiment, input.candidate, input.staged, input.evaluator, steps), build_directory: buildRoot };
}

function plan(
  experiment: Experiment,
  candidate: Candidate,
  staged: CandidateStageResult,
  evaluator: StagedEvaluatorIdentity,
  steps: ExperimentExecutionStep[],
): ExperimentExecutionPlan {
  return {
    experiment,
    candidate: {
      candidate_id: candidate.candidate_id,
      commit: candidate.source.commit,
      tree: candidate.source.tree,
      source_sha256: candidate.source.archive_sha256,
      workspace_path: staged.workspacePath,
    },
    evaluator,
    steps,
  };
}

function mapCandidateCommand(command: ValidationCommand, sourceRoot: string, stagedRoot: string): ValidationCommand {
  const root = path.resolve(sourceRoot);
  const configured = path.resolve(command.cwd);
  const relative = path.relative(root, configured);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`candidate command cwd escapes source root: ${command.cwd}`);
  return {
    executable: command.executable,
    args: [...command.args],
    cwd: joinForTarget(stagedRoot, relative),
    environment: { ...command.environment },
    timeout_ms: command.timeout_ms,
  };
}

function mapFormalArtifactPath(value: string, sourceRoot: string, stagedCandidateRoot: string): string {
  const substituted = resolveCandidateRoot(value, stagedCandidateRoot);
  if (substituted !== value) return substituted;
  const configured = path.resolve(value);
  const relative = path.relative(path.resolve(sourceRoot), configured);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return joinForTarget(stagedCandidateRoot, relative);
  return value;
}

function joinForTarget(root: string, relative: string): string {
  if (/^[A-Za-z]:[\\/]/.test(root) || root.includes('\\')) return path.win32.resolve(root, relative);
  return path.posix.resolve(root.replace(/\\/g, '/'), relative.split(path.sep).join('/'));
}

function isNotFound(error: unknown): boolean {
  return error instanceof RunnerClientError && error.status === 404 && error.code === 'EXPERIMENT_NOT_FOUND';
}

function remoteFailureMessage(status: ExperimentStatusResponse): string {
  return status.failure?.message ?? `remote experiment ended with status ${status.status}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEvaluator(testpack: ValidationTestpack): TrustedEvaluatorBundle {
  if (!testpack.evaluator) throw new Error('RPC formal execution requires a verified evaluator bundle');
  return testpack.evaluator;
}
