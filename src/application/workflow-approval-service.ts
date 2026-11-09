import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { CandidateVerificationSummary } from '../contracts/candidate-verification.js';
import type { WorkflowEvidenceSnapshot } from '../contracts/optimization-approval.js';
import type { Candidate, OptimizationTask, Experiment, Measurement } from '../contracts/optimization-domain.js';
import type { LoadedFormalEvaluatorBundle } from '../contracts/formal-evaluator.js';
import type { FrozenValidationTestpack, ValidationTestpack } from '../contracts/validation-testpack.js';
import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowStore } from '../workflow/optimization-workflow.js';
import { assessCandidateVerification } from '../core/candidate-verification.js';
import { hasCurrentApprovalStatistics } from '../core/approval-statistics.js';
import { OptimizationRuntime } from '../core/optimization-runtime.js';
import { listFormalEvaluatorFiles, loadFormalEvaluatorBundle } from '../evaluator/formal-evaluator.js';
import { validateFormalTestpackCompatibility } from '../evaluator/testpack-compatibility.js';
import { readFrozenValidationTestpack } from '../testpack/validation-freeze.js';
import { freezeEvidenceFiles } from '../workspace/freeze-evidence.js';
import { verifyFrozenEvidenceArtifact } from '../workspace/frozen-evidence.js';
import { assertPerformanceEvidenceConsistent } from './workflow-evidence-performance.js';

const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function requireCurrentApprovalStatistics(testpack: ValidationTestpack, first: Experiment, repeated: Experiment): void {
  if (!testpack.performance.statistics || !hasCurrentApprovalStatistics(first) || !hasCurrentApprovalStatistics(repeated)) {
    throw new Error('当前记录采用旧版点估计或缺少有效统计区间，不能作为新的正式批准依据。请确认新版测试方案，并重新执行正式实验与独立复验；原结果和历史批准会保留。');
  }
}

/** Check persisted facts again: a completed Runner result may have been only partly synchronized. */
function assertRawEvidenceComplete(experiment: Experiment, rows: readonly Measurement[], bundle: LoadedFormalEvaluatorBundle, testpack: ValidationTestpack): void {
  const fail = (detail: string): never => {
    throw new Error(`正式实验或复验缺少完整的原始正确性记录、基线或候选性能样本：${detail}。请核对实验记录并重新同步。`);
  };
  const sameEvaluator = (row: Measurement) => row.experiment_id === experiment.experiment_id
    && row.evaluator?.id === experiment.evaluator.id && row.evaluator.version === experiment.evaluator.version
    && row.evaluator.digest === experiment.evaluator.digest;
  const coverage = experiment.evaluation?.correctness_coverage;
  const correctness = rows.filter(row => row.kind === 'CORRECTNESS_CASE');
  try { validateFormalTestpackCompatibility(testpack, bundle); }
  catch (error) { fail(`${experiment.type} 的冻结测试方案与评价器不一致：${(error as Error).message}`); }
  if (!coverage || correctness.length !== coverage.planned || correctness.some(row => row.role !== 'EVALUATOR'
    || row.sample_index !== null || row.validity !== 'VALID' || (row.value !== true && row.value !== 'PASS') || !sameEvaluator(row))) {
    fail(`${experiment.type} 的正确性记录数量、状态或评价器身份不一致`);
  }

  // Locally recorded revalidation cases historically use the "formal." prefix;
  // Runner records use the unprefixed inventory IDs. Independent cases remain in coverage.
  const prefixes = experiment.type === 'REVALIDATION' ? ['', 'formal.'] : [''];
  const casesComplete = prefixes.some(prefix => bundle.manifest.correctness.case_ids.every(id =>
    correctness.filter(row => row.subject_id === prefix + id).length === 1));
  if (!casesComplete) fail(`${experiment.type} 的正确性用例与测试方案不一致或存在重复`);

  const samples = rows.filter(row => row.kind === 'PERFORMANCE_SAMPLE');
  const expectedCount = bundle.manifest.performance.sampling.sample_count;
  const samplingComplete = prefixes.some(prefix => bundle.manifest.performance.workload_ids.every(id =>
    (['BASELINE', 'CANDIDATE'] as const).every(role => {
      const selected = samples.filter(row => row.subject_id === prefix + id && row.role === role)
        .sort((a, b) => (a.sample_index ?? -1) - (b.sample_index ?? -1));
      return selected.length === expectedCount && selected.every((row, index) => row.sample_index === index
        && row.validity === 'VALID' && typeof row.value === 'number' && Number.isFinite(row.value) && row.value > 0 && sameEvaluator(row));
    })));
  if (!samplingComplete) fail(`${experiment.type} 的负载采样缺失、重复、无效或评价器身份不一致（每个负载的基线与候选各需 ${expectedCount} 条）`);
}

function candidatePatch(workflow: OptimizationWorkflowRecord, candidate: Candidate): Buffer {
  if (!workflow.repository_root || !workflow.baseline_commit || !/^[a-f0-9]{40,64}$/.test(candidate.source.commit)
    || !/^[a-f0-9]{40,64}$/.test(workflow.baseline_commit)) throw new Error('缺少可核验的源码提交或基线。');
  const git = (args: string[]) => execFileSync('git', ['--no-replace-objects', '-C', workflow.repository_root!, ...args],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  try {
    const tree = git(['rev-parse', '--verify', `${candidate.source.commit}^{tree}`]).toString('utf8').trim();
    if (tree !== candidate.source.tree) throw new Error('候选源码树与记录不一致。');
    git(['merge-base', '--is-ancestor', workflow.baseline_commit, candidate.source.commit]);
    return git(['diff', '--binary', '--no-ext-diff', workflow.baseline_commit, candidate.source.commit, '--']);
  } catch (error) { throw new Error(`无法核对候选源码及基线：${(error as Error).message}`); }
}

/** Freezes existing facts and records an explicit human decision; never delivers Git. */
export class WorkflowApprovalService {
  private readonly runtime: OptimizationRuntime;
  constructor(private readonly store: TaskStore, private readonly records: OptimizationWorkflowStore, private readonly evidenceRoot: string) {
    this.runtime = new OptimizationRuntime(store);
  }

  private assertSnapshotMatches(snapshot: WorkflowEvidenceSnapshot, facts: { task: OptimizationTask; candidate: Candidate;
    first: Experiment; repeated: Experiment; frozen: FrozenValidationTestpack }): void {
    verifyFrozenEvidenceArtifact(snapshot.artifact);
    const selected = new Set([facts.first.experiment_id, facts.repeated.experiment_id]);
    const expected = new Map<string, unknown>([
      ['task.json', facts.task], ['candidate.json', facts.candidate], ['testpack.json', facts.frozen],
      ['formal/experiment.json', facts.first], ['formal/commands.json', this.store.listCommandExecutions(facts.first.experiment_id)],
      ['formal/measurements.json', this.store.listMeasurements(facts.first.experiment_id)],
      ['revalidation/experiment.json', facts.repeated], ['revalidation/commands.json', this.store.listCommandExecutions(facts.repeated.experiment_id)],
      ['revalidation/measurements.json', this.store.listMeasurements(facts.repeated.experiment_id)],
      ['hypothesis-outcomes.json', this.store.listHypothesisOutcomes(facts.task.task_id).filter(item => selected.has(item.experiment_id))],
    ]);
    const root = path.dirname(snapshot.artifact.manifest_path);
    for (const [relative, current] of expected) {
      if (!fs.readFileSync(path.join(root, ...relative.split('/'))).equals(jsonBytes(current))) {
        throw new Error('实验事实或冻结测试方案已变化，请重新准备证据并审阅。');
      }
    }
  }

  private current(id: string) {
    const workflow = this.records.get(id);
    if (!workflow) throw new Error('未找到优化任务。');
    if (workflow.status !== 'WAITING_APPROVAL') throw new Error('当前任务不处于等待人工审阅的状态。');
    if (workflow.delivery_operation && workflow.delivery_operation.status !== 'COMPLETED') throw new Error('请先核对或撤回未完成的交付请求。');
    if (!workflow.enable_performance) throw new Error('正式性能优化批准需要已执行的性能测试；当前任务只验证了正确性。');
    const task = workflow.optimization_task_id ? this.store.getOptimizationTask(workflow.optimization_task_id) : null;
    if (!task?.evaluator) throw new Error('当前任务未绑定正式测试方案，不能准备批准或交付证据。');
    const candidate = workflow.candidate_id ? this.store.getCandidate(workflow.candidate_id) : null;
    const experiments = task ? this.store.listExperiments(task.task_id) : [];
    const verification = assessCandidateVerification({ workflow, task, candidate, experiments });
    if (!verification.ready || !task || !candidate || !verification.formal_experiment_id || !verification.revalidation_experiment_id) {
      throw new Error(`当前验证记录不足以批准：${verification.issues.map(issue => issue.message).join(' ')}`);
    }
    if (!workflow.testpack_snapshot_path) throw new Error('缺少任务冻结的测试方案，请核对原记录。');
    const frozen = readFrozenValidationTestpack(workflow.testpack_snapshot_path);
    if (workflow.testpack_digest && frozen.digest !== workflow.testpack_digest) throw new Error('冻结测试方案与任务身份不一致。');
    const evaluator = frozen.testpack.evaluator;
    if (!evaluator || evaluator.id !== task.evaluator.id || evaluator.version !== task.evaluator.version || evaluator.sha256 !== task.evaluator.digest) {
      throw new Error('测试方案缺少与任务匹配的正式 evaluator。');
    }
    return { workflow, task: { ...task, evaluator: task.evaluator }, candidate, verification, frozen, evaluatorRoot: evaluator.root };
  }

  prepare(id: string): WorkflowEvidenceSnapshot {
    const facts = this.current(id);
    const { workflow, task, candidate, verification, frozen, evaluatorRoot } = facts;
    const input = { taskId: task.task_id, candidateId: candidate.candidate_id,
      firstFormalExperimentId: verification.formal_experiment_id!, revalidationExperimentId: verification.revalidation_experiment_id!, evaluatorRoot };
    const existingApproval = this.store.getCandidateApproval(candidate.candidate_id);
    if (existingApproval && workflow.review_evidence?.artifact.evidence_id === existingApproval.evidence_artifact_identity.evidence_id) {
      if (existingApproval.first_formal_experiment_id !== verification.formal_experiment_id || existingApproval.revalidation_experiment_id !== verification.revalidation_experiment_id) {
        throw new Error('已有批准绑定其他实验，请核对历史并使用新的候选重新审阅。');
      }
      verifyFrozenEvidenceArtifact(workflow.review_evidence.artifact);
      return workflow.review_evidence;
    }
    const inspected = this.runtime.inspectCandidateApproval(input);
    requireCurrentApprovalStatistics(frozen.testpack, inspected.first, inspected.repeated);
    const firstMeasurements = this.store.listMeasurements(inspected.first.experiment_id);
    const repeatedMeasurements = this.store.listMeasurements(inspected.repeated.experiment_id);
    for (const [experiment, rows] of [[inspected.first, firstMeasurements], [inspected.repeated, repeatedMeasurements]] as const) {
      assertRawEvidenceComplete(experiment, rows, inspected.evaluatorBundle, frozen.testpack);
      assertPerformanceEvidenceConsistent(experiment, rows, frozen.testpack);
    }
    const previous = workflow.review_evidence;
    if (previous && previous.candidate_id === candidate.candidate_id && previous.candidate_commit === candidate.source.commit
      && previous.first_formal_experiment_id === inspected.first.experiment_id && previous.revalidation_experiment_id === inspected.repeated.experiment_id) {
      this.assertSnapshotMatches(previous, { task, candidate, first: inspected.first, repeated: inspected.repeated, frozen });
      return previous;
    }
    const frozenAt = new Date().toISOString();
    const evidence = { record_type: 'OPTIMIZATION_EVIDENCE_FREEZE', schema_version: 1, frozen_at: frozenAt,
      task_id: task.task_id, workflow_id: workflow.workflow_id, candidate_id: candidate.candidate_id,
      candidate_commit: candidate.source.commit, candidate_tree: candidate.source.tree, hypothesis_id: candidate.hypothesis_id,
      source_baseline: task.source_baseline, baseline: task.performance_baseline, evaluator: task.evaluator,
      machine_identity_sha256: inspected.machineDigest, first_formal_experiment_id: inspected.first.experiment_id,
      revalidation_experiment_id: inspected.repeated.experiment_id, acceptance_decision: { decision: 'PASS' },
      claim_scope: { target: task.target, resources: task.declared_context.resources ?? null,
        formal_correctness_coverage: inspected.first.evaluation?.correctness_coverage ?? null,
        revalidation_correctness_coverage: inspected.repeated.evaluation?.correctness_coverage ?? null } };
    const files = new Map<string, Buffer>([
      ['evidence.json', jsonBytes(evidence)], ['task.json', jsonBytes(task)], ['candidate.json', jsonBytes(candidate)],
      ['source/candidate.patch', candidatePatch(workflow, candidate)],
      ['hypothesis.json', jsonBytes(this.store.getHypothesis(candidate.hypothesis_id))],
      ['testpack.json', jsonBytes(frozen)], ['formal/experiment.json', jsonBytes(inspected.first)],
      ['formal/commands.json', jsonBytes(this.store.listCommandExecutions(inspected.first.experiment_id))],
      ['formal/measurements.json', jsonBytes(firstMeasurements)], ['revalidation/experiment.json', jsonBytes(inspected.repeated)],
      ['revalidation/commands.json', jsonBytes(this.store.listCommandExecutions(inspected.repeated.experiment_id))],
      ['revalidation/measurements.json', jsonBytes(repeatedMeasurements)],
      ['hypothesis-outcomes.json', jsonBytes(this.store.listHypothesisOutcomes(task.task_id).filter(item =>
        item.experiment_id === inspected.first.experiment_id || item.experiment_id === inspected.repeated.experiment_id))],
    ]);
    for (const relative of listFormalEvaluatorFiles(evaluatorRoot)) files.set(`evaluator/${relative}`, fs.readFileSync(path.join(evaluatorRoot, ...relative.split('/'))));
    const artifact = freezeEvidenceFiles(this.evidenceRoot, files);
    loadFormalEvaluatorBundle(path.join(path.dirname(artifact.manifest_path), 'evaluator'), {
      requireQualified: true, expected: { evaluatorId: task.evaluator.id, version: task.evaluator.version!, digest: task.evaluator.digest! },
    });
    const snapshot: WorkflowEvidenceSnapshot = { schema_version: 1, task_id: task.task_id, candidate_id: candidate.candidate_id,
      candidate_commit: candidate.source.commit, first_formal_experiment_id: inspected.first.experiment_id,
      revalidation_experiment_id: inspected.repeated.experiment_id, artifact, frozen_at: frozenAt };
    const latest = this.records.get(id);
    if (!latest || latest.candidate_id !== candidate.candidate_id || latest.status !== 'WAITING_APPROVAL') throw new Error('任务已变化，请刷新后重新审阅。');
    this.records.save({ ...latest, review_evidence: snapshot, ...(previous ? { review_evidence_history: [...(latest.review_evidence_history ?? []), previous] } : {}), updated_at: frozenAt });
    return snapshot;
  }

  evidence(id: string) {
    const workflow = this.records.get(id);
    if (!workflow?.review_evidence) throw new Error('尚未准备冻结证据。');
    return { snapshot: workflow.review_evidence, evidence: verifyFrozenEvidenceArtifact(workflow.review_evidence.artifact) };
  }

  approve(id: string, input: { expectedDigest: string; reviewer: string; authorizationReference: string }) {
    const facts = this.current(id);
    const snapshot = facts.workflow.review_evidence;
    if (!snapshot || snapshot.artifact.digest !== input.expectedDigest || snapshot.candidate_id !== facts.candidate.candidate_id
      || snapshot.candidate_commit !== facts.candidate.source.commit || snapshot.first_formal_experiment_id !== facts.verification.formal_experiment_id
      || snapshot.revalidation_experiment_id !== facts.verification.revalidation_experiment_id) throw new Error('冻结证据已变化，请重新准备并审阅。');
    const existingApproval = this.store.getCandidateApproval(facts.candidate.candidate_id);
    const first = this.runtime.getExperiment(snapshot.first_formal_experiment_id);
    const repeated = this.runtime.getExperiment(snapshot.revalidation_experiment_id);
    if (!existingApproval) requireCurrentApprovalStatistics(facts.frozen.testpack, first, repeated);
    this.assertSnapshotMatches(snapshot, { task: facts.task, candidate: existingApproval?.candidate_before ?? facts.candidate,
      first, repeated, frozen: facts.frozen });
    // The current qualification and the archived copy must both remain valid.
    const bundle = loadFormalEvaluatorBundle(facts.evaluatorRoot, { requireQualified: true,
      expected: { evaluatorId: facts.task.evaluator.id, version: facts.task.evaluator.version!, digest: facts.task.evaluator.digest! } });
    for (const experiment of [first, repeated]) {
      const rows = this.store.listMeasurements(experiment.experiment_id);
      assertRawEvidenceComplete(experiment, rows, bundle, facts.frozen.testpack);
      assertPerformanceEvidenceConsistent(experiment, rows, facts.frozen.testpack);
    }
    const approval = this.runtime.approveCandidate({ taskId: facts.task.task_id, candidateId: facts.candidate.candidate_id,
      firstFormalExperimentId: snapshot.first_formal_experiment_id, revalidationExperimentId: snapshot.revalidation_experiment_id,
      evaluatorRoot: path.join(path.dirname(snapshot.artifact.manifest_path), 'evaluator'), evidence: snapshot.artifact,
      reviewer: input.reviewer, authorization: { kind: 'EXPLICIT_OWNER_DIRECTIVE', reference: input.authorizationReference } });
    // The report reads domain approval records; update the workflow projection so
    // connected clients know to reload the report. Retrying after a write error is idempotent.
    const latest = this.records.get(id);
    if (latest) this.records.save({ ...latest, updated_at: new Date(Math.max(Date.now(), Date.parse(latest.updated_at) + 1)).toISOString() });
    return approval;
  }

  assertDeliveryAuthorized(workflow: OptimizationWorkflowRecord, verification: CandidateVerificationSummary) {
    const approval = workflow.candidate_id ? this.store.getCandidateApproval(workflow.candidate_id) : null;
    if (!approval) throw new Error('请先准备冻结证据，并由人工明确批准当前候选。');
    if (!verification.ready || approval.task_id !== workflow.optimization_task_id || approval.workflow_id !== workflow.workflow_id
      || approval.candidate_commit !== workflow.candidate_commit || approval.candidate_before.source.tree !== workflow.candidate_tree
      || approval.first_formal_experiment_id !== verification.formal_experiment_id || approval.revalidation_experiment_id !== verification.revalidation_experiment_id) {
      throw new Error('批准记录与当前候选或最新验证不一致，请重新审阅。');
    }
    const evidence = verifyFrozenEvidenceArtifact(approval.evidence_artifact_identity);
    if (evidence.candidate_id !== approval.candidate_id || evidence.candidate_commit !== approval.candidate_commit
      || evidence.first_formal_experiment_id !== approval.first_formal_experiment_id || evidence.revalidation_experiment_id !== approval.revalidation_experiment_id) {
      throw new Error('批准记录与冻结证据不一致，请核对原记录。');
    }
    if (!workflow.testpack_snapshot_path) throw new Error('缺少任务冻结的测试方案，请核对原记录。');
    const testpack = readFrozenValidationTestpack(workflow.testpack_snapshot_path);
    if (workflow.testpack_digest && testpack.digest !== workflow.testpack_digest) throw new Error('冻结测试方案与任务身份不一致。');
    if (!testpack.testpack.evaluator) throw new Error('缺少正式 evaluator，无法核对交付。');
    const task = this.store.getOptimizationTask(approval.task_id);
    const first = this.store.getExperiment(approval.first_formal_experiment_id);
    const repeated = this.store.getExperiment(approval.revalidation_experiment_id);
    if (!task || !first || !repeated || !workflow.review_evidence || workflow.review_evidence.artifact.evidence_id !== approval.evidence_artifact_identity.evidence_id) {
      throw new Error('缺少批准记录关联的冻结证据，请核对原记录。');
    }
    this.assertSnapshotMatches(workflow.review_evidence, { task, candidate: approval.candidate_before, first, repeated, frozen: testpack });
    const bundle = loadFormalEvaluatorBundle(testpack.testpack.evaluator.root, { requireQualified: true,
      expected: { evaluatorId: approval.evaluator_identity.id, version: approval.evaluator_identity.version!, digest: approval.evaluator_digest } });
    for (const experiment of [first, repeated]) {
      const rows = this.store.listMeasurements(experiment.experiment_id);
      assertRawEvidenceComplete(experiment, rows, bundle, testpack.testpack);
      assertPerformanceEvidenceConsistent(experiment, rows, testpack.testpack);
    }
    return approval;
  }
}
