import type { Candidate, DomainIdentity, Experiment, OptimizationTask } from '../contracts/optimization-domain.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { CandidateVerificationIssue, CandidateVerificationSummary } from '../contracts/candidate-verification.js';

function sameIdentity(expected: DomainIdentity | null | undefined, actual: DomainIdentity | undefined): boolean {
  return !!expected?.id && !!expected.digest && !!actual?.id && !!actual.digest
    && expected.id === actual.id && expected.version === actual.version && expected.digest === actual.digest;
}

function validExperiment(experiment: Experiment, performance: boolean): boolean {
  const evaluation = experiment.evaluation;
  const coverage = evaluation?.correctness_coverage;
  const resource = experiment.observed_context?.resource_policy as { validity?: unknown } | undefined;
  return experiment.status === 'SUCCEEDED' && experiment.validity === 'VALID' && experiment.failure_category === null
    && resource?.validity === 'VALID' && evaluation?.build === 'PASSED' && evaluation.correctness === 'PASSED'
    && !!coverage && Number.isSafeInteger(coverage.planned) && coverage.planned > 0
    && coverage.complete === true && coverage.executed === coverage.planned && coverage.passed === coverage.planned && coverage.failed === 0
    && (!performance || evaluation.performance === 'PASSED');
}

/**
 * Assess the current candidate from stored facts in creation order. This does
 * not freeze Evidence or grant approval; the public delivery path performs its
 * own status, human intent and Git checks as well.
 */
export function assessCandidateVerification(input: {
  workflow: OptimizationWorkflowRecord;
  task: OptimizationTask | null;
  candidate: Candidate | null;
  experiments: readonly Experiment[];
}): CandidateVerificationSummary {
  const { workflow, task, candidate } = input;
  if (workflow.verification_mode === 'source_only') return {
    ready: false, formal_experiment_id: null, revalidation_experiment_id: null,
    issues: [{ code: 'VERIFICATION_NOT_REQUESTED', message: '本任务仅生成源码候选，未执行构建、正确性和性能测试，不能批准或交付。' }],
  };
  const issues: CandidateVerificationIssue[] = [];
  const add = (code: CandidateVerificationIssue['code'], message: string) => issues.push({ code, message });
  if (!task || task.task_id !== workflow.optimization_task_id || task.workflow_id !== workflow.workflow_id) {
    add('TASK_MISSING', '缺少与工作流匹配的优化任务记录，请核对历史记录。');
  }
  if (!candidate || !workflow.candidate_id || candidate.candidate_id !== workflow.candidate_id || candidate.task_id !== task?.task_id) {
    add('CANDIDATE_MISSING', '缺少与当前任务匹配的候选记录，请核对候选身份。');
  } else if (!workflow.candidate_commit || !workflow.candidate_tree || !workflow.baseline_commit
    || candidate.source.commit !== workflow.candidate_commit || candidate.source.tree !== workflow.candidate_tree
    || task?.source_baseline?.digest !== workflow.baseline_commit) {
    add('SOURCE_IDENTITY_MISMATCH', '当前工作流与候选或源码基线的冻结身份不一致，请核对提交和源码树。');
  }
  if (candidate?.status === 'REJECTED') add('CANDIDATE_REJECTED', '当前候选已被拒绝，请查看原因并重新验证可用候选。');
  const rows = input.experiments.filter(item => item.candidate_id === workflow.candidate_id && item.task_id === task?.task_id);
  const formalIndex = rows.map(item => item.type).lastIndexOf('FORMAL_EVALUATION');
  const formal = rows[formalIndex];
  const revalidation = rows.slice(formalIndex + 1).filter(item => item.type === 'REVALIDATION').at(-1);
  if (!formal) add('FORMAL_MISSING', '尚无当前候选的正式实验，请先完成正式验证。');
  else if (!validExperiment(formal, workflow.enable_performance)) add('FORMAL_INVALID', '最近一次正式实验未形成完整有效的通过结论，请查看实验记录。');
  if (!revalidation) add('REVALIDATION_MISSING', '最近一次正式实验后没有独立复验，请先完成复验。');
  else if (revalidation.experiment_id === formal?.experiment_id || !validExperiment(revalidation, workflow.enable_performance)) add('REVALIDATION_INVALID', '最近一次独立复验未形成完整有效的通过结论，请查看复验记录。');
  if (formal && revalidation) {
    if (!sameIdentity(task?.evaluator, formal.evaluator) || !sameIdentity(task?.evaluator, revalidation.evaluator)) {
      add('EVALUATOR_MISMATCH', '正式实验、复验与任务的测试方案身份不一致或未记录完整。');
    }
    const baseline = task?.performance_baseline ?? task?.source_baseline;
    if (!sameIdentity(baseline, formal.baseline) || !sameIdentity(baseline, revalidation.baseline)) {
      add('BASELINE_MISMATCH', '正式实验、复验与任务的比较基线身份不一致或未记录完整。');
    }
    const first = (formal.observed_context?.machine as { machine_identity_sha256?: unknown } | undefined)?.machine_identity_sha256;
    const second = (revalidation.observed_context?.machine as { machine_identity_sha256?: unknown } | undefined)?.machine_identity_sha256;
    if (typeof first !== 'string' || !/^[0-9a-f]{64}$/.test(first) || first !== second) {
      add('MACHINE_MISMATCH', '正式实验与复验缺少一致的机器身份，请核对执行环境。');
    }
  }
  if (workflow.reproduction && (workflow.reproduction.status !== 'SUCCEEDED' || workflow.reproduction.passed === false)) {
    add('REPRODUCTION_INCOMPLETE', '最近一次重建复现尚未通过，请先核对复现记录。');
  }
  return { ready: issues.length === 0, formal_experiment_id: formal?.experiment_id ?? null,
    revalidation_experiment_id: revalidation?.experiment_id ?? null, issues };
}
