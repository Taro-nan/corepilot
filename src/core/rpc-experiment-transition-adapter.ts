import path from 'node:path';
import { RunnerClientError } from '../client/runner-client.js';
import type { Candidate, Experiment } from '../contracts/optimization-domain.js';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
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
import type { ExperimentExecutionBackend } from './experiment-execution-backend.js';
import { OptimizationRuntime } from './optimization-runtime.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { createFormalEvaluatorSteps } from '../evaluator/formal-plan.js';
import { formalCaseParameters, formalWorkloadParameters } from '../evaluator/formal-arguments.js';
import { parametersAreSubset, validationCaseParameters } from '../testpack/validation-parameters.js';

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
}

export type BaselineStager = (input: BaselineStageRequest, signal?: AbortSignal) => Promise<BaselineStageResult>;

export interface RpcExperimentTransitionAdapterOptions {
  backend: ExperimentExecutionBackend;
  runtime: OptimizationRuntime;
  stageCandidate: CandidateStager;
  stageEvaluator: EvaluatorStager;
  stageBaseline?: BaselineStager;
  pollIntervalMs: number;
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

export class RemoteExperimentNotFoundError extends Error {
  constructor(readonly experimentId: string, submissionError?: string) {
    super(submissionError
      ? `remote experiment '${experimentId}' was not found after submission failed: ${submissionError}`
      : `remote experiment '${experimentId}' was not found after submission`);
    this.name = 'RemoteExperimentNotFoundError';
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
  }): Promise<ValidationCycleResult> {
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
    const facts = await this.synchronizeFacts(experiment.experiment_id);
    if (terminal.status === 'UNKNOWN') throw new RemoteExperimentUnknownError(experiment.experiment_id, remoteFailureMessage(terminal));
    if (terminal.status === 'CANCELLED') throw abortError('runner confirmed experiment cancellation');
    if (facts.commands.length === 0) throw new Error(remoteFailureMessage(terminal));
    const validation = validationCycleFromCommandExecutions({
      testpack: input.testpack,
      commands: facts.commands,
      includePerformance: input.includePerformance,
      steps: plan.steps,
    });
    return { ...validation, runner_status: terminal, passed: validation.passed && terminal.status === 'SUCCEEDED' };
  }

  async executeRevalidation(input: {
    experimentId: string;
    workspace: CandidateWorkspaceState;
    build: ValidationCommand;
    testpack: ValidationTestpack;
    sourceRoot: string;
    signal?: AbortSignal;
  }): Promise<RevalidationCycleResult> {
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
    const facts = await this.synchronizeFacts(experiment.experiment_id);
    if (terminal.status === 'UNKNOWN') throw new RemoteExperimentUnknownError(experiment.experiment_id, remoteFailureMessage(terminal));
    if (terminal.status === 'CANCELLED') throw abortError('runner confirmed experiment cancellation');
    if (facts.commands.length === 0) throw new Error(remoteFailureMessage(terminal));
    const validation = validationCycleFromCommandExecutions({
      testpack: input.testpack,
      commands: facts.commands,
      includePerformance: true,
      steps: mapped.steps,
    });
    const formal = { ...validation, runner_status: terminal, passed: validation.passed && terminal.status === 'SUCCEEDED' };
    return { formal, independent: null, performance_gate: null, passed: formal.passed };
  }

  /** Query by the same Domain id and idempotently synchronize any durable facts. */
  async reconcile(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    let status: ExperimentStatusResponse;
    try {
      status = await this.options.backend.reconcileExperiment(experimentId, signal);
    } catch (error) {
      if (isNotFound(error)) {
        this.options.runtime.markRemoteExperimentNotFound(experimentId);
        throw new RemoteExperimentNotFoundError(experimentId);
      }
      this.options.runtime.markRemoteStateUnknown(experimentId, (error as Error).message);
      throw error;
    }
    this.options.runtime.synchronizeRemoteExperiment(status);
    if (CONFIRMED_TERMINAL.has(status.status) || status.status === 'UNKNOWN') await this.synchronizeFacts(experimentId, signal);
    return status;
  }

  private pendingExperiment(experimentId: string): Experiment {
    const experiment = this.options.runtime.getExperiment(experimentId);
    if (experiment.status !== 'PENDING') throw new Error(`RPC experiment '${experimentId}' must be PENDING before submission (status: ${experiment.status})`);
    return experiment;
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
    try {
      const submitted = await this.options.backend.submitExperiment(plan, signal);
      if (submitted.experiment_id !== plan.experiment.experiment_id) throw new Error('runner acknowledged a different experiment identity');
    } catch (error) {
      if (signal?.aborted) throw error;
      // A concrete HTTP response means the Runner deterministically rejected
      // the request. Reconciliation is only appropriate when acknowledgement
      // may have been lost (timeout/connection failure); otherwise a follow-up
      // 404 would hide the original plan/auth/payload error.
      if (error instanceof RunnerClientError && error.status !== null) throw error;
      // Submission acknowledgement can be lost after the runner durably accepts
      // the plan. Query the supplied Domain id; never submit a replacement.
      try {
        return await this.waitForTerminal(plan.experiment.experiment_id, signal);
      } catch (reconcileError) {
        if (isNotFound(reconcileError)) {
          this.options.runtime.markRemoteExperimentNotFound(plan.experiment.experiment_id);
          throw new RemoteExperimentNotFoundError(plan.experiment.experiment_id, (error as Error).message);
        }
        this.options.runtime.markRemoteStateUnknown(plan.experiment.experiment_id, (reconcileError as Error).message);
        throw reconcileError;
      }
    }
    return this.waitForTerminal(plan.experiment.experiment_id, signal);
  }

  private async waitForTerminal(experimentId: string, signal?: AbortSignal): Promise<ExperimentStatusResponse> {
    let cancelRequested = false;
    let cancelDeadline = 0;
    while (true) {
      if (signal?.aborted && !cancelRequested) {
        cancelRequested = true;
        cancelDeadline = Date.now() + this.cancelConfirmationMs;
        try {
          await this.options.backend.cancelExperiment(experimentId);
        } catch (error) {
          this.options.runtime.markRemoteStateUnknown(experimentId, `cancel could not be confirmed: ${(error as Error).message}`);
        }
      }

      try {
        const status = await this.options.backend.reconcileExperiment(experimentId);
        this.options.runtime.synchronizeRemoteExperiment(status);
        if (CONFIRMED_TERMINAL.has(status.status) || status.status === 'UNKNOWN') return status;
      } catch (error) {
        if (isNotFound(error)) throw error;
        this.options.runtime.markRemoteStateUnknown(experimentId, (error as Error).message);
      }

      if (cancelRequested && Date.now() >= cancelDeadline) {
        throw new RemoteExperimentUnknownError(experimentId, 'runner did not confirm cancellation before the reconciliation deadline');
      }
      await delay(this.pollIntervalMs);
    }
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
  const steps: ExperimentExecutionStep[] = [{
    step: 'BUILD',
    execution_domain: 'CANDIDATE',
    command: mapCandidateCommand(input.build, input.sourceRoot, input.staged.workspacePath),
  }];
  const candidateArtifactPath = mapFormalArtifactPath(
    input.testpack.performance.baselines.current.path,
    input.sourceRoot,
    input.staged.workspacePath,
  );
  const baselineArtifactPath = input.baseline?.workspacePath ?? mapFormalArtifactPath(
    input.testpack.performance.baselines.comparison.path,
    input.sourceRoot,
    input.staged.workspacePath,
  );
  steps.push(...createFormalEvaluatorSteps({
    bundle,
    stagedEvaluatorRoot: input.evaluator.workspace_path,
    runtimeRoot: joinForTarget(
      input.staged.workspacePath,
      `.phyopt-formal-evaluator/${`${bundle.manifest.evaluator_id}-${bundle.manifest.version}`.replace(/[^A-Za-z0-9_.-]/g, '_')}`,
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
    },
    correctnessTimeoutMs: input.testpack.correctness.command.timeout_ms,
    performanceTimeoutMs: input.testpack.performance.command.timeout_ms,
    includePerformance: input.includePerformance,
  }));
  return plan(input.experiment, input.candidate, input.staged, input.evaluator, steps);
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
  const substituted = value.replaceAll('${PHYOPT_CANDIDATE_ROOT}', stagedCandidateRoot);
  if (substituted !== value) return substituted;
  const configured = path.resolve(value);
  const relative = path.relative(path.resolve(sourceRoot), configured);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return joinForTarget(stagedCandidateRoot, relative);
  return value;
}

function validateFormalTestpackCompatibility(testpack: ValidationTestpack, bundle: LoadedFormalEvaluatorBundle): void {
  const caseIds = testpack.correctness.cases.map((item) => item.case_id);
  const workloadIds = testpack.performance.cases.map((item) => item.case_id);
  if (JSON.stringify(caseIds) !== JSON.stringify(bundle.manifest.correctness.case_ids)) {
    throw new Error('formal testpack correctness inventory differs from evaluator bundle');
  }
  if (JSON.stringify(workloadIds) !== JSON.stringify(bundle.manifest.performance.workload_ids)) {
    throw new Error('formal testpack performance inventory differs from evaluator bundle');
  }
  for (let index = 0; index < testpack.correctness.cases.length; index += 1) {
    const testCase = testpack.correctness.cases[index];
    const declared = bundle.correctness.cases[index];
    if (!parametersAreSubset(validationCaseParameters(testCase), formalCaseParameters(declared))) {
      throw new Error(`formal testpack correctness parameters differ for '${testCase.case_id}'`);
    }
  }
  for (let index = 0; index < testpack.performance.cases.length; index += 1) {
    const testCase = testpack.performance.cases[index];
    const declared = bundle.workloads.workloads[index];
    if (!parametersAreSubset(validationCaseParameters(testCase), formalWorkloadParameters(declared))) {
      throw new Error(`formal testpack performance parameters differ for '${testCase.case_id}'`);
    }
  }
  if (testpack.performance.sampling.warmup !== bundle.manifest.performance.sampling.warmup_count ||
      testpack.performance.sampling.samples !== bundle.manifest.performance.sampling.sample_count) {
    throw new Error('formal testpack sampling differs from evaluator bundle');
  }
  const resources = bundle.manifest.resource_requirements;
  if (testpack.resources.cpu_set !== resources.cpu_set || !testpack.resources.numa_nodes.includes(resources.numa_node) ||
      JSON.stringify(testpack.resources.thread_counts) !== JSON.stringify(resources.thread_counts)) {
    throw new Error('formal testpack resource policy differs from evaluator bundle');
  }
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

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireEvaluator(testpack: ValidationTestpack): TrustedEvaluatorBundle {
  if (!testpack.evaluator) throw new Error('RPC formal execution requires a verified evaluator bundle');
  return testpack.evaluator;
}
