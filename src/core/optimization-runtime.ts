import { randomUUID } from 'node:crypto';
import type { HypothesisOutcome, HypothesisProposal, OptimizationHypothesis, OptimizationReasoningHistory } from '../contracts/optimization-hypothesis.js';
import { candidateEvaluationFeedback } from '../workspace/candidate-evaluation-feedback.js';
import { assessHypothesisOutcome } from './hypothesis-outcome.js';
import type { FrozenEvidenceArtifactIdentity, OptimizationApprovalRecord } from '../contracts/optimization-approval.js';
import { verifyFrozenEvidenceArtifact } from '../workspace/frozen-evidence.js';
import { loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import type {
  Candidate,
  CommandExecution,
  DomainIdentity,
  Experiment,
  ExperimentType,
  FailureCategory,
  Measurement,
  OptimizationTask,
  OptimizationTaskStatus,
} from '../contracts/optimization-domain.js';
import type { DevelopmentFindings } from '../contracts/development-investigation.js';
import { OPTIMIZATION_DOMAIN_SCHEMA_VERSION } from '../contracts/optimization-domain.js';
import type { CandidateSourceScope } from '../contracts/library-package.js';
import { assertCandidateSourceScope } from '../library-package/candidate-scope.js';
import type { ExperimentStatusResponse } from '../contracts/runner-rpc.js';
import type { OptimizationStore } from '../storage/optimization-store.js';
import type { CandidateCheckpoint, CandidateWorkspaceState } from '../workspace/candidate-workspace.js';
import type {
  CommandRunResult,
  PerformanceGateResult,
  RevalidationCycleResult,
  ValidationCycleResult,
} from '../workspace/validation-runner.js';

export interface OptimizationRuntimeOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export interface CreateOptimizationTaskInput {
  workflowId: string | null;
  libraryPackage?: OptimizationTask['library_package'];
  target: OptimizationTask['target'];
  sourceBaseline: DomainIdentity;
  performanceBaseline: DomainIdentity | null;
  evaluator: DomainIdentity;
  declaredContext: Record<string, unknown>;
}

export interface RecordCandidateInput {
  taskId: string;
  hypothesisId: string;
  workspace: CandidateWorkspaceState;
  checkpoint: CandidateCheckpoint;
  hypothesis: string | null;
  developmentFindings?: DevelopmentFindings | null;
  agentIdentity: Record<string, unknown>;
}

export interface StartExperimentInput {
  taskId: string;
  candidateId: string;
  type: ExperimentType;
  evaluator?: DomainIdentity;
  baseline?: DomainIdentity;
  declaredContext?: Record<string, unknown>;
  /** RPC submission starts PENDING; the legacy in-process path starts RUNNING. */
  initialStatus?: 'PENDING' | 'RUNNING';
}

export interface CompleteValidationInput {
  experimentId: string;
  validation: ValidationCycleResult;
  performance: PerformanceGateResult | null;
  observedContext?: Record<string, unknown> | null;
  /** RPC facts were already synchronized from the Execution Plane. */
  factsAlreadyPersisted?: boolean;
}

export interface FailExperimentInput {
  experimentId: string;
  error: string;
  cancelled?: boolean;
  remoteStateUnknown?: boolean;
}

export interface ApproveOptimizationCandidateInput {
  taskId: string;
  candidateId: string;
  firstFormalExperimentId: string;
  revalidationExperimentId: string;
  evaluatorRoot: string;
  evidence: FrozenEvidenceArtifactIdentity;
  reviewer: string;
  authorization: OptimizationApprovalRecord['authorization'];
}

/**
 * The durable fact-recording part of the existing Optimization Runtime.
 *
 * This class does not run an Agent or schedule a second workflow. The current
 * OptimizationWorkflowService/public-agent-workflow remain the orchestration
 * path and call this object at their durable lifecycle boundaries.
 */
export class OptimizationRuntime {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly store: OptimizationStore, options: OptimizationRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  createTask(input: CreateOptimizationTaskInput): OptimizationTask {
    const timestamp = this.timestamp();
    const task: OptimizationTask = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      task_id: this.id('opt-task'),
      workflow_id: input.workflowId,
      ...(input.libraryPackage ? { library_package: structuredClone(input.libraryPackage) } : {}),
      status: 'CREATED',
      target: input.target,
      source_baseline: input.sourceBaseline,
      performance_baseline: input.performanceBaseline,
      evaluator: input.evaluator,
      declared_context: input.declaredContext,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.store.saveOptimizationTask(task);
    return task;
  }

  getTask(taskId: string): OptimizationTask {
    const task = this.store.getOptimizationTask(taskId);
    if (!task) throw new Error(`optimization task '${taskId}' not found`);
    return task;
  }

  getCandidate(candidateId: string): Candidate {
    const candidate = this.store.getCandidate(candidateId);
    if (!candidate) throw new Error(`candidate '${candidateId}' not found`);
    return candidate;
  }

  approveCandidate(input: ApproveOptimizationCandidateInput): OptimizationApprovalRecord {
    if (!input.reviewer?.trim() || input.reviewer.length > 256 || input.authorization?.kind !== 'EXPLICIT_OWNER_DIRECTIVE' ||
        !input.authorization.reference?.trim() || input.authorization.reference.length > 4096) {
      throw new Error('Candidate approval requires a named reviewer and explicit Owner authorization');
    }
    const existing = this.store.getCandidateApproval(input.candidateId);
    if (existing) {
      if (existing.task_id !== input.taskId || existing.first_formal_experiment_id !== input.firstFormalExperimentId ||
          existing.revalidation_experiment_id !== input.revalidationExperimentId || existing.reviewer !== input.reviewer.trim() ||
          JSON.stringify(existing.evidence_artifact_identity) !== JSON.stringify(input.evidence)) {
        throw new Error('Candidate approval cannot change after recording');
      }
      return existing;
    }
    const task = this.getTask(input.taskId);
    const candidate = this.getCandidate(input.candidateId);
    if (candidate.task_id !== task.task_id || candidate.status === 'REJECTED' || candidate.status === 'APPROVED') throw new Error('Candidate is not eligible for approval');
    if (!task.performance_baseline || input.firstFormalExperimentId === input.revalidationExperimentId) throw new Error('approval requires an independent revalidation and frozen performance baseline');
    loadFormalEvaluatorBundle(input.evaluatorRoot, {
      requireQualified: true,
      expected: { evaluatorId: task.evaluator.id, version: task.evaluator.version as string, digest: task.evaluator.digest as string },
    });
    const first = this.getExperiment(input.firstFormalExperimentId);
    const repeated = this.getExperiment(input.revalidationExperimentId);
    const outcomes = this.store.listHypothesisOutcomes(task.task_id);
    for (const [experiment, type] of [[first, 'FORMAL_EVALUATION'], [repeated, 'REVALIDATION']] as const) {
      const outcome = outcomes.find(item => item.experiment_id === experiment.experiment_id);
      const resources = experiment.observed_context?.resource_policy as Record<string, unknown> | undefined;
      if (experiment.task_id !== task.task_id || experiment.candidate_id !== candidate.candidate_id || experiment.type !== type ||
          experiment.status !== 'SUCCEEDED' || experiment.validity !== 'VALID' || experiment.failure_category !== null ||
          experiment.evaluator.id !== task.evaluator.id || experiment.evaluator.version !== task.evaluator.version || experiment.evaluator.digest !== task.evaluator.digest ||
          experiment.baseline.id !== task.performance_baseline.id || experiment.baseline.version !== task.performance_baseline.version || experiment.baseline.digest !== task.performance_baseline.digest ||
          resources?.validity !== 'VALID' ||
          experiment.evaluation?.build !== 'PASSED' || experiment.evaluation.correctness !== 'PASSED' || experiment.evaluation.performance !== 'PASSED' ||
          outcome?.hypothesis_id !== candidate.hypothesis_id || outcome.candidate_id !== candidate.candidate_id || !outcome.feedback ||
          outcome.status !== 'ACCEPTED' || assessHypothesisOutcome(outcome.feedback).status !== 'ACCEPTED') {
        throw new Error('Candidate approval requires valid Formal and independent revalidation acceptance');
      }
    }
    const firstMachine = first.observed_context?.machine as Record<string, unknown> | undefined;
    const repeatedMachine = repeated.observed_context?.machine as Record<string, unknown> | undefined;
    const machineDigest = firstMachine?.machine_identity_sha256;
    if (typeof machineDigest !== 'string' || !/^[0-9a-f]{64}$/.test(machineDigest) || machineDigest !== repeatedMachine?.machine_identity_sha256) {
      throw new Error('approval experiments do not bind one machine identity');
    }
    const evidence = verifyFrozenEvidenceArtifact(input.evidence);
    const baseline = evidence.baseline as DomainIdentity | undefined;
    const evaluator = evidence.evaluator as DomainIdentity | undefined;
    const decision = evidence.acceptance_decision as Record<string, unknown> | undefined;
    if (evidence.task_id !== task.task_id || evidence.workflow_id !== task.workflow_id || evidence.candidate_id !== candidate.candidate_id ||
        evidence.candidate_commit !== candidate.source.commit || evidence.hypothesis_id !== candidate.hypothesis_id ||
        evidence.first_formal_experiment_id !== first.experiment_id || evidence.revalidation_experiment_id !== repeated.experiment_id ||
        evidence.machine_identity_sha256 !== machineDigest || baseline?.id !== task.performance_baseline.id || baseline.version !== task.performance_baseline.version || baseline.digest !== task.performance_baseline.digest ||
        evaluator?.id !== task.evaluator.id || evaluator.version !== task.evaluator.version || evaluator.digest !== task.evaluator.digest ||
        decision?.decision !== 'PASS' || !evidence.claim_scope || typeof evidence.claim_scope !== 'object' || Array.isArray(evidence.claim_scope)) {
      throw new Error('frozen Evidence does not bind the approved Candidate and experiments');
    }
    const record: OptimizationApprovalRecord = {
      schema_version: 1, approval_id: this.id('approval'), task_id: task.task_id, workflow_id: task.workflow_id,
      candidate_id: candidate.candidate_id, candidate_commit: candidate.source.commit, candidate_before: structuredClone(candidate),
      source_baseline_identity: structuredClone(task.source_baseline), baseline_identity: structuredClone(task.performance_baseline),
      evaluator_identity: structuredClone(task.evaluator), evaluator_digest: task.evaluator.digest as string,
      machine_identity: structuredClone(firstMachine as Record<string, unknown>), first_formal_experiment_id: first.experiment_id,
      revalidation_experiment_id: repeated.experiment_id, evidence_artifact_identity: structuredClone(input.evidence),
      evidence_sha256: input.evidence.archive_sha256, approval_status: 'APPROVED', evidence_status_before: 'FROZEN', evidence_status: 'APPROVED',
      claim_scope: structuredClone(evidence.claim_scope as Record<string, unknown>), reviewer: input.reviewer.trim(), approved_at: this.timestamp(),
      authorization: structuredClone(input.authorization),
    };
    this.store.recordCandidateApproval(record);
    return record;
  }

  getHypothesis(hypothesisId: string): OptimizationHypothesis {
    if (typeof hypothesisId !== 'string' || !hypothesisId.trim()) throw new Error('Candidate requires a hypothesis_id');
    const hypothesis = this.store.getHypothesis(hypothesisId);
    if (!hypothesis) throw new Error(`optimization hypothesis '${hypothesisId}' not found`);
    return hypothesis;
  }

  proposeHypothesis(input: { taskId: string; parentHypothesisId: string | null; proposal: HypothesisProposal; agentIdentity: Record<string, unknown> }): OptimizationHypothesis {
    const task = this.getTask(input.taskId);
    if (input.parentHypothesisId && this.getHypothesis(input.parentHypothesisId).task_id !== task.task_id) throw new Error('Hypothesis parent belongs to another task');
    const proposal = structuredClone(input.proposal);
    if (Object.keys(proposal).some(key => !['description', 'motivation', 'evidence', 'expected_effect', 'risk', 'affected_scope'].includes(key))) throw new Error('unknown Hypothesis proposal field');
    for (const field of ['description', 'motivation', 'expected_effect', 'risk'] as const) {
      if (typeof proposal[field] !== 'string' || !proposal[field].trim() || proposal[field].length > 8192) throw new Error(`Hypothesis ${field} must be bounded and non-empty`);
    }
    if (!Array.isArray(proposal.affected_scope) || proposal.affected_scope.length === 0 || proposal.affected_scope.length > 64 || proposal.affected_scope.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 1024 || /^[\\/]|:|[*?]/.test(scope) || scope.replace(/\\/g, '/').split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Hypothesis affected_scope must contain relative source file paths');
    if (task.library_package) assertCandidateSourceScope(task.target.scope.candidate_scope as CandidateSourceScope, proposal.affected_scope);
    if (!Array.isArray(proposal.evidence) || proposal.evidence.length === 0 || proposal.evidence.length > 64) throw new Error('Hypothesis requires bounded investigation evidence');
    for (const evidence of proposal.evidence) {
      if (!evidence || !['SOURCE_INSPECTION', 'DEVELOPMENT_FEEDBACK', 'EXPERIMENT_FEEDBACK'].includes(evidence.kind) || typeof evidence.summary !== 'string' || !evidence.summary.trim() || evidence.summary.length > 8192) throw new Error('Hypothesis evidence is invalid');
      if (evidence.experiment_id && this.getExperiment(evidence.experiment_id).task_id !== task.task_id) throw new Error('Hypothesis evidence belongs to another task');
      if (evidence.command_execution_id && (!evidence.experiment_id || !this.store.listCommandExecutions(evidence.experiment_id).some(command => command.command_execution_id === evidence.command_execution_id))) throw new Error('Hypothesis evidence command is not part of the declared Experiment');
    }
    const timestamp = this.timestamp();
    const hypothesis: OptimizationHypothesis = { ...proposal, schema_version: 1, hypothesis_id: this.id('hypothesis'), task_id: task.task_id, parent_hypothesis_id: input.parentHypothesisId, status: 'PROPOSED', agent_identity: { ...input.agentIdentity }, abandonment: null, created_at: timestamp, updated_at: timestamp };
    this.store.createHypothesis(hypothesis);
    return hypothesis;
  }

  abandonHypothesis(taskId: string, hypothesisId: string, reason: string): void {
    if (this.getHypothesis(hypothesisId).task_id !== taskId) throw new Error('Hypothesis belongs to another task');
    if (!reason.trim() || reason.length > 4096) throw new Error('Hypothesis abandonment requires a bounded reason');
    this.store.abandonHypothesis(hypothesisId, reason, this.timestamp());
  }

  reasoningHistory(taskId: string): OptimizationReasoningHistory {
    this.getTask(taskId);
    const candidates = this.store.listCandidates(taskId);
    const experiments = this.store.listExperiments(taskId);
    const outcomes = this.store.listHypothesisOutcomes(taskId);
    return { task_id: taskId, hypotheses: this.store.listHypotheses(taskId).map(hypothesis => {
      const associated = candidates.filter(candidate => candidate.hypothesis_id === hypothesis.hypothesis_id);
      const ids = new Set(associated.map(candidate => candidate.candidate_id));
      return {
        hypothesis,
        candidates: associated.map(candidate => ({ candidate_id: candidate.candidate_id, parent_candidate_id: candidate.parent_candidate_id, hypothesis_id: candidate.hypothesis_id, hypothesis: candidate.hypothesis, source: candidate.source })),
        experiments: experiments.filter(experiment => ids.has(experiment.candidate_id)).map(experiment => ({ experiment_id: experiment.experiment_id, candidate_id: experiment.candidate_id, type: experiment.type, status: experiment.status, validity: experiment.validity, failure_category: experiment.failure_category, evaluation: experiment.evaluation })),
        outcomes: outcomes.filter(outcome => outcome.hypothesis_id === hypothesis.hypothesis_id),
      };
    }) };
  }

  getExperiment(experimentId: string): Experiment {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new Error(`experiment '${experimentId}' not found`);
    return experiment;
  }

  updateTask(taskId: string, patch: Partial<Pick<OptimizationTask,
    'status' | 'source_baseline' | 'performance_baseline' | 'evaluator' | 'declared_context'>>): OptimizationTask {
    const current = this.getTask(taskId);
    const next: OptimizationTask = { ...current, ...patch, updated_at: this.timestamp() };
    this.store.saveOptimizationTask(next);
    return next;
  }

  setTaskStatus(taskId: string, status: OptimizationTaskStatus): OptimizationTask {
    return this.updateTask(taskId, { status });
  }

  recordCandidate(input: RecordCandidateInput): Candidate {
    const task = this.getTask(input.taskId);
    const hypothesis = this.getHypothesis(input.hypothesisId);
    if (hypothesis.task_id !== input.taskId || hypothesis.status === 'ABANDONED') throw new Error('Candidate requires an active Hypothesis from the same task');
    assertCandidateSourceScope({ include: hypothesis.affected_scope, exclude: [] }, input.checkpoint.files.map(item => item.path));
    if (task.library_package) assertCandidateSourceScope(task.target.scope.candidate_scope as CandidateSourceScope, input.checkpoint.files.map((item) => item.path));
    const existing = this.store.listCandidates(input.taskId);
    const parent = existing.at(-1) ?? null;
    const candidate: Candidate = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      candidate_id: this.id('candidate'),
      task_id: input.taskId,
      hypothesis_id: hypothesis.hypothesis_id,
      parent_candidate_id: parent?.candidate_id ?? null,
      sequence: (parent?.sequence ?? 0) + 1,
      status: 'FROZEN',
      source: {
        repository: input.workspace.repository,
        commit: input.checkpoint.commit,
        tree: input.checkpoint.tree,
        archive_sha256: input.checkpoint.source_archive_sha256,
        changed_files: input.checkpoint.files.map((item) => ({ ...item })),
      },
      hypothesis: hypothesis.description,
      development_findings: input.developmentFindings ? structuredClone(input.developmentFindings) : null,
      agent_identity: { ...input.agentIdentity },
      created_at: this.timestamp(),
    };
    this.store.createCandidate(candidate);
    return candidate;
  }

  startExperiment(input: StartExperimentInput): Experiment {
    const task = this.getTask(input.taskId);
    const candidate = this.store.getCandidate(input.candidateId);
    if (!candidate || candidate.task_id !== input.taskId) {
      throw new Error(`candidate '${input.candidateId}' does not belong to task '${input.taskId}'`);
    }
    const timestamp = this.timestamp();
    const status = input.initialStatus ?? 'RUNNING';
    const experiment: Experiment = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      experiment_id: this.id('experiment'),
      task_id: input.taskId,
      candidate_id: input.candidateId,
      type: input.type,
      status,
      validity: 'UNKNOWN',
      failure_category: null,
      evaluator: input.evaluator ?? task.evaluator,
      baseline: input.baseline ?? task.performance_baseline ?? task.source_baseline,
      declared_context: input.declaredContext ?? task.declared_context,
      observed_context: null,
      evaluation: null,
      started_at: status === 'RUNNING' ? timestamp : null,
      ended_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.store.createExperiment(experiment);
    return experiment;
  }

  completeValidationExperiment(input: CompleteValidationInput): Experiment {
    const experiment = input.factsAlreadyPersisted
      ? this.getExperiment(input.experimentId)
      : this.requireRunningExperiment(input.experimentId);
    if (!input.factsAlreadyPersisted) this.appendValidationFacts(experiment.experiment_id, input.validation, input.performance, '');
    const commands = this.store.listCommandExecutions(experiment.experiment_id);
    const cancelled = commands.some((item) => item.cancelled);
    const timedOut = commands.some((item) => item.timed_out);
    const evaluation = validationEvaluation(input.validation, input.performance);
    const formalIncomplete = input.validation.build.ok
      && input.validation.correctness !== null
      && !input.validation.formal_correctness_complete;
    const failureCategory = validationFailure(input.validation, input.performance, { cancelled, timedOut, formalIncomplete });
    const timestamp = this.timestamp();
    const executionStatus = input.factsAlreadyPersisted
      ? experiment.status
      : cancelled ? 'CANCELLED' : timedOut ? 'FAILED' : 'SUCCEEDED';
    const completed: Experiment = {
      ...experiment,
      status: executionStatus,
      validity: executionStatus === 'UNKNOWN'
        ? 'UNKNOWN'
        : executionStatus === 'FAILED' || executionStatus === 'CANCELLED' || timedOut || formalIncomplete
          ? 'INVALID'
          : 'VALID',
      failure_category: experiment.failure_category ?? failureCategory,
      observed_context: input.observedContext ?? experiment.observed_context,
      evaluation,
      ended_at: experiment.ended_at ?? timestamp,
      updated_at: timestamp,
    };
    this.store.saveExperiment(completed);
    this.recordHypothesisOutcome(completed, input.validation, input.performance);
    return completed;
  }

  completeRevalidationExperiment(input: {
    experimentId: string;
    revalidation: RevalidationCycleResult;
    observedContext?: Record<string, unknown> | null;
    factsAlreadyPersisted?: boolean;
  }): Experiment {
    const experiment = input.factsAlreadyPersisted
      ? this.getExperiment(input.experimentId)
      : this.requireRunningExperiment(input.experimentId);
    if (!input.factsAlreadyPersisted && input.revalidation.formal) this.appendValidationFacts(experiment.experiment_id, input.revalidation.formal, null, 'formal');
    if (!input.factsAlreadyPersisted && input.revalidation.independent) this.appendValidationFacts(experiment.experiment_id, input.revalidation.independent, null, 'independent');
    const commands = this.store.listCommandExecutions(experiment.experiment_id);
    const cancelled = commands.some((item) => item.cancelled);
    const timedOut = commands.some((item) => item.timed_out);
    const cycles = [input.revalidation.formal, input.revalidation.independent].filter((item): item is ValidationCycleResult => item !== null);
    const completeCorrectness = cycles.length > 0 && cycles.every((item) => item.formal_correctness_complete);
    const allBuilds = cycles.length > 0 && cycles.every((item) => item.build.ok);
    const allCorrectness = cycles.length > 0 && cycles.every((item) => item.correctness?.ok === true);
    const allPerformance = input.revalidation.performance_gate?.passed ?? cycles.every((item) => item.performance === null || item.performance.ok);
    const timestamp = this.timestamp();
    const executionStatus = input.factsAlreadyPersisted
      ? experiment.status
      : cancelled ? 'CANCELLED' : timedOut ? 'FAILED' : 'SUCCEEDED';
    const completed: Experiment = {
      ...experiment,
      status: executionStatus,
      validity: executionStatus === 'UNKNOWN'
        ? 'UNKNOWN'
        : executionStatus === 'FAILED' || executionStatus === 'CANCELLED' || timedOut || !completeCorrectness || !allPerformance ? 'INVALID' : 'VALID',
      failure_category: experiment.failure_category ?? (cancelled
        ? 'CANCELLED'
        : timedOut
          ? 'INFRASTRUCTURE_FAILURE'
          : !allBuilds
            ? 'BUILD_FAILURE'
            : !allCorrectness
              ? 'CORRECTNESS_FAILURE'
            : !completeCorrectness
              ? 'INVALID_EXPERIMENT'
              : !allPerformance
                ? 'PERFORMANCE_REGRESSION'
              : null),
      observed_context: input.observedContext ?? experiment.observed_context,
      evaluation: {
        build: allBuilds ? 'PASSED' : 'FAILED',
        correctness: !allCorrectness ? 'FAILED' : completeCorrectness ? 'PASSED' : 'INCOMPLETE',
        performance: cycles.some((item) => item.performance !== null) || input.revalidation.performance_gate
          ? allPerformance ? 'PASSED' : 'FAILED'
          : 'NOT_EXECUTED',
        details: {
          formal_passed: input.revalidation.formal?.passed ?? null,
          independent_passed: input.revalidation.independent?.passed ?? null,
          legacy_revalidation_passed: input.revalidation.passed,
        },
      },
      ended_at: experiment.ended_at ?? timestamp,
      updated_at: timestamp,
    };
    this.store.saveExperiment(completed);
    const validation = input.revalidation.formal?.passed === false ? input.revalidation.formal : input.revalidation.independent?.passed === false ? input.revalidation.independent : input.revalidation.formal;
    this.recordHypothesisOutcome(completed, validation ?? undefined, input.revalidation.performance_gate ?? null);
    return completed;
  }

  /** Mirror runner-owned lifecycle facts without inventing a Control result. */
  synchronizeRemoteExperiment(status: ExperimentStatusResponse): Experiment {
    const experiment = this.getExperiment(status.experiment_id);
    if (experiment.task_id !== status.task_id || experiment.candidate_id !== status.candidate_id || experiment.type !== status.type) {
      throw new Error(`remote experiment identity mismatch for '${status.experiment_id}'`);
    }
    if (isConfirmedTerminal(experiment.status) && !isConfirmedTerminal(status.status)) return experiment;
    const synchronized: Experiment = {
      ...experiment,
      status: status.status,
      validity: status.validity,
      failure_category: status.failure_category,
      observed_context: status.observed_context,
      started_at: status.started_at,
      ended_at: status.ended_at,
      updated_at: status.updated_at,
    };
    this.store.saveExperiment(synchronized);
    return synchronized;
  }

  /** Idempotently copy stable-ID Execution Plane facts into the product store. */
  synchronizeRemoteFacts(input: {
    experimentId: string;
    commandExecutions: readonly CommandExecution[];
    measurements: readonly Measurement[];
  }): { commandsAdded: number; measurementsAdded: number } {
    this.getExperiment(input.experimentId);
    const commands = new Map(this.store.listCommandExecutions(input.experimentId).map((item) => [item.command_execution_id, item]));
    let commandsAdded = 0;
    for (const execution of input.commandExecutions) {
      if (execution.experiment_id !== input.experimentId) throw new Error(`remote command '${execution.command_execution_id}' belongs to another experiment`);
      const existing = commands.get(execution.command_execution_id);
      if (existing) {
        if (!sameFact(existing, execution)) throw new Error(`remote command '${execution.command_execution_id}' changed after synchronization`);
        continue;
      }
      this.store.appendCommandExecution(structuredClone(execution));
      commands.set(execution.command_execution_id, execution);
      commandsAdded += 1;
    }

    const measurements = new Map(this.store.listMeasurements(input.experimentId).map((item) => [item.measurement_id, item]));
    let measurementsAdded = 0;
    for (const measurement of input.measurements) {
      if (measurement.experiment_id !== input.experimentId) throw new Error(`remote measurement '${measurement.measurement_id}' belongs to another experiment`);
      const existing = measurements.get(measurement.measurement_id);
      if (existing) {
        if (!sameFact(existing, measurement)) throw new Error(`remote measurement '${measurement.measurement_id}' changed after synchronization`);
        continue;
      }
      this.store.appendMeasurement(structuredClone(measurement));
      measurements.set(measurement.measurement_id, measurement);
      measurementsAdded += 1;
    }
    return { commandsAdded, measurementsAdded };
  }

  markRemoteStateUnknown(experimentId: string, error: string): Experiment {
    const experiment = this.getExperiment(experimentId);
    if (isConfirmedTerminal(experiment.status)) return experiment;
    const timestamp = this.timestamp();
    const unknown: Experiment = {
      ...experiment,
      status: 'UNKNOWN',
      validity: 'UNKNOWN',
      failure_category: 'UNKNOWN',
      evaluation: experiment.evaluation ?? {
        build: 'NOT_EXECUTED',
        correctness: 'NOT_EXECUTED',
        performance: 'NOT_EXECUTED',
        details: { remote_error: error.slice(0, 16_384) },
      },
      ended_at: null,
      updated_at: timestamp,
    };
    this.store.saveExperiment(unknown);
    return unknown;
  }

  markRemoteExperimentNotFound(experimentId: string): Experiment {
    const experiment = this.getExperiment(experimentId);
    if (isConfirmedTerminal(experiment.status)) return experiment;
    const timestamp = this.timestamp();
    const failed: Experiment = {
      ...experiment,
      status: 'FAILED',
      validity: 'INVALID',
      failure_category: 'INFRASTRUCTURE_FAILURE',
      evaluation: {
        build: 'NOT_EXECUTED',
        correctness: 'NOT_EXECUTED',
        performance: 'NOT_EXECUTED',
        details: { error_code: 'REMOTE_EXPERIMENT_NOT_FOUND' },
      },
      ended_at: timestamp,
      updated_at: timestamp,
    };
    this.store.saveExperiment(failed);
    this.recordHypothesisOutcome(failed);
    return failed;
  }

  failExperiment(input: FailExperimentInput): Experiment {
    const experiment = this.requireRunningExperiment(input.experimentId);
    const timestamp = this.timestamp();
    const status = input.cancelled ? 'CANCELLED' : input.remoteStateUnknown ? 'UNKNOWN' : 'FAILED';
    const failed: Experiment = {
      ...experiment,
      status,
      validity: input.remoteStateUnknown ? 'UNKNOWN' : 'INVALID',
      failure_category: input.cancelled ? 'CANCELLED' : input.remoteStateUnknown ? 'UNKNOWN' : 'INFRASTRUCTURE_FAILURE',
      evaluation: {
        build: 'NOT_EXECUTED',
        correctness: 'NOT_EXECUTED',
        performance: 'NOT_EXECUTED',
        details: { error: input.error.slice(0, 16_384) },
      },
      ended_at: input.remoteStateUnknown ? null : timestamp,
      updated_at: timestamp,
    };
    this.store.saveExperiment(failed);
    this.recordHypothesisOutcome(failed);
    return failed;
  }

  private recordHypothesisOutcome(experiment: Experiment, validation?: ValidationCycleResult, performance: PerformanceGateResult | null = null): void {
    if (!isConfirmedTerminal(experiment.status) || experiment.type === 'DEVELOPMENT_FEEDBACK') return;
    const candidate = this.getCandidate(experiment.candidate_id);
    if (!candidate.hypothesis_id) return;
    const feedback = validation ? candidateEvaluationFeedback({
      validation: { ...validation, runner_status: {
        ...experiment,
        current_step: null,
        cancel_requested: false,
        failure: validation.runner_status?.failure ?? null,
      } },
      candidateId: candidate.candidate_id,
      experimentId: experiment.experiment_id,
      performance,
    }) : null;
    const assessment = feedback ? assessHypothesisOutcome(feedback) : { status: 'INCONCLUSIVE' as const, reason: `no complete evaluation feedback: ${experiment.failure_category ?? experiment.status}` };
    const outcome: HypothesisOutcome = { schema_version: 1, outcome_id: `hypothesis-outcome:${experiment.experiment_id}`, hypothesis_id: candidate.hypothesis_id, task_id: experiment.task_id, candidate_id: candidate.candidate_id, experiment_id: experiment.experiment_id, ...assessment, failure_category: experiment.failure_category, feedback, recorded_at: this.timestamp() };
    this.store.appendHypothesisOutcome(outcome);
  }

  private appendValidationFacts(
    experimentId: string,
    validation: ValidationCycleResult,
    performance: PerformanceGateResult | null,
    namePrefix: string,
  ): void {
    const experiment = this.getExperiment(experimentId);
    const evaluatorTrace = experiment.type === 'DEVELOPMENT_FEEDBACK' ? null : structuredClone(experiment.evaluator);
    const commandFacts: Array<{ step: CommandExecution['step']; result: CommandRunResult }> = [
      { step: namePrefix ? 'REVALIDATION' : 'BUILD', result: validation.build },
    ];
    const caseCommands = validation.correctness_cases.flatMap((item) => item.command ? [item.command] : []);
    if (caseCommands.length > 0) {
      commandFacts.push(...caseCommands.map((result) => ({ step: namePrefix ? 'REVALIDATION' as const : 'CORRECTNESS' as const, result })));
    } else if (validation.correctness) {
      commandFacts.push({ step: namePrefix ? 'REVALIDATION' : 'CORRECTNESS', result: validation.correctness });
    }
    if (validation.performance) commandFacts.push({ step: namePrefix ? 'REVALIDATION' : 'PERFORMANCE', result: validation.performance });

    let sequence = this.store.listCommandExecutions(experimentId).length;
    for (const item of commandFacts) {
      this.store.appendCommandExecution({
        schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
        command_execution_id: this.id('command-execution'),
        experiment_id: experimentId,
        evaluator: evaluatorTrace,
        step: item.step,
        sequence,
        command: item.result.command,
        args: [...item.result.args],
        cwd: item.result.cwd,
        start_time: item.result.start_time,
        end_time: item.result.end_time,
        duration_ms: item.result.duration_ms,
        exit_code: item.result.exit_code,
        stdout: item.result.stdout,
        stderr: item.result.stderr,
        timeout_ms: item.result.timeout_ms,
        timed_out: item.result.timed_out,
        cancelled: item.result.cancelled,
      });
      sequence += 1;
    }

    for (const result of validation.correctness_cases) {
      this.appendMeasurement({
        experimentId,
        kind: 'CORRECTNESS_CASE',
        subjectId: prefixed(namePrefix, result.case_id),
        role: 'EVALUATOR',
        sampleIndex: null,
        value: result.status === 'PASSED',
        unit: null,
        validity: result.status === 'INVALID' || result.status === 'NOT_EXECUTED' ? 'INVALID' : 'VALID',
        domainPayload: { status: result.status, parameters: result.parameters, error: result.error },
      });
    }
    for (const workload of performance?.workloads ?? []) {
      workload.baseline_samples.forEach((value, index) => this.appendMeasurement({
        experimentId,
        kind: 'PERFORMANCE_SAMPLE',
        subjectId: prefixed(namePrefix, workload.case_id),
        role: 'BASELINE',
        sampleIndex: index,
        value,
        unit: null,
        validity: 'VALID',
        domainPayload: { critical: workload.critical },
      }));
      workload.candidate_samples.forEach((value, index) => this.appendMeasurement({
        experimentId,
        kind: 'PERFORMANCE_SAMPLE',
        subjectId: prefixed(namePrefix, workload.case_id),
        role: 'CANDIDATE',
        sampleIndex: index,
        value,
        unit: null,
        validity: 'VALID',
        domainPayload: { critical: workload.critical },
      }));
      for (const [metric, value] of [
        ['baseline_median', workload.baseline_median],
        ['candidate_median', workload.candidate_median],
        ['speedup', workload.speedup],
      ] as const) {
        this.appendMeasurement({
          experimentId,
          kind: 'OBSERVATION',
          subjectId: prefixed(namePrefix, workload.case_id),
          role: metric === 'baseline_median' ? 'BASELINE' : metric === 'candidate_median' ? 'CANDIDATE' : 'EVALUATOR',
          sampleIndex: null,
          value,
          unit: metric === 'speedup' ? 'ratio' : null,
          validity: 'VALID',
          domainPayload: { metric, critical: workload.critical, regression: workload.regression },
        });
      }
    }
  }

  private appendMeasurement(input: {
    experimentId: string;
    kind: Measurement['kind'];
    subjectId: string;
    role: Measurement['role'];
    sampleIndex: number | null;
    value: Measurement['value'];
    unit: string | null;
    validity: Measurement['validity'];
    domainPayload: Record<string, unknown>;
  }): Measurement {
    const experiment = this.getExperiment(input.experimentId);
    const measurement: Measurement = {
      schema_version: OPTIMIZATION_DOMAIN_SCHEMA_VERSION,
      measurement_id: this.id('measurement'),
      experiment_id: input.experimentId,
      evaluator: experiment.type === 'DEVELOPMENT_FEEDBACK' ? null : structuredClone(experiment.evaluator),
      kind: input.kind,
      role: input.role,
      subject_id: input.subjectId,
      sample_index: input.sampleIndex,
      value: input.value,
      unit: input.unit,
      validity: input.validity,
      domain_payload: input.domainPayload,
      recorded_at: this.timestamp(),
    };
    this.store.appendMeasurement(measurement);
    return measurement;
  }

  private requireRunningExperiment(experimentId: string): Experiment {
    const experiment = this.store.getExperiment(experimentId);
    if (!experiment) throw new Error(`experiment '${experimentId}' not found`);
    if (experiment.status !== 'RUNNING' && experiment.status !== 'PENDING') {
      throw new Error(`experiment '${experimentId}' is already terminal (${experiment.status})`);
    }
    return experiment;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}:${this.idFactory()}`;
  }
}

function prefixed(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function isConfirmedTerminal(status: Experiment['status']): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

function sameFact(left: CommandExecution | Measurement, right: CommandExecution | Measurement): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validationEvaluation(validation: ValidationCycleResult, performance: PerformanceGateResult | null): Experiment['evaluation'] {
  const correctness = !validation.build.ok || validation.correctness === null
    ? 'NOT_EXECUTED'
    : !validation.correctness.ok || validation.correctness_coverage.failed > 0
      ? 'FAILED'
      : validation.formal_correctness_complete
        ? 'PASSED'
        : 'INCOMPLETE';
  const performanceStatus = validation.performance === null
    ? 'NOT_EXECUTED'
    : !validation.performance.ok || performance?.passed !== true
      ? 'FAILED'
      : 'PASSED';
  return {
    build: validation.build.ok ? 'PASSED' : 'FAILED',
    correctness,
    performance: performanceStatus,
    correctness_coverage: validation.correctness_coverage,
    ...(performance ? {
      performance_workloads: performance.workloads.map((item) => ({
        workload_id: item.case_id,
        baseline_samples: [...item.baseline_samples],
        candidate_samples: [...item.candidate_samples],
        baseline_median: item.baseline_median,
        candidate_median: item.candidate_median,
        speedup: item.speedup,
        critical: item.critical,
        regression: item.regression,
      })),
    } : {}),
    details: {
      validation_passed: validation.passed,
      performance_gate_passed: performance?.passed ?? null,
      performance_reason: performance?.reason ?? null,
    },
  };
}

function validationFailure(
  validation: ValidationCycleResult,
  performance: PerformanceGateResult | null,
  state: { cancelled: boolean; timedOut: boolean; formalIncomplete: boolean },
): FailureCategory | null {
  if (state.cancelled) return 'CANCELLED';
  if (state.timedOut) return 'INFRASTRUCTURE_FAILURE';
  if (!validation.build.ok) return 'BUILD_FAILURE';
  if (!validation.correctness?.ok || validation.correctness_coverage.failed > 0) return 'CORRECTNESS_FAILURE';
  if (state.formalIncomplete) return 'INVALID_EXPERIMENT';
  if (validation.performance && !validation.performance.ok) return 'EVALUATOR_FAILURE';
  if (performance && !performance.passed) {
    return performance.workloads.some((item) => item.regression) ? 'PERFORMANCE_REGRESSION' : 'PERFORMANCE_TARGET_NOT_MET';
  }
  return null;
}
