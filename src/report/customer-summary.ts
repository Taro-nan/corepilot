import type { OptimizationReport } from '../contracts/optimization-report.js';
import type { CustomerOptimizationSummary } from '../contracts/customer-report.js';
import type { PerformanceStatistics } from '../contracts/performance-statistics.js';
import type { ValidationQualityPlan } from '../contracts/validation-quality.js';
import { assessCandidateVerification } from '../core/candidate-verification.js';

function gate(record?: OptimizationReport['experiments'][number]) {
  return record?.experiment.evaluation?.details?.performance_gate as { weighted_geomean?: number; statistics?: PerformanceStatistics;
    workloads?: Array<{ case_id: string; speedup: number; regression: boolean }> } | null | undefined;
}
/** Customer explanations are derived once from persisted facts for Web, CLI and Markdown. */
export function customerSummary(report: OptimizationReport): CustomerOptimizationSummary {
  const workflow = report.workflow, candidateId = workflow.candidate_id ?? report.candidates.at(-1)?.candidate.candidate_id ?? null;
  const rows = report.experiments.filter(row => row.experiment.candidate_id === candidateId);
  const candidate = report.candidates.find(row => row.candidate.candidate_id === candidateId)?.candidate;
  const verification = assessCandidateVerification({ workflow, task: report.task, candidate: candidate ?? null, experiments: rows.map(row => row.experiment) });
  const formal = rows.find(row => row.experiment.experiment_id === verification.formal_experiment_id);
  const revalidation = rows.find(row => row.experiment.experiment_id === verification.revalidation_experiment_id);
  const approval = report.candidates.find(row => row.candidate.candidate_id === candidateId)?.approval;
  const approvedCurrent = !!approval && verification.ready && approval.candidate_commit === candidate?.source.commit
    && approval.first_formal_experiment_id === verification.formal_experiment_id && approval.revalidation_experiment_id === verification.revalidation_experiment_id;
  const analysis = gate(formal), reanalysis = gate(revalidation);
  const deliveryMatches = !!workflow.delivery && workflow.delivery.candidate_id === candidateId && workflow.delivery.tree === candidate?.source.tree;
  const scope = report.task?.declared_context.correctness_scope as { cases?: Array<{ case_id: string; execution?: { input_id: string } }>; quality?: ValidationQualityPlan; quality_result?: CustomerOptimizationSummary['quality']; reference?: unknown; tolerance?: unknown } | undefined;
  const inputs = scope?.cases?.map(row => row.execution?.input_id ?? row.case_id);
  const coverage = formal?.experiment.evaluation?.correctness_coverage;
  const quality = scope?.quality;
  const inventory = report.task?.declared_context.workload_inventory as Array<{ workload_id: string; threads: number; parameters: Record<string, unknown>; weight: number; execution?: { input_id: string; profile_id: string } }> | undefined;
  const workloadData = formal?.experiment.evaluation?.performance_workloads ?? [];
  const groups = new Map<string, { dimension: string; value: string; sum: number; weight: number; worst: number; count: number }>();
  for (const row of workloadData) {
    const spec = inventory?.find(item => item.workload_id === row.workload_id);
    if (!spec) continue;
    for (const [dimension, value] of Object.entries({ ...spec.parameters, threads: spec.threads, ...(spec.execution ? { binding_profile: spec.execution.profile_id } : {}) })) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      const key = JSON.stringify([dimension, value]), weight = spec.weight > 0 ? spec.weight : 0;
      if (!weight || !Number.isFinite(row.speedup) || row.speedup <= 0) continue;
      const group = groups.get(key) ?? { dimension, value: String(value), sum: 0, weight: 0, worst: Infinity, count: 0 };
      group.sum += Math.log(row.speedup) * weight; group.weight += weight; group.worst = Math.min(group.worst, row.speedup); group.count++; groups.set(key, group);
    }
  }
  const limits = workflow.verification_mode === 'source_only' ? [
    '本任务仅生成源码补丁，构建、正确性和性能均为 NOT_EXECUTED；尚无可声明的性能收益或退化结论。',
    '候选源码身份和调查依据已保存，可通过独立测试任务验证；当前结果不能用于正式批准或交付。',
  ] : [
    '结论仅覆盖本次函数、冻结源码、比较基线、输入与资源条件；当前候选不代表全库收益或已找到最优实现。',
    analysis?.statistics ? `统计方法 ${analysis.statistics.policy.method}，置信水平 ${analysis.statistics.policy.confidence_level}；区间依赖固定采样与分块假设。`
      : '本轮沿用历史点估计口径，未计算真实置信区间。',
    ...(inputs ? [] : ['历史记录没有独立的逻辑输入清单，不能把执行次数视为语义覆盖。']),
    ...(quality?.probes.length ? ['测试辨别力仅针对声明的错误实现；未覆盖的错误仍可能存在。'] : ['本版未记录已知错误实现检验；测试通过不等于已验证测试辨别力。']),
    ...((quality?.coverage ?? []).filter(row => row.status === 'UNKNOWN').map(row => `待确认覆盖：${row.dimension}`)),
    '分组指标是已有负载的描述性点估计，分组之间可能重叠，不构成额外统计验收。',
  ];
  const state: CustomerOptimizationSummary['state'] = ['CREATED', 'GENERATING'].includes(workflow.status) ? 'RUNNING'
    : workflow.verification_mode === 'source_only' && workflow.status === 'CANDIDATE_READY' ? 'CANDIDATE_READY'
    : workflow.delivery_operation && workflow.delivery_operation.status !== 'COMPLETED' ? 'DELIVERY_PENDING'
    : verification.ready && workflow.status === 'DELIVERABLE' ? deliveryMatches ? 'DELIVERED' : 'DELIVERY_UNVERIFIED'
      : verification.ready && workflow.status === 'WAITING_APPROVAL' ? approvedCurrent ? 'READY_FOR_DELIVERY' : 'READY_FOR_REVIEW'
        : ['VALIDATION_BLOCKED', 'BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(workflow.status) ? 'BLOCKED' : 'NO_VERIFIED_RESULT';
  const command = (action: string) => `corepilot workflow ${action} ${workflow.workflow_id}`;
  let next: CustomerOptimizationSummary['next_step'] = { kind: 'INSPECT', message: '查看失败阶段、原始输入和命令记录，再决定修复或新建任务。', command: command('report') };
  if (state === 'RUNNING') next = { kind: 'WAIT', message: '任务在后台执行，可关闭观察页面后继续查看。', command: command('status') };
  else if (state === 'CANDIDATE_READY') next = { kind: 'TEST', message: '查看候选补丁，创建独立测试任务验证正确性与性能；当前补丁尚未验证。', command: null };
  else if (state === 'DELIVERY_PENDING') next = { kind: 'INSPECT', message: workflow.delivery_operation?.message ?? '核对原交付状态，避免重复提交。', command: command('delivery-check') };
  else if (state === 'READY_FOR_DELIVERY') next = { kind: 'REVIEW', message: '当前候选已获人工批准，可单独确认源码交付。', command: null };
  else if (state === 'READY_FOR_REVIEW') next = { kind: 'REVIEW', message: approval ? '已有批准绑定其他实验，请核对历史并使用新的候选重新审阅。' : '审阅源码差异、适用范围和独立复验，准备冻结证据并作出人工批准。', command: null };
  else if (state === 'DELIVERED') next = { kind: 'REPRODUCE', message: '源码交付已记录，可从冻结提交在 Runner 的新目录重建复现。', command: command('reproduce') };
  else if (state === 'DELIVERY_UNVERIFIED') next = { kind: 'INSPECT', message: '核对原交付提交与当前候选的源码身份。历史记录已标记交付，不应再次批准或重复合并。', command: command('report') };
  else if (['BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(workflow.status)) next = { kind: 'RESUME', message: '原会话与工作区已保留，可恢复调查；先核对已有 Runner 作业。', command: command('resume') };
  else if (workflow.status === 'VALIDATION_BLOCKED') next = { kind: 'RETRY_VALIDATION', message: (reanalysis ?? analysis)?.statistics?.verdict === 'INCONCLUSIVE'
    ? '当前测量证据不足，候选已保留。先检查噪声；采样条件需要改变时建立新版本，不反复试到通过。'
    : '候选已保留。按具体故障修正测试或执行环境，再重新验证原候选；不需要模型修改算法解决系统故障。', command: command('retry-validation') };
  return { schema_version: 1, state, verification, conclusion: state === 'CANDIDATE_READY' ? '候选补丁已准备；构建、正确性与性能尚未测试。'
    : state === 'DELIVERED' ? '当前候选已通过正式实验与独立复验，并记录源码交付。'
    : state === 'DELIVERY_PENDING' ? '交付请求已记录，结果以 Git 身份核对为准。'
    : state === 'DELIVERY_UNVERIFIED' ? '历史记录标记为已交付，但缺少与当前候选匹配的交付身份，需要核对原记录。'
    : state === 'READY_FOR_DELIVERY' ? '当前候选已通过验证并记录人工批准，源码尚未交付。'
    : state === 'READY_FOR_REVIEW' ? '当前候选已通过正式实验与独立复验，可进入人工审阅。'
      : state === 'RUNNING' ? '任务仍在执行，当前报告为进度快照。' : '尚无满足完整验证条件的当前交付建议；已有证据与候选均保留。',
    candidate_id: candidateId, source_commit: candidate?.source.commit ?? null, formal_experiment_id: formal?.experiment.experiment_id ?? null,
    revalidation_experiment_id: revalidation?.experiment.experiment_id ?? null, formal_speedup: analysis?.weighted_geomean ?? null,
    revalidation_speedup: reanalysis?.weighted_geomean ?? null, overall_interval: analysis?.statistics?.overall_interval ?? null,
    logical_inputs: inputs ? new Set(inputs).size : null, correctness_executions: coverage?.planned ?? 0,
    quality: scope?.quality_result ?? (quality ? { logical_inputs: inputs ? new Set(inputs).size : 0, correctness_executions: coverage?.planned ?? 0,
      coverage: quality.coverage, status: quality.probes.length ? 'PENDING' : 'NOT_CONFIGURED', probes: [], unknown_dimensions: quality.coverage.filter(row => row.status === 'UNKNOWN').map(row => row.dimension) } : null),
    regressions: workloadData.filter(row => row.regression).map(row => row.workload_id),
    groups: [...groups.values()].map(row => ({ dimension: row.dimension, value: row.value, workloads: row.count, weighted_speedup: Math.exp(row.sum / row.weight), worst_speedup: row.worst })), limits, next_step: next,
    resource_wait_ms: rows.reduce((sum, row) => sum + Number((row.experiment.observed_context?.runner_queue as { wait_ms?: number } | undefined)?.wait_ms ?? 0), 0) };
}
