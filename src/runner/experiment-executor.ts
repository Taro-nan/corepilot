import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
  type CommandExecution,
  type Experiment,
  type ExperimentStep,
  type FailureCategory,
  type Measurement,
} from '../contracts/optimization-domain.js';
import type {
  CancelExperimentResponse,
  ExperimentCommandsResponse,
  ExperimentExecutionPlan,
  ExperimentExecutionStep,
  ExperimentMeasurementsResponse,
  ExperimentStatusResponse,
  FormalExecutionContext,
  MeasurementObservation,
  RunnerFailure,
  StagedCandidateIdentity,
  StagedEvaluatorIdentity,
  SubmitExperimentResponse,
} from '../contracts/runner-rpc.js';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import { classifyExperimentFailure, type ViolationReason } from '../contracts/experiment-failure.js';
import { sourceTreeSha256 } from '../core/source-identity.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import {
  evaluatorCommandArgumentIndex,
  expandEvaluatorArguments,
  formalCaseParameters,
  formalWorkloadParameters,
} from '../evaluator/formal-arguments.js';
import type { ValidationCommand } from '../contracts/validation-testpack.js';
import { runValidationCommand, type CommandRunResult } from '../workspace/validation-runner.js';
import { probeRunnerMachine } from './machine-probe.js';
import type { ExecutionStateRecord, RunnerStore } from './runner-store.js';
import {
  runLinuxResourceConstrainedCommand,
  unenforcedResourceContext,
  type FormalResourceCommandRunner,
  type FormalResourceContext,
  type ResourceEnforcementMode,
} from './resource-enforcement.js';

const MEASUREMENT_PREFIX = 'PHYOPT_MEASUREMENT ';
const TERMINAL_STATUSES = new Set<Experiment['status']>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const EXPERIMENT_TYPES = new Set<Experiment['type']>(['FORMAL_EVALUATION', 'REVALIDATION', 'DEVELOPMENT_FEEDBACK']);
const EXPERIMENT_STEPS = new Set<ExperimentStep>(['BUILD', 'EVALUATOR_SETUP', 'CORRECTNESS', 'PERFORMANCE', 'REVALIDATION']);
const MEASUREMENT_KINDS = new Set<Measurement['kind']>(['CORRECTNESS_CASE', 'PERFORMANCE_SAMPLE', 'PERFORMANCE_MEDIAN', 'OBSERVATION']);
const MEASUREMENT_ROLES = new Set<Exclude<Measurement['role'], null>>(['BASELINE', 'CANDIDATE', 'EVALUATOR']);
const MEASUREMENT_VALIDITY = new Set<Measurement['validity']>(['VALID', 'INVALID', 'UNKNOWN']);

export class RunnerPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerPlanError';
  }
}

export class DuplicateExperimentError extends Error {
  constructor(experimentId: string) {
    super(`experiment '${experimentId}' already exists`);
    this.name = 'DuplicateExperimentError';
  }
}

export interface ExperimentExecutorOptions {
  workspaceRoot: string;
  runnerId?: string;
  resourceEnforcement?: ResourceEnforcementMode;
  formalResourceCommandRunner?: FormalResourceCommandRunner;
  allowTargetValidatedDigest?: string;
  now?: () => Date;
  idFactory?: () => string;
  cancelConfirmationMs?: number;
}

interface ActiveExecution {
  controller: AbortController;
  promise: Promise<void>;
  cancelConfirmationTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Mechanical Execution Plane runtime. It schedules no Agent work and makes no
 * correctness or performance acceptance decision.
 */
export class ExperimentExecutor {
  private readonly workspaceRoot: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly cancelConfirmationMs: number;
  private readonly resourceEnforcement: ResourceEnforcementMode;
  private readonly formalResourceCommandRunner: FormalResourceCommandRunner;
  private readonly active = new Map<string, ActiveExecution>();
  private initialized = false;
  private shuttingDown = false;
  private runnerIdentity = '';

  constructor(private readonly store: RunnerStore, private readonly options: ExperimentExecutorOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.cancelConfirmationMs = options.cancelConfirmationMs ?? 5_000;
    this.resourceEnforcement = options.resourceEnforcement ?? 'DISABLED';
    this.formalResourceCommandRunner = options.formalResourceCommandRunner ?? runLinuxResourceConstrainedCommand;
  }

  initialize(): { runnerId: string; recoveredUnknown: number } {
    if (this.initialized) throw new Error('experiment executor is already initialized');
    this.store.init();
    this.runnerIdentity = this.store.resolveRunnerIdentity(this.options.runnerId);
    const recoveredUnknown = this.store.recoverInterruptedExecutions(this.timestamp());
    this.initialized = true;
    for (const record of this.store.listExecutions(['PENDING'])) this.schedule(record.experiment.experiment_id);
    return { runnerId: this.runnerIdentity, recoveredUnknown };
  }

  get runnerId(): string {
    this.requireInitialized();
    return this.runnerIdentity;
  }

  get resourceEnforcementMode(): ResourceEnforcementMode {
    return this.resourceEnforcement;
  }

  submit(value: unknown): SubmitExperimentResponse {
    this.requireReady();
    const plan = parseExecutionPlan(value, this.workspaceRoot, this.options.allowTargetValidatedDigest);
    if (this.store.getExecution(plan.experiment.experiment_id)) throw new DuplicateExperimentError(plan.experiment.experiment_id);
    const experiment = structuredClone(plan.experiment);
    this.store.createExecution({
      experiment,
      ...(plan.candidate ? { candidate: structuredClone(plan.candidate) } : {}),
      ...(plan.evaluator ? { evaluator: structuredClone(plan.evaluator) } : {}),
      steps: structuredClone(plan.steps),
      current_step: null,
      cancel_requested: false,
      failure: null,
    });
    this.schedule(experiment.experiment_id);
    return { experiment_id: experiment.experiment_id, status: experiment.status };
  }

  getExperiment(experimentId: string): ExperimentStatusResponse | null {
    this.requireInitialized();
    const record = this.store.getExecution(experimentId);
    return record ? statusResponse(record) : null;
  }

  getMeasurements(experimentId: string): ExperimentMeasurementsResponse | null {
    this.requireInitialized();
    if (!this.store.getExecution(experimentId)) return null;
    return { experiment_id: experimentId, measurements: this.store.listMeasurements(experimentId) };
  }

  getCommandExecutions(experimentId: string): ExperimentCommandsResponse | null {
    this.requireInitialized();
    if (!this.store.getExecution(experimentId)) return null;
    return { experiment_id: experimentId, command_executions: this.store.listCommandExecutions(experimentId) };
  }

  cancel(experimentId: string): CancelExperimentResponse | null {
    this.requireReady();
    const record = this.store.getExecution(experimentId);
    if (!record) return null;
    if (TERMINAL_STATUSES.has(record.experiment.status)) {
      return cancelResponse(record);
    }

    record.cancel_requested = true;
    record.experiment.updated_at = this.timestamp();
    const active = this.active.get(experimentId);
    if (record.experiment.status === 'PENDING') {
      record.experiment = terminalExperiment(record.experiment, 'CANCELLED', 'CANCELLED', this.timestamp());
      record.current_step = null;
      record.failure = null;
      this.store.saveExecution(record);
      active?.controller.abort();
      return cancelResponse(record);
    }
    if (record.experiment.status === 'RUNNING' && active) {
      this.store.saveExecution(record);
      active.controller.abort();
      active.cancelConfirmationTimer ??= setTimeout(() => {
        const latest = this.store.getExecution(experimentId);
        if (!latest || latest.experiment.status !== 'RUNNING' || !latest.cancel_requested) return;
        latest.experiment = {
          ...latest.experiment,
          status: 'UNKNOWN',
          validity: 'UNKNOWN',
          failure_category: 'UNKNOWN',
          ended_at: null,
          updated_at: this.timestamp(),
        };
        latest.failure = {
          code: 'STATE_UNKNOWN',
          message: 'cancel confirmation timed out; command termination cannot be confirmed',
          step: null,
          command_execution_id: null,
        };
        this.store.saveExecution(latest);
      }, this.cancelConfirmationMs);
      // The command close event confirms CANCELLED asynchronously. Until then
      // the durable status remains RUNNING with cancel_requested=true.
      return cancelResponse(record);
    }

    record.experiment = {
      ...record.experiment,
      status: 'UNKNOWN',
      validity: 'UNKNOWN',
      failure_category: 'UNKNOWN',
      ended_at: null,
      updated_at: this.timestamp(),
    };
    record.failure = {
      code: 'STATE_UNKNOWN',
      message: 'cancel was requested but no local process handle exists to confirm termination',
      step: null,
      command_execution_id: null,
    };
    this.store.saveExecution(record);
    return cancelResponse(record);
  }

  /** Stop local work conservatively. Active facts become UNKNOWN before abort. */
  async shutdown(): Promise<void> {
    if (!this.initialized || this.shuttingDown) return;
    this.shuttingDown = true;
    const timestamp = this.timestamp();
    for (const [experimentId, active] of this.active) {
      const record = this.store.getExecution(experimentId);
      if (record?.experiment.status === 'RUNNING') {
        record.experiment = {
          ...record.experiment,
          status: 'UNKNOWN',
          validity: 'UNKNOWN',
          failure_category: 'UNKNOWN',
          ended_at: null,
          updated_at: timestamp,
        };
        record.failure = {
          code: 'STATE_UNKNOWN',
          message: 'runner stopped before command termination could be represented as a confirmed terminal experiment state',
          step: null,
          command_execution_id: null,
        };
        this.store.saveExecution(record);
      }
      active.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
  }

  closeStore(): void {
    this.store.close();
  }

  private schedule(experimentId: string): void {
    if (this.shuttingDown || this.active.has(experimentId)) return;
    const controller = new AbortController();
    const promise = new Promise<void>((resolve) => {
      setImmediate(() => { void this.execute(experimentId, controller.signal).then(resolve, resolve); });
    }).finally(() => {
      const active = this.active.get(experimentId);
      if (active?.cancelConfirmationTimer) clearTimeout(active.cancelConfirmationTimer);
      this.active.delete(experimentId);
    });
    this.active.set(experimentId, { controller, promise });
  }

  private async execute(experimentId: string, signal: AbortSignal): Promise<void> {
    let record = this.store.getExecution(experimentId);
    if (!record || record.experiment.status !== 'PENDING' || this.shuttingDown) return;
    if (record.cancel_requested || signal.aborted) {
      this.confirmCancelled(record);
      return;
    }

    let formalBundle: LoadedFormalEvaluatorBundle | null = null;
    let qualificationAttestationPin: string | null = null;
    const artifactPins = new Map<string, string>();
    const verifyPinnedEvaluator = (evaluator: StagedEvaluatorIdentity): LoadedFormalEvaluatorBundle => {
      const loaded = this.verifyEvaluator(evaluator);
      if (qualificationAttestationPin === null) qualificationAttestationPin = loaded.qualification_digest;
      else if (loaded.qualification_digest !== qualificationAttestationPin) {
        throw new EvaluatorIdentityError(
          'EVALUATOR_IDENTITY_MISMATCH',
          `qualification attestation changed during execution (expected ${qualificationAttestationPin}, observed ${loaded.qualification_digest})`,
        );
      }
      return loaded;
    };
    try {
      if (record.candidate) this.verifyCandidate(record.candidate);
      if (record.evaluator) formalBundle = verifyPinnedEvaluator(record.evaluator);
      if (record.candidate && record.evaluator) this.verifyDomainSeparation(record.candidate, record.evaluator);
    } catch (error) {
      const identityError = error as CandidateIdentityError | EvaluatorIdentityError;
      const evaluatorFailure = identityError instanceof EvaluatorIdentityError;
      this.fail(record, evaluatorFailure ? 'EVALUATOR_FAILURE' : 'INVALID_EXPERIMENT', {
        code: identityError.code ?? (evaluatorFailure ? 'EVALUATOR_IDENTITY_MISMATCH' : 'CANDIDATE_IDENTITY_MISMATCH'),
        message: boundedMessage(identityError.message),
        step: null,
        command_execution_id: null,
      });
      return;
    }

    const startedAt = this.timestamp();
    record.experiment = {
      ...record.experiment,
      status: 'RUNNING',
      started_at: startedAt,
      updated_at: startedAt,
      observed_context: {
        ...(record.experiment.observed_context ?? {}),
        runner_id: this.runnerIdentity,
        machine: probeRunnerMachine(),
        ...(record.evaluator ? {
          evaluator: {
            id: record.evaluator.evaluator_id,
            version: record.evaluator.version,
            digest: record.evaluator.digest,
          },
        } : {}),
        ...(formalBundle ? {
          resource_policy: {
            declared: {
              cpu_set: formalBundle.manifest.resource_requirements.cpu_set,
              numa_node: formalBundle.manifest.resource_requirements.numa_node,
              thread_counts: formalBundle.manifest.resource_requirements.thread_counts,
            },
            mode: this.resourceEnforcement,
            applied: null,
            observed: {
              cpu_sets: [],
              child_cpu_sets: [],
              numa_policies: [],
              thread_counts: {},
            },
            enforcement: { cpu_set: 'NOT_ENFORCED', numa_node: 'NOT_ENFORCED', threads: 'NOT_ENFORCED' },
            validity: this.resourceEnforcement === 'REQUIRED' ? 'PENDING' : 'NOT_ENFORCED',
            validated_command_count: 0,
          },
        } : {}),
      },
    };
    this.store.saveExecution(record);

    try {
      for (const step of record.steps) {
        if (this.shuttingDown) return;
        record = this.store.getExecution(experimentId);
        if (!record || record.experiment.status !== 'RUNNING') return;
        if (record.cancel_requested || signal.aborted) {
          this.confirmCancelled(record);
          return;
        }

        record.current_step = step.step;
        record.experiment.updated_at = this.timestamp();
        this.store.saveExecution(record);
        let formalArtifactDigest: string | null = null;
        if (record.evaluator) {
          try {
            formalBundle = verifyPinnedEvaluator(record.evaluator);
            if (step.formal_context) formalArtifactDigest = verifyFormalArtifact(step.formal_context, artifactPins);
          } catch (error) {
            this.failEvaluatorIdentity(record, error as Error, null);
            return;
          }
        }
        const command = applyDeclaredResources(step, this.resourceEnforcement);
        let resourceContext: FormalResourceContext | null = null;
        let result: CommandRunResult;
        if (step.formal_context && this.resourceEnforcement === 'REQUIRED') {
          const constrained = await this.formalResourceCommandRunner(command, step.formal_context.resources, signal);
          result = constrained.result;
          resourceContext = constrained.resourceContext;
        } else {
          result = await runValidationCommand(command, command.cwd, { signal });
          if (step.formal_context) resourceContext = unenforcedResourceContext(step.formal_context.resources);
        }
        const execution = this.persistCommand(experimentId, step.step, result, resourceContext);

        record = this.store.getExecution(experimentId);
        if (!record || record.experiment.status === 'UNKNOWN' || this.shuttingDown) return;
        if (result.cancelled) {
          this.confirmCancelled(record);
          return;
        }
        if (result.timed_out) {
          this.fail(record, 'INFRASTRUCTURE_FAILURE', {
            code: 'COMMAND_TIMED_OUT',
            message: commandFailureMessage(result),
            step: step.step,
            command_execution_id: execution.command_execution_id,
          });
          return;
        }
        if (step.formal_context && this.resourceEnforcement === 'REQUIRED') {
          const missingFields = missingResourceContextFields(resourceContext);
          if (missingFields.length > 0) {
            this.fail(record, 'RESOURCE_UNAVAILABLE', {
              code: 'MISSING_RESOURCE_CONTEXT',
              message: `formal resource context is missing: ${missingFields.join(', ')}`,
              missing_fields: missingFields,
              violation_reason: 'MISSING_RESOURCE_CONTEXT',
              step: step.step,
              command_execution_id: execution.command_execution_id,
            });
            return;
          }
        }
        if (resourceContext) {
          mergeResourceContext(record, resourceContext);
          this.store.saveExecution(record);
          if (this.resourceEnforcement === 'REQUIRED' && resourceContext.validity !== 'VALID') {
            this.fail(record, 'RESOURCE_UNAVAILABLE', {
              code: 'RESOURCE_CONSTRAINT_UNSATISFIED',
              message: boundedMessage(resourceContext.errors.join('; ') || 'formal resource context could not be validated'),
              step: step.step,
              command_execution_id: execution.command_execution_id,
            });
            return;
          }
        }
        if (record.evaluator) {
          try {
            formalBundle = verifyPinnedEvaluator(record.evaluator);
            if (step.formal_context) formalArtifactDigest = verifyFormalArtifact(step.formal_context, artifactPins);
          } catch (error) {
            this.failEvaluatorIdentity(record, error as Error, execution.command_execution_id);
            return;
          }
        }
        if (!result.ok && step.formal_context && !result.stdout.includes(MEASUREMENT_PREFIX)) {
          this.fail(record, 'EVALUATOR_FAILURE', {
            code: 'COMMAND_FAILED',
            message: commandFailureMessage(result),
            step: step.step,
            command_execution_id: execution.command_execution_id,
          });
          return;
        }
        if (step.measurements_from_stdout || step.formal_context) {
          try {
            const observations = parseMeasurementOutput(result.stdout);
            const formalObservations = step.formal_context && formalBundle
              ? validateFormalStepOutput(step, observations, formalBundle, formalArtifactDigest as string, resourceContext)
              : observations;
            for (const observation of formalObservations) {
              this.store.appendMeasurement(this.measurement(experimentId, observation));
            }
            if (step.formal_context?.phase === 'CORRECTNESS_CASE' && formalObservations.some((item) => item.value === 'FAIL')) {
              this.fail(record, 'CORRECTNESS_FAILURE', {
                code: 'CANDIDATE_CORRECTNESS_FAILED',
                message: `formal correctness case '${step.formal_context.subject_id}' reported FAIL`,
                step: step.step,
                command_execution_id: execution.command_execution_id,
              });
              return;
            }
          } catch (error) {
            const contractError = error instanceof MeasurementContractError ? error : null;
            this.fail(record, step.formal_context ? 'INVALID_EXPERIMENT' : 'EVALUATOR_FAILURE', {
              code: step.formal_context ? 'FORMAL_CONTRACT_VIOLATION' : 'MEASUREMENT_PARSE_ERROR',
              ...(contractError ? { violation_reason: contractError.reason, missing_fields: contractError.missingFields } : {}),
              message: boundedMessage((error as Error).message),
              step: step.step,
              command_execution_id: execution.command_execution_id,
            });
            return;
          }
        }
        if (!result.ok) {
          this.fail(record, step.formal_context ? 'EVALUATOR_FAILURE' : failureCategory(step.step, result), {
            code: 'COMMAND_FAILED',
            message: commandFailureMessage(result),
            step: step.step,
            command_execution_id: execution.command_execution_id,
          });
          return;
        }
      }

      record = this.store.getExecution(experimentId);
      if (!record || record.experiment.status !== 'RUNNING' || this.shuttingDown) return;
      if (record.evaluator) {
        try {
          formalBundle = verifyPinnedEvaluator(record.evaluator);
          if (record.experiment.type === 'FORMAL_EVALUATION' && formalBundle) {
            this.finalizeFormalEvidence(record, formalBundle);
          }
        } catch (error) {
          this.failEvaluatorIdentity(record, error as Error, null);
          return;
        }
      }
      const endedAt = this.timestamp();
      record.experiment = terminalExperiment(record.experiment, 'SUCCEEDED', null, endedAt);
      record.experiment.validity = record.experiment.type === 'FORMAL_EVALUATION' ? 'VALID' : 'UNKNOWN';
      record.current_step = null;
      record.failure = null;
      this.store.saveExecution(record);
    } catch (error) {
      record = this.store.getExecution(experimentId);
      if (!record || record.experiment.status === 'UNKNOWN' || this.shuttingDown) return;
      if (signal.aborted && record.cancel_requested) {
        this.confirmCancelled(record);
        return;
      }
      this.fail(record, 'INFRASTRUCTURE_FAILURE', {
        code: 'EXECUTION_ERROR',
        message: boundedMessage((error as Error).message),
        step: record.current_step,
        command_execution_id: null,
      });
    }
  }

  private persistCommand(
    experimentId: string,
    step: ExperimentStep,
    result: CommandRunResult,
    resourceContext: FormalResourceContext | null = null,
  ): CommandExecution {
    const record = this.store.getExecution(experimentId);
    const execution: CommandExecution = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      command_execution_id: `command-execution:${this.idFactory()}`,
      experiment_id: experimentId,
      evaluator: record?.evaluator ? {
        id: record.evaluator.evaluator_id,
        version: record.evaluator.version,
        digest: record.evaluator.digest,
      } : null,
      step,
      sequence: this.store.listCommandExecutions(experimentId).length,
      command: result.command,
      args: [...result.args],
      cwd: result.cwd,
      start_time: result.start_time,
      end_time: result.end_time,
      duration_ms: result.duration_ms,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      timeout_ms: result.timeout_ms,
      timed_out: result.timed_out,
      cancelled: result.cancelled,
      resource_context: resourceContext
        ? structuredClone(resourceContext) as unknown as Record<string, unknown>
        : null,
    };
    this.store.appendCommandExecution(execution);
    return execution;
  }

  private verifyCandidate(candidate: StagedCandidateIdentity): void {
    if (!fs.existsSync(candidate.workspace_path)) {
      throw new CandidateIdentityError('CANDIDATE_NOT_FOUND', `staged candidate directory does not exist: ${candidate.workspace_path}`);
    }
    const realRoot = fs.realpathSync(this.workspaceRoot);
    const realCandidate = fs.realpathSync(candidate.workspace_path);
    if (!isInside(realCandidate, realRoot)) {
      throw new CandidateIdentityError('CANDIDATE_IDENTITY_MISMATCH', 'staged candidate resolves outside the runner workspace root');
    }
    const observed = sourceTreeSha256(realCandidate);
    if (observed !== candidate.source_sha256) {
      throw new CandidateIdentityError(
        'CANDIDATE_IDENTITY_MISMATCH',
        `staged candidate digest mismatch (expected ${candidate.source_sha256}, observed ${observed})`,
      );
    }
  }

  private verifyEvaluator(evaluator: StagedEvaluatorIdentity): LoadedFormalEvaluatorBundle {
    if (!fs.existsSync(evaluator.workspace_path)) {
      throw new EvaluatorIdentityError('EVALUATOR_NOT_FOUND', `staged evaluator directory does not exist: ${evaluator.workspace_path}`);
    }
    const realRoot = fs.realpathSync(this.workspaceRoot);
    const realEvaluator = fs.realpathSync(evaluator.workspace_path);
    if (!isInside(realEvaluator, realRoot)) {
      throw new EvaluatorIdentityError('EVALUATOR_IDENTITY_MISMATCH', 'staged evaluator resolves outside the runner workspace root');
    }
    try {
      return loadFormalEvaluatorBundle(realEvaluator, {
        requireQualified: true,
        ...(this.options.allowTargetValidatedDigest ? { allowTargetValidatedDigest: this.options.allowTargetValidatedDigest } : {}),
        expected: { evaluatorId: evaluator.evaluator_id, version: evaluator.version, digest: evaluator.digest },
      });
    } catch (error) {
      const message = (error as Error).message;
      const code = /requires QUALIFIED evaluator/.test(message) ? 'EVALUATOR_UNQUALIFIED' : 'EVALUATOR_IDENTITY_MISMATCH';
      throw new EvaluatorIdentityError(code, message);
    }
  }

  private verifyDomainSeparation(candidate: StagedCandidateIdentity, evaluator: StagedEvaluatorIdentity): void {
    const realCandidate = fs.realpathSync(candidate.workspace_path);
    const realEvaluator = fs.realpathSync(evaluator.workspace_path);
    if (isInside(realCandidate, realEvaluator) || isInside(realEvaluator, realCandidate)) {
      throw new EvaluatorIdentityError(
        'EVALUATOR_IDENTITY_MISMATCH',
        'candidate and evaluator workspaces resolve to overlapping filesystem locations',
      );
    }
  }

  private failEvaluatorIdentity(record: ExecutionStateRecord, error: Error, commandExecutionId: string | null): void {
    const identityError = error as EvaluatorIdentityError;
    this.fail(record, 'EVALUATOR_FAILURE', {
      code: identityError.code ?? 'EVALUATOR_IDENTITY_MISMATCH',
      message: boundedMessage(identityError.message),
      step: record.current_step,
      command_execution_id: commandExecutionId,
    });
  }

  private measurement(experimentId: string, observation: MeasurementObservation): Measurement {
    const record = this.store.getExecution(experimentId);
    return {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      measurement_id: `measurement:${this.idFactory()}`,
      experiment_id: experimentId,
      evaluator: record?.evaluator ? {
        id: record.evaluator.evaluator_id,
        version: record.evaluator.version,
        digest: record.evaluator.digest,
      } : null,
      ...observation,
      domain_payload: structuredClone(observation.domain_payload),
      recorded_at: this.timestamp(),
    };
  }

  private finalizeFormalEvidence(record: ExecutionStateRecord, bundle: LoadedFormalEvaluatorBundle): void {
    const measurements = this.store.listMeasurements(record.experiment.experiment_id);
    if (this.resourceEnforcement === 'REQUIRED') {
      const expectedResourceCommands = record.steps.filter((item) => item.formal_context).length;
      const resourceCommands = this.store.listCommandExecutions(record.experiment.experiment_id)
        .filter((item) => item.resource_context !== null);
      if (resourceCommands.length !== expectedResourceCommands || resourceCommands.some((item) => {
        const context = item.resource_context as { validity?: unknown } | null;
        return context?.validity !== 'VALID';
      })) {
        throw new EvaluatorIdentityError(
          'FORMAL_CONTRACT_VIOLATION',
          `formal resource evidence is incomplete or invalid (expected ${expectedResourceCommands}, observed ${resourceCommands.length})`,
        );
      }
      markAggregateResourceValid(record);
    }
    const correctness = measurements.filter((item) => item.kind === 'CORRECTNESS_CASE');
    const expectedCases = bundle.manifest.correctness.case_ids;
    const observedCases = correctness.map((item) => item.subject_id);
    if (observedCases.length !== expectedCases.length || new Set(observedCases).size !== observedCases.length ||
        !expectedCases.every((item) => observedCases.includes(item)) ||
        correctness.some((item) => item.value !== 'PASS' || item.validity !== 'VALID')) {
      throw new EvaluatorIdentityError(
        'FORMAL_CONTRACT_VIOLATION',
        `executed correctness cases do not exactly match evaluator inventory (expected ${expectedCases.length}, observed ${observedCases.length})`,
      );
    }

    const performanceContexts = record.steps.filter((item) => item.formal_context?.phase === 'PERFORMANCE_SAMPLE');
    if (performanceContexts.length === 0) return;
    const rawPerformance = measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE');
    const benchmarkDigests = new Set(rawPerformance.map((item) => {
      const identity = item.domain_payload.benchmark_identity;
      return identity && typeof identity === 'object' && !Array.isArray(identity)
        ? (identity as Record<string, unknown>).sha256
        : null;
    }));
    if (benchmarkDigests.size !== 1 || benchmarkDigests.has(null)) {
      throw new EvaluatorIdentityError('FORMAL_CONTRACT_VIOLATION', 'baseline and candidate samples did not use one identical benchmark binary');
    }
    for (const workload of bundle.workloads.workloads) {
      for (const role of ['BASELINE', 'CANDIDATE'] as const) {
        const raw = measurements.filter((item) => item.kind === 'PERFORMANCE_SAMPLE' && item.subject_id === workload.workload_id && item.role === role)
          .sort((left, right) => (left.sample_index ?? -1) - (right.sample_index ?? -1));
        const expectedCount = bundle.manifest.performance.sampling.sample_count;
        if (raw.length !== expectedCount || raw.some((item, index) => item.sample_index !== index || item.validity !== 'VALID' || typeof item.value !== 'number' || item.value <= 0)) {
          throw new EvaluatorIdentityError(
            'FORMAL_CONTRACT_VIOLATION',
            `${role} workload '${workload.workload_id}' does not contain exactly ${expectedCount} valid raw samples`,
          );
        }
        const values = raw.map((item) => item.value as number);
        this.store.appendMeasurement(this.measurement(record.experiment.experiment_id, {
          kind: 'PERFORMANCE_MEDIAN',
          role,
          subject_id: workload.workload_id,
          sample_index: null,
          value: median(values),
          unit: 'seconds',
          validity: 'VALID',
          domain_payload: {
            statistic: 'median',
            sample_count: values.length,
            raw_measurement_ids: raw.map((item) => item.measurement_id),
            parameters: formalWorkloadParameters(workload),
            evaluator_identity: evaluatorIdentity(record.evaluator as StagedEvaluatorIdentity),
            resource_policy: {
              declared: {
                threads: workload.threads,
                cpu_set: bundle.manifest.resource_requirements.cpu_set,
                numa_node: bundle.manifest.resource_requirements.numa_node,
              },
              source: 'retained_raw_measurements',
              raw_resource_contexts_valid: raw.every((item) => {
                const policy = item.domain_payload.resource_policy;
                return policy && typeof policy === 'object' && !Array.isArray(policy) &&
                  (policy as Record<string, unknown>).validity === 'VALID';
              }),
              validity: 'VALID',
            },
          },
        }));
      }
    }
  }

  private confirmCancelled(record: ExecutionStateRecord): void {
    if (record.experiment.status === 'UNKNOWN') return;
    record.experiment = terminalExperiment(record.experiment, 'CANCELLED', 'CANCELLED', this.timestamp());
    record.current_step = null;
    record.failure = null;
    this.store.saveExecution(record);
  }

  private fail(record: ExecutionStateRecord, category: FailureCategory, failure: RunnerFailure): void {
    record.experiment = terminalExperiment(record.experiment, 'FAILED', category, this.timestamp());
    record.current_step = null;
    record.failure = failure;
    this.store.saveExecution(record);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('experiment executor is not initialized');
  }

  private requireReady(): void {
    this.requireInitialized();
    if (this.shuttingDown) throw new Error('experiment executor is shutting down');
  }
}

function parseExecutionPlan(
  value: unknown,
  workspaceRoot: string,
  allowTargetValidatedDigest: string | undefined,
): ExperimentExecutionPlan {
  const input = requireRecord(value, 'request body');
  const experiment = parsePendingExperiment(input.experiment);
  const candidate = input.candidate === undefined ? undefined : parseCandidate(input.candidate, experiment, workspaceRoot);
  const evaluator = input.evaluator === undefined ? undefined : parseEvaluator(input.evaluator, experiment, workspaceRoot);
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && candidate === undefined) {
    throw new RunnerPlanError('candidate identity is required for formal evaluation and revalidation');
  }
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && evaluator === undefined) {
    throw new RunnerPlanError('evaluator identity is required for formal evaluation and revalidation');
  }
  if (candidate && evaluator && (isInside(candidate.workspace_path, evaluator.workspace_path) || isInside(evaluator.workspace_path, candidate.workspace_path))) {
    throw new RunnerPlanError('candidate and evaluator workspaces must be disjoint');
  }
  let formalBundle: LoadedFormalEvaluatorBundle | null = null;
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && evaluator) {
    try {
      formalBundle = loadFormalEvaluatorBundle(evaluator.workspace_path, {
        requireQualified: true,
        ...(allowTargetValidatedDigest ? { allowTargetValidatedDigest } : {}),
        expected: { evaluatorId: evaluator.evaluator_id, version: evaluator.version, digest: evaluator.digest },
      });
    } catch (error) {
      throw new RunnerPlanError(`formal evaluator rejected: ${(error as Error).message}`);
    }
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 2048) {
    throw new RunnerPlanError('steps must be an array containing 1..2048 commands');
  }
  const steps = input.steps.map((item, index) => parseStep(item, index, workspaceRoot, experiment, candidate, evaluator));
  if (experiment.type === 'FORMAL_EVALUATION' && formalBundle) validateFormalPlan(steps, formalBundle, evaluator as StagedEvaluatorIdentity, experiment);
  return { experiment, ...(candidate ? { candidate } : {}), ...(evaluator ? { evaluator } : {}), steps };
}

function parseCandidate(value: unknown, experiment: Experiment, workspaceRoot: string): StagedCandidateIdentity {
  const candidate = requireRecord(value, 'candidate');
  for (const field of ['candidate_id', 'commit', 'tree', 'source_sha256', 'workspace_path'] as const) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') {
      throw new RunnerPlanError(`candidate.${field} must be a non-empty string`);
    }
  }
  if (candidate.candidate_id !== experiment.candidate_id) throw new RunnerPlanError('candidate.candidate_id must match experiment.candidate_id');
  if (!/^[0-9a-f]{64}$/i.test(candidate.source_sha256 as string)) throw new RunnerPlanError('candidate.source_sha256 must be a SHA-256 digest');
  if (!path.isAbsolute(candidate.workspace_path as string)) throw new RunnerPlanError('candidate.workspace_path must be absolute');
  const workspacePath = path.resolve(candidate.workspace_path as string);
  if (!isInside(workspacePath, workspaceRoot)) throw new RunnerPlanError('candidate.workspace_path must stay inside the runner workspace root');
  return {
    candidate_id: candidate.candidate_id as string,
    commit: candidate.commit as string,
    tree: candidate.tree as string,
    source_sha256: (candidate.source_sha256 as string).toLowerCase(),
    workspace_path: workspacePath,
  };
}

function parseEvaluator(value: unknown, experiment: Experiment, workspaceRoot: string): StagedEvaluatorIdentity {
  const evaluator = requireRecord(value, 'evaluator');
  for (const field of ['evaluator_id', 'version', 'digest', 'workspace_path'] as const) {
    if (typeof evaluator[field] !== 'string' || evaluator[field].trim() === '') {
      throw new RunnerPlanError(`evaluator.${field} must be a non-empty string`);
    }
  }
  if (evaluator.evaluator_id !== experiment.evaluator.id) throw new RunnerPlanError('evaluator.evaluator_id must match experiment.evaluator.id');
  if (evaluator.version !== experiment.evaluator.version) throw new RunnerPlanError('evaluator.version must match experiment.evaluator.version');
  if (!/^[0-9a-f]{64}$/i.test(evaluator.digest as string)) throw new RunnerPlanError('evaluator.digest must be a SHA-256 digest');
  if (typeof experiment.evaluator.digest !== 'string' || (evaluator.digest as string).toLowerCase() !== experiment.evaluator.digest.toLowerCase()) {
    throw new RunnerPlanError('evaluator.digest must match experiment.evaluator.digest');
  }
  if (!path.isAbsolute(evaluator.workspace_path as string)) throw new RunnerPlanError('evaluator.workspace_path must be absolute');
  const workspacePath = path.resolve(evaluator.workspace_path as string);
  if (!isInside(workspacePath, workspaceRoot)) throw new RunnerPlanError('evaluator.workspace_path must stay inside the runner workspace root');
  return {
    evaluator_id: evaluator.evaluator_id as string,
    version: evaluator.version as string,
    digest: (evaluator.digest as string).toLowerCase(),
    workspace_path: workspacePath,
  };
}

function parsePendingExperiment(value: unknown): Experiment {
  const experiment = requireRecord(value, 'experiment') as unknown as Experiment;
  for (const field of ['experiment_id', 'task_id', 'candidate_id', 'created_at', 'updated_at'] as const) {
    if (typeof experiment[field] !== 'string' || experiment[field].trim() === '') throw new RunnerPlanError(`experiment.${field} must be a non-empty string`);
  }
  if (experiment.schema_version !== OPTIMIZATION_DOMAIN_SCHEMA_VERSION) throw new RunnerPlanError('unsupported experiment schema_version');
  if (!EXPERIMENT_TYPES.has(experiment.type)) throw new RunnerPlanError('experiment.type is invalid');
  if (experiment.status !== 'PENDING') throw new RunnerPlanError('experiment.status must be PENDING when submitted');
  if (experiment.validity !== 'UNKNOWN' || experiment.failure_category !== null || experiment.evaluation !== null) {
    throw new RunnerPlanError('a submitted experiment must not contain an evaluation result');
  }
  if (experiment.started_at !== null || experiment.ended_at !== null) throw new RunnerPlanError('a submitted experiment must not have start/end timestamps');
  requireRecord(experiment.evaluator, 'experiment.evaluator');
  requireRecord(experiment.baseline, 'experiment.baseline');
  requireRecord(experiment.declared_context, 'experiment.declared_context');
  if (experiment.observed_context !== null) requireRecord(experiment.observed_context, 'experiment.observed_context');
  return structuredClone(experiment);
}

function parseStep(
  value: unknown,
  index: number,
  workspaceRoot: string,
  experiment: Experiment,
  candidate?: StagedCandidateIdentity,
  evaluator?: StagedEvaluatorIdentity,
): ExperimentExecutionStep {
  const input = requireRecord(value, `steps[${index}]`);
  if (typeof input.step !== 'string' || !EXPERIMENT_STEPS.has(input.step as ExperimentStep)) throw new RunnerPlanError(`steps[${index}].step is invalid`);
  if (input.execution_domain !== undefined && input.execution_domain !== 'CANDIDATE' && input.execution_domain !== 'EVALUATOR') {
    throw new RunnerPlanError(`steps[${index}].execution_domain must be CANDIDATE or EVALUATOR`);
  }
  const executionDomain = input.execution_domain as ExperimentExecutionStep['execution_domain'];
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && executionDomain === undefined) {
    throw new RunnerPlanError(`steps[${index}].execution_domain is required for formal evaluation and revalidation`);
  }
  if (executionDomain === 'CANDIDATE' && !candidate) throw new RunnerPlanError(`steps[${index}] requires a staged candidate`);
  if (executionDomain === 'EVALUATOR' && !evaluator) throw new RunnerPlanError(`steps[${index}] requires a staged evaluator`);
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && input.step === 'BUILD' && executionDomain !== 'CANDIDATE') {
    throw new RunnerPlanError(`steps[${index}] BUILD must execute in the CANDIDATE domain`);
  }
  if (experiment.type !== 'DEVELOPMENT_FEEDBACK' && (input.step === 'EVALUATOR_SETUP' || input.step === 'CORRECTNESS' || input.step === 'PERFORMANCE') && executionDomain !== 'EVALUATOR') {
    throw new RunnerPlanError(`steps[${index}] ${input.step} must execute in the EVALUATOR domain`);
  }
  const commandRoot = executionDomain === 'CANDIDATE'
    ? candidate?.workspace_path as string
    : executionDomain === 'EVALUATOR'
      ? evaluator?.workspace_path as string
      : workspaceRoot;
  const command = parseCommand(input.command, index, commandRoot, executionDomain ?? 'runner');
  if (input.measurements_from_stdout !== undefined && typeof input.measurements_from_stdout !== 'boolean') {
    throw new RunnerPlanError(`steps[${index}].measurements_from_stdout must be boolean`);
  }
  const formalContext = input.formal_context === undefined ? undefined : parseFormalContext(input.formal_context, index, workspaceRoot);
  return {
    step: input.step as ExperimentStep,
    command,
    ...(executionDomain ? { execution_domain: executionDomain } : {}),
    ...(input.measurements_from_stdout === true ? { measurements_from_stdout: true } : {}),
    ...(formalContext ? { formal_context: formalContext } : {}),
  };
}

function parseFormalContext(value: unknown, index: number, workspaceRoot: string): FormalExecutionContext {
  const raw = requireRecord(value, `steps[${index}].formal_context`);
  if (raw.phase !== 'CORRECTNESS_CASE' && raw.phase !== 'PERFORMANCE_WARMUP' && raw.phase !== 'PERFORMANCE_SAMPLE') {
    throw new RunnerPlanError(`steps[${index}].formal_context.phase is invalid`);
  }
  if (typeof raw.subject_id !== 'string' || raw.subject_id.trim() === '') throw new RunnerPlanError(`steps[${index}].formal_context.subject_id must be non-empty`);
  if (raw.role !== 'BASELINE' && raw.role !== 'CANDIDATE' && raw.role !== 'EVALUATOR') throw new RunnerPlanError(`steps[${index}].formal_context.role is invalid`);
  if (raw.iteration_index !== null && (!Number.isInteger(raw.iteration_index) || (raw.iteration_index as number) < 0)) {
    throw new RunnerPlanError(`steps[${index}].formal_context.iteration_index must be null or non-negative`);
  }
  const parameters = requireRecord(raw.parameters, `steps[${index}].formal_context.parameters`);
  if (!Object.values(parameters).every((item) => ['string', 'number', 'boolean'].includes(typeof item) && (typeof item !== 'number' || Number.isFinite(item)))) {
    throw new RunnerPlanError(`steps[${index}].formal_context.parameters values must be finite scalars`);
  }
  const resources = requireRecord(raw.resources, `steps[${index}].formal_context.resources`);
  const artifact = requireRecord(raw.artifact, `steps[${index}].formal_context.artifact`);
  if (typeof artifact.artifact_id !== 'string' || artifact.artifact_id.trim() === '') throw new RunnerPlanError(`steps[${index}].formal_context.artifact.artifact_id must be non-empty`);
  if (typeof artifact.path !== 'string' || !path.isAbsolute(artifact.path)) throw new RunnerPlanError(`steps[${index}].formal_context.artifact.path must be absolute`);
  const artifactPath = path.resolve(artifact.path);
  if (!isInside(artifactPath, workspaceRoot)) throw new RunnerPlanError(`steps[${index}].formal_context.artifact.path must stay inside the runner workspace root`);
  if (artifact.sha256 !== null && (typeof artifact.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(artifact.sha256))) {
    throw new RunnerPlanError(`steps[${index}].formal_context.artifact.sha256 must be null or a SHA-256 digest`);
  }
  if (!Number.isInteger(resources.threads) || (resources.threads as number) < 1) throw new RunnerPlanError(`steps[${index}].formal_context.resources.threads must be positive`);
  if (typeof resources.cpu_set !== 'string' || resources.cpu_set.trim() === '') throw new RunnerPlanError(`steps[${index}].formal_context.resources.cpu_set must be non-empty`);
  if (!Number.isInteger(resources.numa_node) || (resources.numa_node as number) < 0) throw new RunnerPlanError(`steps[${index}].formal_context.resources.numa_node must be non-negative`);
  return {
    phase: raw.phase,
    subject_id: raw.subject_id,
    role: raw.role,
    iteration_index: raw.iteration_index as number | null,
    parameters: structuredClone(parameters) as Record<string, string | number | boolean>,
    artifact: {
      artifact_id: artifact.artifact_id,
      path: artifactPath,
      sha256: typeof artifact.sha256 === 'string' ? artifact.sha256.toLowerCase() : null,
    },
    resources: {
      threads: resources.threads as number,
      cpu_set: resources.cpu_set,
      numa_node: resources.numa_node as number,
    },
  };
}

function validateFormalPlan(
  steps: readonly ExperimentExecutionStep[],
  bundle: LoadedFormalEvaluatorBundle,
  evaluator: StagedEvaluatorIdentity,
  experiment: Experiment,
): void {
  const correctnessSteps = steps.filter((item) => item.step === 'CORRECTNESS');
  const observedCases = correctnessSteps.map((item) => item.formal_context?.subject_id ?? '');
  if (JSON.stringify(observedCases) !== JSON.stringify(bundle.manifest.correctness.case_ids)) {
    throw new RunnerPlanError('formal correctness steps must exactly match manifest case inventory and order');
  }
  for (let index = 0; index < correctnessSteps.length; index += 1) {
    const step = correctnessSteps[index];
    const context = requireFormalContext(step, 'CORRECTNESS_CASE');
    const declared = bundle.correctness.cases[index];
    validateFormalCommand(step, bundle.manifest.correctness.command, evaluator.workspace_path, 'correctness');
    const artifactIndex = evaluatorCommandArgumentIndex(bundle.manifest.correctness.command.arguments, 'artifact_path');
    if (step.command.args[artifactIndex] !== context.artifact.path) throw new RunnerPlanError(`formal correctness case '${context.subject_id}' artifact argument differs from context`);
    if (context.role !== 'EVALUATOR' || context.iteration_index !== null) throw new RunnerPlanError(`formal correctness case '${context.subject_id}' has invalid role/index`);
    if (!sameJson(context.parameters, formalCaseParameters(declared))) throw new RunnerPlanError(`formal correctness case '${context.subject_id}' parameters differ from inventory`);
    validateFormalArguments(step, bundle.manifest.correctness.command, {
      ...context.parameters,
      case_id: context.subject_id,
      artifact_path: context.artifact.path,
    }, `correctness case '${context.subject_id}'`);
    validateResources(context, declared.threads, bundle);
    if (step.measurements_from_stdout !== true) throw new RunnerPlanError(`formal correctness case '${context.subject_id}' must parse structured measurements`);
  }

  const performanceSteps = steps.filter((item) => item.step === 'PERFORMANCE');
  if (performanceSteps.length === 0) return;
  const candidateArtifact = correctnessSteps[0].formal_context?.artifact;
  let baselineArtifact: FormalExecutionContext['artifact'] | null = null;
  const expectedKeys: string[] = [];
  for (const workload of bundle.workloads.workloads) {
    for (let iteration = 0; iteration < bundle.manifest.performance.sampling.warmup_count; iteration += 1) {
      for (const role of ['BASELINE', 'CANDIDATE'] as const) expectedKeys.push(formalKey('PERFORMANCE_WARMUP', workload.workload_id, role, iteration));
    }
    for (let iteration = 0; iteration < bundle.manifest.performance.sampling.sample_count; iteration += 1) {
      for (const role of ['BASELINE', 'CANDIDATE'] as const) expectedKeys.push(formalKey('PERFORMANCE_SAMPLE', workload.workload_id, role, iteration));
    }
  }
  const observedKeys: string[] = [];
  for (const step of performanceSteps) {
    const context = step.formal_context;
    if (!context || (context.phase !== 'PERFORMANCE_WARMUP' && context.phase !== 'PERFORMANCE_SAMPLE')) {
      throw new RunnerPlanError('every formal performance step requires a warmup or sample context');
    }
    const workload = bundle.workloads.workloads.find((item) => item.workload_id === context.subject_id);
    if (!workload) throw new RunnerPlanError(`formal performance step references unknown workload '${context.subject_id}'`);
    if (context.role !== 'BASELINE' && context.role !== 'CANDIDATE') throw new RunnerPlanError(`formal performance workload '${context.subject_id}' has invalid role`);
    if (context.iteration_index === null) throw new RunnerPlanError(`formal performance workload '${context.subject_id}' requires an iteration index`);
    if (!sameJson(context.parameters, formalWorkloadParameters(workload))) throw new RunnerPlanError(`formal performance workload '${context.subject_id}' parameters differ from inventory`);
    validateResources(context, workload.threads, bundle);
    validateFormalCommand(step, bundle.manifest.performance.command, evaluator.workspace_path, 'performance');
    const artifactIndex = evaluatorCommandArgumentIndex(bundle.manifest.performance.command.arguments, 'artifact_path');
    if (step.command.args[artifactIndex] !== context.artifact.path) throw new RunnerPlanError(`formal performance workload '${context.subject_id}' artifact argument differs from context`);
    validateFormalArguments(step, bundle.manifest.performance.command, {
      ...context.parameters,
      phase: context.phase === 'PERFORMANCE_WARMUP' ? 'warmup' : 'sample',
      role: context.role,
      workload_id: context.subject_id,
      artifact_path: context.artifact.path,
      iteration_index: context.iteration_index,
    }, `performance workload '${context.subject_id}'`);
    if (context.role === 'CANDIDATE' && !sameJson(context.artifact, candidateArtifact)) {
      throw new RunnerPlanError('formal correctness and Candidate performance must use the same candidate artifact identity');
    }
    if (context.role === 'BASELINE') {
      baselineArtifact ??= context.artifact;
      if (!sameJson(context.artifact, baselineArtifact)) throw new RunnerPlanError('all Baseline samples must use one staged artifact identity');
    }
    if (context.phase === 'PERFORMANCE_SAMPLE' && step.measurements_from_stdout !== true) {
      throw new RunnerPlanError(`formal sample '${context.subject_id}' must parse its raw measurement`);
    }
    if (context.phase === 'PERFORMANCE_WARMUP' && step.measurements_from_stdout === true) {
      throw new RunnerPlanError(`formal warmup '${context.subject_id}' must not be stored as a raw sample`);
    }
    observedKeys.push(formalKey(context.phase, context.subject_id, context.role, context.iteration_index));
  }
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    throw new RunnerPlanError('formal performance steps must exactly match workload, role, warmup, and sample inventory order');
  }
  if (typeof experiment.baseline.digest === 'string' && baselineArtifact?.sha256 !== experiment.baseline.digest.toLowerCase()) {
    throw new RunnerPlanError('formal Baseline artifact digest must match experiment.baseline.digest');
  }
}

function requireFormalContext(step: ExperimentExecutionStep, phase: FormalExecutionContext['phase']): FormalExecutionContext {
  if (!step.formal_context || step.formal_context.phase !== phase) throw new RunnerPlanError(`formal ${step.step} step requires ${phase} context`);
  return step.formal_context;
}

function validateResources(context: FormalExecutionContext, threads: number, bundle: LoadedFormalEvaluatorBundle): void {
  const declared = bundle.manifest.resource_requirements;
  if (context.resources.threads !== threads || context.resources.cpu_set !== declared.cpu_set || context.resources.numa_node !== declared.numa_node) {
    throw new RunnerPlanError(`formal resource declaration differs from evaluator policy for '${context.subject_id}'`);
  }
}

function validateFormalCommand(
  step: ExperimentExecutionStep,
  expected: LoadedFormalEvaluatorBundle['manifest']['correctness']['command'],
  evaluatorRoot: string,
  label: string,
): void {
  const executable = path.basename(step.command.executable).replace(/\.exe$/i, '');
  const expectedExecutable = path.basename(expected.executable).replace(/\.exe$/i, '');
  const scriptArgument = step.command.args[0];
  const actualScript = scriptArgument ? path.resolve(step.command.cwd, scriptArgument) : '';
  const expectedScript = path.resolve(evaluatorRoot, ...expected.script.split('/'));
  if (executable !== expectedExecutable || actualScript !== expectedScript) {
    throw new RunnerPlanError(`formal ${label} step must execute the manifest-declared evaluator script`);
  }
}

function validateFormalArguments(
  step: ExperimentExecutionStep,
  contract: LoadedFormalEvaluatorBundle['manifest']['correctness']['command'],
  bindings: Record<string, string | number | boolean | null>,
  label: string,
): void {
  const runtimeIndex = evaluatorCommandArgumentIndex(contract.arguments, 'runtime_root');
  const runtimeRoot = step.command.args[runtimeIndex];
  if (!runtimeRoot) throw new RunnerPlanError(`formal ${label} has no runtime_root argument`);
  const normalized: Record<string, string | number | boolean> = { runtime_root: runtimeRoot };
  for (const [name, value] of Object.entries(bindings)) {
    if (value !== null) normalized[name] = value;
  }
  const expected = expandEvaluatorArguments(contract.arguments, normalized, label);
  const observed = step.command.args.slice(1);
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new RunnerPlanError(`formal ${label} command arguments differ from manifest inventory and execution context`);
  }
}

function formalKey(phase: string, subject: string, role: string, index: number): string {
  return `${phase}\0${subject}\0${role}\0${index}`;
}

function parseCommand(value: unknown, index: number, commandRoot: string, domain: string): ValidationCommand {
  const command = requireRecord(value, `steps[${index}].command`);
  if (typeof command.executable !== 'string' || command.executable.trim() === '') throw new RunnerPlanError(`steps[${index}].command.executable must be a non-empty string`);
  if (!Array.isArray(command.args) || !command.args.every((item) => typeof item === 'string')) throw new RunnerPlanError(`steps[${index}].command.args must contain only strings`);
  if (typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd)) throw new RunnerPlanError(`steps[${index}].command.cwd must be absolute`);
  const cwd = path.resolve(command.cwd);
  if (!isInside(cwd, commandRoot)) throw new RunnerPlanError(`steps[${index}].command.cwd must stay inside the ${domain} execution root`);
  const environment = requireRecord(command.environment, `steps[${index}].command.environment`);
  if (!Object.values(environment).every((item) => typeof item === 'string')) throw new RunnerPlanError(`steps[${index}].command.environment values must be strings`);
  if (!Number.isInteger(command.timeout_ms) || (command.timeout_ms as number) < 1 || (command.timeout_ms as number) > 86_400_000) {
    throw new RunnerPlanError(`steps[${index}].command.timeout_ms must be an integer in 1..86400000`);
  }
  return {
    executable: command.executable,
    args: [...command.args] as string[],
    cwd,
    environment: { ...environment } as Record<string, string>,
    timeout_ms: command.timeout_ms as number,
  };
}

function parseMeasurementOutput(stdout: string): MeasurementObservation[] {
  const output: MeasurementObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(MEASUREMENT_PREFIX)) continue;
    const raw = line.slice(MEASUREMENT_PREFIX.length);
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; }
    catch { throw new Error('measurement output contains invalid JSON'); }
    output.push(parseObservation(value));
  }
  return output;
}

function parseObservation(value: unknown): MeasurementObservation {
  const input = requireRecord(value, 'measurement');
  const missingFields = ['kind', 'role', 'subject_id', 'sample_index', 'value', 'unit', 'validity', 'domain_payload']
    .filter((name) => !Object.hasOwn(input, name)).map((name) => `measurement.${name}`);
  if (missingFields.length > 0) {
    throw new MeasurementContractError(`measurement is missing required fields: ${missingFields.join(', ')}`, 'MISSING_MEASUREMENT_FIELD', missingFields);
  }
  if (typeof input.kind !== 'string' || !MEASUREMENT_KINDS.has(input.kind as Measurement['kind'])) throw new Error('measurement.kind is invalid');
  if (input.role !== null && (typeof input.role !== 'string' || !MEASUREMENT_ROLES.has(input.role as Exclude<Measurement['role'], null>))) throw new Error('measurement.role is invalid');
  if (typeof input.subject_id !== 'string' || input.subject_id.trim() === '') throw new Error('measurement.subject_id must be a non-empty string');
  if (input.sample_index !== null && (!Number.isInteger(input.sample_index) || (input.sample_index as number) < 0)) throw new Error('measurement.sample_index must be null or a non-negative integer');
  if (input.value !== null && !['number', 'string', 'boolean'].includes(typeof input.value)) throw new Error('measurement.value must be scalar or null');
  if (typeof input.value === 'number' && !Number.isFinite(input.value)) throw new Error('measurement.value must be finite');
  if (input.unit !== null && typeof input.unit !== 'string') throw new Error('measurement.unit must be string or null');
  if (typeof input.validity !== 'string' || !MEASUREMENT_VALIDITY.has(input.validity as Measurement['validity'])) throw new Error('measurement.validity is invalid');
  const domainPayload = requireRecord(input.domain_payload, 'measurement.domain_payload');
  return {
    kind: input.kind as Measurement['kind'],
    role: input.role as Measurement['role'],
    subject_id: input.subject_id,
    sample_index: input.sample_index as number | null,
    value: input.value as Measurement['value'],
    unit: input.unit as string | null,
    validity: input.validity as Measurement['validity'],
    domain_payload: structuredClone(domainPayload),
  };
}

function applyDeclaredResources(step: ExperimentExecutionStep, mode: ResourceEnforcementMode): ValidationCommand {
  const context = step.formal_context;
  if (!context) return step.command;
  return {
    ...step.command,
    environment: {
      ...step.command.environment,
      OMP_NUM_THREADS: String(context.resources.threads),
      OPENBLAS_NUM_THREADS: String(context.resources.threads),
      GOTO_NUM_THREADS: String(context.resources.threads),
      OMP_DYNAMIC: 'FALSE',
      OMP_PLACES: step.command.environment.OMP_PLACES ?? 'cores',
      OMP_PROC_BIND: step.command.environment.OMP_PROC_BIND ?? 'spread',
      PHYOPT_DECLARED_CPU_SET: context.resources.cpu_set,
      PHYOPT_DECLARED_NUMA_NODE: String(context.resources.numa_node),
      PHYOPT_RESOURCE_ENFORCEMENT: mode === 'REQUIRED' ? 'ENFORCED' : 'NOT_ENFORCED',
    },
  };
}

function verifyFormalArtifact(context: FormalExecutionContext, pins: Map<string, string>): string {
  if (!fs.existsSync(context.artifact.path) || !fs.statSync(context.artifact.path).isFile()) {
    throw new EvaluatorIdentityError('FORMAL_CONTRACT_VIOLATION', `formal artifact does not exist: ${context.artifact.path}`);
  }
  const observed = createHash('sha256').update(fs.readFileSync(context.artifact.path)).digest('hex');
  const key = `${context.artifact.artifact_id}\0${context.artifact.path}`;
  const expected = context.artifact.sha256 ?? pins.get(key);
  if (expected && observed !== expected) {
    throw new EvaluatorIdentityError(
      'FORMAL_CONTRACT_VIOLATION',
      `formal artifact digest mismatch for '${context.artifact.artifact_id}' (expected ${expected}, observed ${observed})`,
    );
  }
  pins.set(key, observed);
  return observed;
}

function validateFormalStepOutput(
  step: ExperimentExecutionStep,
  observations: readonly MeasurementObservation[],
  bundle: LoadedFormalEvaluatorBundle,
  artifactDigest: string,
  resourceContext: FormalResourceContext | null,
): MeasurementObservation[] {
  const context = step.formal_context as FormalExecutionContext;
  if (context.phase === 'PERFORMANCE_WARMUP') {
    if (observations.length !== 0) throw new Error(`warmup '${context.subject_id}' emitted a retained measurement`);
    return [];
  }
  if (observations.length !== 1) throw new MeasurementContractError(
    `formal ${context.phase} '${context.subject_id}' must emit exactly one measurement`,
    observations.length === 0 ? 'MISSING_MEASUREMENT_FIELD' : 'INVALID_EVIDENCE',
    observations.length === 0 ? ['measurement'] : [],
  );
  const observation = observations[0];
  const expectedKind = context.phase === 'CORRECTNESS_CASE' ? 'CORRECTNESS_CASE' : 'PERFORMANCE_SAMPLE';
  const expectedIndex = context.phase === 'CORRECTNESS_CASE' ? null : context.iteration_index;
  if (observation.kind !== expectedKind || observation.subject_id !== context.subject_id || observation.role !== context.role || observation.sample_index !== expectedIndex) {
    throw new Error(`formal measurement identity differs from execution context for '${context.subject_id}'`);
  }
  const parameters = observation.domain_payload.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new MeasurementContractError(`formal measurement '${context.subject_id}' is missing domain_payload.parameters`, 'MISSING_MEASUREMENT_FIELD', ['domain_payload.parameters']);
  }
  const reportedParameters = parameters as Record<string, unknown>;
  const declaredParameters = { ...context.parameters };
  delete declaredParameters.threads;
  const observedParameters = { ...reportedParameters };
  if (Object.hasOwn(observedParameters, 'threads')) {
    if (observedParameters.threads !== context.resources.threads) {
      throw new MeasurementContractError(`formal measurement '${context.subject_id}' threads differ from enforced resource context`, 'INVALID_EVIDENCE');
    }
    delete observedParameters.threads;
  }
  const missingParameters = Object.keys(declaredParameters).filter((name) => !Object.hasOwn(observedParameters, name));
  if (missingParameters.length > 0) {
    throw new MeasurementContractError(
      `formal measurement '${context.subject_id}' is missing declared parameters: ${missingParameters.join(', ')}`,
      'MISSING_MEASUREMENT_FIELD',
      missingParameters.map((name) => `domain_payload.parameters.${name}`),
    );
  }
  if (context.phase === 'CORRECTNESS_CASE') {
    if (observation.value !== 'PASS' && observation.value !== 'FAIL') throw new Error(`correctness measurement '${context.subject_id}' value must be PASS or FAIL`);
  } else if (observation.validity !== 'VALID' || typeof observation.value !== 'number' || observation.value <= 0 || observation.unit !== 'seconds') {
    throw new Error(`performance sample '${context.subject_id}' must be a valid positive seconds value`);
  }
  if (observation.validity !== 'VALID') {
    throw new MeasurementContractError(`formal measurement '${context.subject_id}' is not valid evidence`, 'INVALID_EVIDENCE');
  }
  if (!sameJson(observedParameters, declaredParameters)) {
    throw new MeasurementContractError(`formal measurement parameters differ from declared context for '${context.subject_id}'`, 'INVALID_EVIDENCE');
  }
  validateMeasurementArtifactIdentity(observation, context, artifactDigest, bundle);
  return [{
    ...observation,
    domain_payload: {
      ...structuredClone(observation.domain_payload),
      evaluator_identity: evaluatorIdentity({
        evaluator_id: bundle.manifest.evaluator_id,
        version: bundle.manifest.version,
        digest: bundle.manifest.digest,
        workspace_path: bundle.root,
      }),
      resource_policy: resourceEvidence(bundle, context.resources.threads, resourceContext, observation.domain_payload.resource_observation),
    },
  }];
}

function validateMeasurementArtifactIdentity(
  observation: MeasurementObservation,
  context: FormalExecutionContext,
  artifactDigest: string,
  bundle: LoadedFormalEvaluatorBundle,
): void {
  const artifact = observation.domain_payload.artifact_identity;
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) throw new Error(`formal measurement '${context.subject_id}' is missing artifact identity`);
  const raw = artifact as Record<string, unknown>;
  const apiKey = `resolved_${bundle.manifest.domain.api.replace(/[^A-Za-z0-9_]/g, '_')}_path`;
  const resolvedPath = raw.resolved_symbol_path ?? raw[apiKey];
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.sha256) ||
      typeof resolvedPath !== 'string' || resolvedPath.trim() === '') {
    throw new Error(`formal measurement '${context.subject_id}' has invalid artifact identity`);
  }
  if (raw.sha256.toLowerCase() !== artifactDigest) {
    throw new Error(`formal measurement '${context.subject_id}' artifact digest differs from staged identity`);
  }
  if (typeof raw.input_path === 'string' && path.resolve(raw.input_path) !== context.artifact.path) {
    throw new Error(`formal measurement '${context.subject_id}' artifact path differs from staged identity`);
  }
  const binaryField = context.phase === 'CORRECTNESS_CASE' ? 'evaluator_binary_identity' : 'benchmark_identity';
  const binary = observation.domain_payload[binaryField];
  if (!binary || typeof binary !== 'object' || Array.isArray(binary) ||
      typeof (binary as Record<string, unknown>).sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/i.test((binary as Record<string, unknown>).sha256 as string)) {
    throw new Error(`formal measurement '${context.subject_id}' has invalid ${binaryField}`);
  }
}

function evaluatorIdentity(evaluator: StagedEvaluatorIdentity): Record<string, string> {
  return { id: evaluator.evaluator_id, version: evaluator.version, digest: evaluator.digest };
}

function resourceEvidence(
  bundle: LoadedFormalEvaluatorBundle,
  threads: number,
  context: FormalResourceContext | null = null,
  evaluatorObserved: unknown = undefined,
): Record<string, unknown> {
  const requirements = bundle.manifest.resource_requirements;
  if (context) {
    return {
      ...structuredClone(context),
      ...(evaluatorObserved && typeof evaluatorObserved === 'object' && !Array.isArray(evaluatorObserved)
        ? { evaluator_observation: structuredClone(evaluatorObserved as Record<string, unknown>) }
        : {}),
    };
  }
  return {
    declared: { threads, cpu_set: requirements.cpu_set, numa_node: requirements.numa_node },
    applied: null,
    observed: { active_threads: null, cpu_set: null, numa_node: null },
    enforcement: {
      threads: requirements.enforcement.threads,
      cpu_set: requirements.enforcement.cpu_set,
      numa_node: requirements.enforcement.numa_node,
    },
    validity: 'NOT_ENFORCED',
  };
}

function missingResourceContextFields(context: FormalResourceContext | null): string[] {
  if (!context) return ['command.resource_context'];
  const fields = {
    'command.resource_context.observed.cpu_set': context.observed?.cpu_set,
    'command.resource_context.observed.max_runtime_threads': context.observed?.max_runtime_threads,
    'command.resource_context.observed.thread_configuration.OMP_NUM_THREADS': context.observed?.thread_configuration?.OMP_NUM_THREADS,
    'command.resource_context.observed.numa_policy.policy': context.observed?.numa_policy?.policy,
    'command.resource_context.observed.numa_policy.node_bind': context.observed?.numa_policy?.node_bind,
    'command.resource_context.observed.numa_policy.memory_nodes': context.observed?.numa_policy?.memory_nodes,
  };
  return Object.entries(fields).filter(([, value]) => value == null || value === '').map(([field]) => field);
}

function mergeResourceContext(record: ExecutionStateRecord, context: FormalResourceContext): void {
  const observedContext = (record.experiment.observed_context ?? {}) as Record<string, unknown>;
  const current = observedContext.resource_policy;
  const policy = current && typeof current === 'object' && !Array.isArray(current)
    ? structuredClone(current as Record<string, unknown>)
    : {};
  const rawObserved = policy.observed;
  const observed = rawObserved && typeof rawObserved === 'object' && !Array.isArray(rawObserved)
    ? structuredClone(rawObserved as Record<string, unknown>)
    : {};
  const cpuSets = stringArray(observed.cpu_sets);
  const childCpuSets = stringArray(observed.child_cpu_sets);
  const numaPolicies = stringArray(observed.numa_policies);
  if (context.observed.cpu_set && !cpuSets.includes(context.observed.cpu_set)) cpuSets.push(context.observed.cpu_set);
  if (context.observed.child_cpu_set && !childCpuSets.includes(context.observed.child_cpu_set)) childCpuSets.push(context.observed.child_cpu_set);
  const numa = context.observed.numa_policy;
  if (numa) {
    const summary = `${numa.policy ?? 'UNKNOWN'}:cpu=${numa.cpu_nodes ?? 'UNKNOWN'}:node=${numa.node_bind ?? 'UNKNOWN'}:memory=${numa.memory_nodes ?? 'UNKNOWN'}`;
    if (!numaPolicies.includes(summary)) numaPolicies.push(summary);
  }
  const rawThreadCounts = observed.thread_counts;
  const threadCounts = rawThreadCounts && typeof rawThreadCounts === 'object' && !Array.isArray(rawThreadCounts)
    ? structuredClone(rawThreadCounts as Record<string, unknown>)
    : {};
  const threadKey = String(context.declared.threads);
  const priorThread = threadCounts[threadKey];
  const prior = priorThread && typeof priorThread === 'object' && !Array.isArray(priorThread)
    ? priorThread as Record<string, unknown>
    : {};
  const previousMaximum = typeof prior.max_runtime_threads === 'number' ? prior.max_runtime_threads : null;
  threadCounts[threadKey] = {
    environment: structuredClone(context.observed.thread_configuration),
    max_runtime_threads: context.observed.max_runtime_threads === null
      ? previousMaximum
      : Math.max(previousMaximum ?? 0, context.observed.max_runtime_threads),
    runtime_thread_observation: context.observed.runtime_thread_observation,
  };
  const count = typeof policy.validated_command_count === 'number' ? policy.validated_command_count : 0;
  policy.applied = context.applied ? structuredClone(context.applied) : null;
  policy.observed = { cpu_sets: cpuSets, child_cpu_sets: childCpuSets, numa_policies: numaPolicies, thread_counts: threadCounts };
  policy.enforcement = structuredClone(context.enforcement);
  policy.validity = context.validity === 'INVALID' ? 'INVALID' : (policy.validity === 'INVALID' ? 'INVALID' : context.validity);
  policy.validated_command_count = count + (context.validity === 'VALID' ? 1 : 0);
  observedContext.resource_policy = policy;
  record.experiment.observed_context = observedContext;
}

function markAggregateResourceValid(record: ExecutionStateRecord): void {
  const observedContext = (record.experiment.observed_context ?? {}) as Record<string, unknown>;
  const current = observedContext.resource_policy;
  if (!current || typeof current !== 'object' || Array.isArray(current)) return;
  observedContext.resource_policy = { ...current, validity: 'VALID' };
  record.experiment.observed_context = observedContext;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const raw = value as Record<string, unknown>;
  return `{${Object.keys(raw).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(raw[key])}`).join(',')}}`;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function statusResponse(record: ExecutionStateRecord): ExperimentStatusResponse {
  const experiment = record.experiment;
  return {
    experiment_id: experiment.experiment_id,
    task_id: experiment.task_id,
    candidate_id: experiment.candidate_id,
    type: experiment.type,
    status: experiment.status,
    validity: experiment.validity,
    current_step: record.current_step,
    started_at: experiment.started_at,
    ended_at: experiment.ended_at,
    failure_category: experiment.failure_category,
    observed_context: experiment.observed_context,
    updated_at: experiment.updated_at,
    cancel_requested: record.cancel_requested,
    failure: record.failure,
    failure_classification: classifyExperimentFailure({ status: experiment.status, failure_category: experiment.failure_category, failure: record.failure }),
  };
}

function cancelResponse(record: ExecutionStateRecord): CancelExperimentResponse {
  return {
    experiment_id: record.experiment.experiment_id,
    status: record.experiment.status,
    cancel_requested: record.cancel_requested,
  };
}

function terminalExperiment(
  experiment: Experiment,
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
  failureCategory: FailureCategory | null,
  timestamp: string,
): Experiment {
  return {
    ...experiment,
    status,
    validity: status === 'SUCCEEDED' ? 'UNKNOWN' : 'INVALID',
    failure_category: failureCategory,
    ended_at: timestamp,
    updated_at: timestamp,
  };
}

function failureCategory(step: ExperimentStep, result: CommandRunResult): FailureCategory {
  if (result.timed_out) return 'INFRASTRUCTURE_FAILURE';
  if (step === 'BUILD') return 'BUILD_FAILURE';
  if (step === 'CORRECTNESS') return 'CORRECTNESS_FAILURE';
  return 'EVALUATOR_FAILURE';
}

function commandFailureMessage(result: CommandRunResult): string {
  if (result.timed_out) return `command timed out after ${result.timeout_ms}ms`;
  return boundedMessage(result.stderr.trim() || result.stdout.trim() || `command exited with ${result.exit_code ?? 'unknown status'}`);
}

function boundedMessage(value: string): string {
  return value.slice(0, 4096);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerPlanError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function isInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

class CandidateIdentityError extends Error {
  constructor(
    readonly code: 'CANDIDATE_NOT_FOUND' | 'CANDIDATE_IDENTITY_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'CandidateIdentityError';
  }
}

class MeasurementContractError extends Error {
  constructor(message: string, readonly reason: ViolationReason, readonly missingFields: string[] = []) {
    super(message);
    this.name = 'MeasurementContractError';
  }
}

class EvaluatorIdentityError extends Error {
  constructor(
    readonly code:
      | 'EVALUATOR_NOT_FOUND'
      | 'EVALUATOR_IDENTITY_MISMATCH'
      | 'EVALUATOR_UNQUALIFIED'
      | 'FORMAL_CONTRACT_VIOLATION',
    message: string,
  ) {
    super(message);
    this.name = 'EvaluatorIdentityError';
  }
}
