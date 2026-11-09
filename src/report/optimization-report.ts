import type { OptimizationReport } from '../contracts/optimization-report.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { OptimizationStore } from '../storage/optimization-store.js';
import { customerSummary } from './customer-summary.js';

/** Defense against accidentally exporting common credential forms in command diagnostics. */
export function redactReportText(text: string): string {
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,"'}]+/gi, '$1[redacted]');
}

export function redactRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => {
    if (/^(api_key|token|password|secret|authorization_header)$/i.test(key)) return '[redacted]';
    return typeof item === 'string' ? redactReportText(item) : item;
  })) as T;
}

export function buildOptimizationReport(workflow: OptimizationWorkflowRecord, store: OptimizationStore): OptimizationReport {
  const taskId = workflow.optimization_task_id;
  const task = taskId ? store.getOptimizationTask(taskId) : null;
  const candidates = taskId ? store.listCandidates(taskId) : [];
  const experiments = taskId ? store.listExperiments(taskId) : [];
  const report: OptimizationReport = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    workflow,
    task,
    hypotheses: taskId ? store.listHypotheses(taskId) : [],
    outcomes: taskId ? store.listHypothesisOutcomes(taskId) : [],
    candidates: candidates.map(candidate => ({ candidate, approval: store.getCandidateApproval(candidate.candidate_id) })),
    experiments: experiments.map(experiment => ({
      experiment, commands: store.listCommandExecutions(experiment.experiment_id), measurements: store.listMeasurements(experiment.experiment_id),
    })),
    notices: [
      ...(workflow.status === 'NO_CANDIDATE' ? ['本次调查没有提交候选，尚未形成正式优化性能结论。'] : []),
      ...(workflow.status === 'VALIDATION_BLOCKED' ? [workflow.candidate_evaluation_feedback?.performance_summary.status === 'INCONCLUSIVE'
        ? '测量证据不足，候选已保留。先检查噪声与固定采样条件；改变测试口径需新版本，不重复试到通过。'
        : '验证未形成完整结论；候选与失败实验已保留，请按具体失败归属修复后重新验证。'] : []),
      ...(workflow.stop_reason ? [`本次结束原因：${workflow.stop_reason}`] : []),
      '报告是持久化实验事实的快照；生成报告不等于冻结 Evidence、Human Approval 或源码合并。',
      'Development 仅供诊断；SUCCEEDED 仅表示执行状态，正确性、性能与有效性分别列出。',
      '统计口径按各实验保存的方法版本解释；历史点估计不会重新包装成置信区间。',
      ...(!task ? ['此历史工作流没有关联的优化领域记录，报告只展示现存摘要。'] : []),
      ...(['CREATED', 'GENERATING'].includes(workflow.status) ? ['任务仍在运行，报告可能尚未包含完整测试结果。'] : []),
    ],
  };
  return redactRecord({ ...report, summary: customerSummary(report) });
}

function cell(value: unknown): string {
  return String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function code(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  const longestFence = Array.from(text.matchAll(/`+/g)).reduce((max, match) => Math.max(max, match[0].length + 1), 3);
  const fence = '`'.repeat(longestFence);
  return `${fence}text\n${text}\n${fence}`;
}

function table(headers: string[], rows: unknown[][]): string[] {
  return ['', `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.map(cell).join(' | ')} |`), ''];
}

/** Render only stored evaluations; never infer PASS from exit code or a ratio. */
export function renderOptimizationReport(report: OptimizationReport): string {
  const w = report.workflow;
  const summary = report.summary ?? customerSummary(report);
  const lines = ['# CorePilot 优化测试报告', '', `生成时间：${cell(report.generated_at)}`, '',
    '## 交付建议', '', summary.conclusion, '',
    ...(summary.verification.issues.length ? ['当前验证记录需核对：', ...summary.verification.issues.map(issue => `- ${issue.message}`), ''] : []),
    ...table(['项目', '当前依据'], [
      ['候选 / 冻结源码', `${summary.candidate_id ?? '无'} / ${summary.source_commit ?? '无'}`],
      ['首轮 / 独立复验加速比', `${summary.formal_speedup ?? '未知'} / ${summary.revalidation_speedup ?? '未知'}`],
      ['总体统计区间', summary.overall_interval ? `${summary.overall_interval.lower} .. ${summary.overall_interval.upper}` : '未计算或证据不足'],
      ['正确性逻辑输入 / 条件展开', `${summary.logical_inputs ?? '未知'} / ${summary.correctness_executions}`],
      ['已发现退化', summary.regressions.join(', ') || '见逐负载记录；未测量不能视为没有退化'],
      ['资源排队时间', `${summary.resource_wait_ms} ms`],
      ['下一步', summary.next_step.message], ['可用命令', summary.next_step.command],
      ['源码交付记录', w.delivery ? `${w.delivery.commit} / ${w.delivery.approved_at}` : '未记录交付回执'],
      ['重建复现', w.reproduction ? `${w.reproduction.status} / ${w.reproduction.experiment_id}` : '尚未执行'],
    ]), ...summary.limits.map(limit => `- ${limit}`), '',
    '## 按输入与资源分组（描述性点估计）',
    ...table(['维度', '值', '负载数', '组内固定权重加速比', '最慢负载加速比'], summary.groups.map(row => [row.dimension, row.value, row.workloads, row.weighted_speedup, row.worst_speedup])),
    ...table(['项目', '记录'], [
      ['函数', w.function_name], ['工作流', w.workflow_id], ['任务', report.task?.task_id], ['状态', w.status],
      ['当前阶段', w.progress?.phase], ['进度', w.progress?.last_event], ['错误', w.error],
      ['创建 / 更新', `${w.created_at} / ${w.updated_at}`], ['性能优化', w.enable_performance ? '启用' : '未启用'],
        ['源码仓库', w.repository_root], ['源码分支', w.source_branch], ['源码基线 commit', w.baseline_commit], ['配置 SHA-256', w.config_file_sha256], ['测试配置摘要', w.testpack_digest],
        ...(w.execution_machine ? [['执行机器', w.execution_machine.name], ['执行机器 ID', w.execution_machine.machine_id], ['机器配置版本', String(w.execution_machine.revision)]] : []),
    ]),
    '## 结论与范围', '',
    ...report.notices.map(notice => `- ${notice}`), '',
    `领域批准记录：${report.candidates.filter(item => item.approval).length}；工作流交付状态：${cell(w.status)}。两者按各自记录展示。`, '',
    '## 实验总览',
    ...table(['实验', '候选', '用途', '执行', '有效性', '构建', '正确性', '性能', '失败类别'], report.experiments.map(({ experiment: e }) => [
      e.experiment_id, e.candidate_id, e.type, e.status, e.validity, e.evaluation?.build, e.evaluation?.correctness, e.evaluation?.performance, e.failure_category,
    ])),
  ];
  if (report.experiments.length === 0) lines.push('尚无实验记录。未执行测试不能视为通过。', '');
  lines.push('## 假设与候选', ...table(['假设', '状态', '描述', '预期收益'], report.hypotheses.map(h => [h.hypothesis_id, h.status, h.description, h.expected_effect])));
  for (const { candidate: c, approval } of report.candidates) {
    lines.push(`### 候选 ${c.sequence}：${cell(c.candidate_id)}`, '',
      `Hypothesis：${cell(c.hypothesis_id)}；父候选：${cell(c.parent_candidate_id)}`, '',
      `Commit：${cell(c.source.commit)}；Tree：${cell(c.source.tree)}；Archive SHA-256：${cell(c.source.archive_sha256)}`, '',
      `批准：${approval ? `${cell(approval.reviewer)} / ${cell(approval.approved_at)}` : '无领域批准记录'}`, '',
      ...table(['文件', '修改前 SHA-256', '修改后 SHA-256'], c.source.changed_files.map(f => [f.path, f.before_sha256, f.after_sha256])),
      'Agent：', '', code(c.agent_identity), '');
    if (c.development_findings) lines.push('开发调查（不作为 Formal Evidence）：', '', code(c.development_findings), '');
  }
  for (const { experiment: e, commands, measurements } of report.experiments) {
    const gate = e.evaluation?.details?.performance_gate as Record<string, unknown> | undefined;
    lines.push(`## 实验详情：${cell(e.experiment_id)}`, '',
      `用途：${cell(e.type)}；执行：${cell(e.status)}；有效性：${cell(e.validity)}；失败类别：${cell(e.failure_category)}`, '',
      '### 身份、资源与环境', '', code({ evaluator: e.evaluator, baseline: e.baseline, declared: e.declared_context, observed: e.observed_context }), '',
      '### 正确性', '', code(e.evaluation?.correctness_coverage ?? { note: '没有逐用例 coverage 记录' }), '',
      ...table(['Case', '结果', '有效性', '领域参数 / 诊断'], measurements.filter(m => m.kind === 'CORRECTNESS_CASE').map(m => [m.subject_id, m.value, m.validity, JSON.stringify(m.domain_payload)])),
      '### 性能（耗时单位以样本记录为准）',
      ...table(['指标', '保存值'], [
        ['Acceptance', e.evaluation?.performance], ['Weighted geomean', gate?.weighted_geomean],
        ['Overall gate lower（按方法版本）', gate?.overall_ci_lower], ['Key-case gate lower（按方法版本）', gate?.key_case_ci_lower === null ? '不适用或区间未计算（见统计记录）' : gate?.key_case_ci_lower],
      ]),
      ...table(['Workload', 'Baseline 中位数', 'Candidate 中位数', '加速比', '关键用例', '退化', 'Baseline 样本数', 'Candidate 样本数'],
        (e.evaluation?.performance_workloads ?? []).map(p => [p.workload_id, p.baseline_median, p.candidate_median, Number.isFinite(p.speedup) ? `${p.speedup.toFixed(4)}×` : '无有效值', p.critical, p.regression, p.baseline_samples.length, p.candidate_samples.length])),
      '评估详情（保存的 gate 结果，未重新计算）：', '', code(e.evaluation?.details ?? {}), '',
      '### 原始样本',
      ...table(['Workload', '角色', '样本序号', '值', '单位', '有效性'], measurements.filter(m => m.kind === 'PERFORMANCE_SAMPLE').map(m => [m.subject_id, m.role, m.sample_index, m.value, m.unit, m.validity])),
      '### 命令与日志',
      ...table(['序号', '步骤', '退出码', '耗时 ms', '超时', '取消'], commands.map(c => [c.sequence, c.step, c.exit_code, c.duration_ms, c.timed_out, c.cancelled])),
    );
    for (const c of commands) lines.push(`#### ${cell(c.step)} / ${cell(c.command_execution_id)}`, '',
      code({ command: c.command, args: c.args, cwd: c.cwd, resources: c.resource_context }), '', 'stdout:', '', code(c.stdout), '', 'stderr:', '', code(c.stderr), '');
  }
  lines.push('## 假设反馈历史', ...table(['实验', '假设', '结果', '原因'], report.outcomes.map(o => [o.experiment_id, o.hypothesis_id, o.status, o.reason])));
  if (report.task) lines.push('## 固定任务上下文', '', code({ source_baseline: report.task.source_baseline, performance_baseline: report.task.performance_baseline, evaluator: report.task.evaluator, declared_context: report.task.declared_context }), '');
  if (w.validation_result || w.performance_result || w.revalidation_result) lines.push('## 工作流摘要（与上面的领域事实分层展示）', '', code({ validation: w.validation_result, performance: w.performance_result, revalidation: w.revalidation_result }), '');
  return lines.join('\n') + '\n';
}
