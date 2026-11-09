import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiClientError, type ApiClient } from './api-client.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import { writeOptimizationReport } from '../report/write-report.js';
import { writeNewPrivateFile } from '../workspace/private-output.js';
import { verifyExperimentReviewBytes } from '../application/experiment-review-verification.js';

export const WORKFLOW_USAGE = 'workflow list | workflow status|watch|report|experiment-review|evidence|human-approve|deliver|reproduce|events|resume|retry-validation|message|cancel|delivery-check|delivery-resume|delivery-withdraw|delivery-cleanup <workflow-id> [--json]；历史未授权任务首次继续编辑：workflow resume <id> --allow <文件或目录/> [--exclude <路径>]';
export function isWorkflowFinished(record: OptimizationWorkflowRecord): boolean {
  return ['CANDIDATE_READY', 'WAITING_APPROVAL', 'PERFORMANCE_THRESHOLD_NOT_MET', 'NO_CANDIDATE', 'BUDGET_EXHAUSTED', 'INTERRUPTED', 'VALIDATION_BLOCKED', 'DELIVERABLE', 'FAILED', 'CANCELLED'].includes(record.status);
}

export function workflowStatusText(w: OptimizationWorkflowRecord): string {
  return [`工作流：${w.workflow_id}`, `函数：${w.function_name}`, `状态：${w.status}`, `阶段：${w.progress?.phase ?? '-'}`,
    ...(w.progress?.round === undefined ? [] : [`轮次：${w.progress.round}`]),
    ...(w.progress?.last_event ? [`进度：${w.progress.last_event}`] : []),
    ...(w.progress?.runner_experiment_id ? [`Runner：${w.progress.runner_experiment_id} · ${w.progress.runner_status} · ${w.progress.runner_step ?? '等待执行'}`] : []),
    ...(w.progress?.runner_queue ? [`资源：${w.progress.runner_queue.reason ?? '独占执行'}；等待 ${w.progress.runner_queue.wait_ms === null ? '尚未开始' : `${(w.progress.runner_queue.wait_ms / 1000).toFixed(1)} 秒`}${w.progress.runner_queue.position ? `；排队位置 ${w.progress.runner_queue.position}` : ''}`] : []),
    ...(w.error ? [`错误：${w.error}`] : []),
    ...(w.stop_reason ? [`结束原因：${w.stop_reason}`] : []),
    ...(w.agent_session ? [`会话：${w.agent_session.turns} 次模型轮次 · ${w.agent_session.tool_calls} 次工具调用 · ${w.agent_session.compactions} 次上下文整理`] : []),
    ...(w.verification_mode === 'source_only' && !w.source_scope_authorization ? [`历史任务未记录源码授权；继续时请指定 --allow <文件或目录/>。`] : []),
    ...(['BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(w.status) ? [`继续：corepilot workflow resume ${w.workflow_id}`] : []),
    ...(w.status === 'VALIDATION_BLOCKED' ? [`验证受阻，候选已保留。修复环境后重试：corepilot workflow retry-validation ${w.workflow_id}`] : []),
    ...(w.status === 'CANDIDATE_READY' ? ['代码候选已生成；正确性未验证，性能未测量。请创建独立测试任务验证此候选。'] : []),
    ...(w.report_files ? [`报告：${w.report_files.markdown}`] : []),
    ...(w.report_error ? [`自动报告导出失败：${w.report_error}；可使用 workflow report 重试。`] : []),
    ...(w.reproduction ? [`重建复现：${w.reproduction.status} · ${w.reproduction.phase} · ${w.reproduction.experiment_id}`, ...(w.reproduction.error ? [w.reproduction.error] : [])] : []),
    ...(w.delivery_operation ? [`源码交付：${w.delivery_operation.status} · ${w.delivery_operation.message}`,
      ...(w.delivery_operation.cleanup_message ? [w.delivery_operation.cleanup_message] : []),
      ...(w.delivery_operation.status !== 'COMPLETED' ? [`核对：corepilot workflow delivery-check ${w.workflow_id}`] : [])] : []),
  ].join('\n');
}

export interface WorkflowCommandResult { ok: boolean; message: string; data?: unknown }

/** Both terminal frontends use this API-only path; neither reads SQLite. */
export async function executeWorkflowCommand(api: ApiClient, args: string[], options: {
  print?: (text: string) => void;
  signal?: AbortSignal;
  reportRoot?: string;
} = {}): Promise<WorkflowCommandResult> {
  const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
    json: { type: 'boolean' }, limit: { type: 'string' }, output: { type: 'string' },
    experiment: { type: 'string' },
    interval: { type: 'string' }, timeout: { type: 'string' },
    'commit-message': { type: 'string' }, 'expected-baseline-commit': { type: 'string' },
    message: { type: 'string' }, 'budget-minutes': { type: 'string' }, 'max-candidates': { type: 'string' }, after: { type: 'string' },
    allow: { type: 'string', multiple: true }, exclude: { type: 'string', multiple: true },
    plan: { type: 'boolean' }, cancel: { type: 'boolean' }, 'confirm-stopped': { type: 'boolean' }, 'operation-id': { type: 'string' },
    prepare: { type: 'boolean' }, reviewer: { type: 'string' }, 'authorization-reference': { type: 'string' }, 'evidence-digest': { type: 'string' },
  } });
  const [action, id, ...extra] = parsed.positionals;
  const value = parsed.values;
  const allowed: Record<string, string[]> = {
    list: ['json', 'limit'], status: ['json'], watch: ['json', 'interval', 'timeout', 'output'],
    report: ['json', 'output'], 'experiment-review': ['json', 'output', 'experiment'], evidence: ['json', 'prepare', 'output'], 'human-approve': ['json', 'reviewer', 'authorization-reference', 'evidence-digest'],
    cancel: ['json'], 'retry-validation': ['json'], approve: ['json', 'commit-message', 'expected-baseline-commit'], deliver: ['json', 'commit-message', 'expected-baseline-commit'],
    reproduce: ['json', 'plan', 'cancel'],
    'delivery-check': ['json'], 'delivery-resume': ['json', 'confirm-stopped'], 'delivery-withdraw': ['json', 'confirm-stopped', 'operation-id'], 'delivery-cleanup': ['json'],
    resume: ['json', 'message', 'budget-minutes', 'max-candidates', 'allow', 'exclude'], message: ['json', 'message'], events: ['json', 'after', 'limit'],
  };
  if (!action || !allowed[action] || extra.length || (action === 'list' ? !!id : !id)) throw new Error(WORKFLOW_USAGE);
  for (const name of Object.keys(value)) if (!allowed[action].includes(name)) throw new Error(`${action} does not support --${name}`);
  if (value.output !== undefined && !value.output.trim()) throw new Error('--output requires a non-empty directory');
  const result = (data: unknown, message: string, ok = true): WorkflowCommandResult => ({ ok, message: value.json ? JSON.stringify(data, null, action === 'watch' ? 0 : 2) : message, data });
  if (action === 'list') {
    const limit = Number(value.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('--limit must be in 1..200');
    const data = await api.listOptimizationWorkflows(limit);
    return result(data, data.workflows.length ? data.workflows.map(w => `${w.workflow_id}  ${w.function_name}  ${w.status}  ${w.progress?.phase ?? '-'}  ${w.updated_at}`).join('\n') : '暂无优化工作流。使用 /optimize 或 corepilot optimize 启动。');
  }
  if (action === 'report') {
    const response = await api.getOptimizationReport(id);
    if (value.output) {
      const files = await writeOptimizationReport(value.output, response);
      return result({ files, report: response.report }, `已导出优化测试报告：\n${files.markdown}\n${files.json}`);
    }
    return result(response.report, response.markdown);
  }
  if (action === 'experiment-review') {
    if (!value.experiment?.trim() || !value.output?.trim()) throw new Error('experiment-review 需要 --experiment <实验 ID> 和 --output <新文件>。');
    const { review } = await api.getExperimentReview(id, value.experiment);
    const bytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`, 'utf8');
    try { verifyExperimentReviewBytes(bytes); }
    catch { throw new Error('服务端返回的单实验数值包包含不支持或无效的内容；未生成文件，请核对服务版本和原记录。'); }
    writeNewPrivateFile(value.output, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return result({ sha256, review: 'REVIEW_REQUIRED' }, `已生成待人工审阅的单实验数值包，SHA-256：${sha256}\n数值仍可能敏感；不证明来源、测试有效性、批准或交付。`);
  }
  if (action === 'evidence') {
    if (value.prepare && value.output) throw new Error('先准备证据，再使用 --output 下载已准备的证据。');
    const data = value.prepare ? await api.prepareWorkflowEvidence(id) : await api.getWorkflowEvidence(id);
    if (value.output) await writeFile(value.output, await api.downloadWorkflowEvidence(id), { flag: 'wx' });
    return result(data, value.output ? `证据已下载：${value.output}` : `冻结证据：${data.snapshot.artifact.digest}\n候选：${data.snapshot.candidate_id}\n正式实验：${data.snapshot.first_formal_experiment_id}\n复验：${data.snapshot.revalidation_experiment_id}\n该操作不批准或合并源码。`);
  }
  if (action === 'human-approve') {
    if (!value.reviewer?.trim() || !value['authorization-reference']?.trim() || !value['evidence-digest']?.trim()) throw new Error('human-approve 需要 --reviewer、--authorization-reference 和已审阅的 --evidence-digest');
    const data = await api.approveWorkflowEvidence(id, { reviewer: value.reviewer, authorization_reference: value['authorization-reference'], expected_evidence_digest: value['evidence-digest'] });
    return result(data, `已记录人工批准：${data.approval.approval_id}；源码尚未交付。`);
  }
  if (action === 'reproduce') {
    if (value.plan && value.cancel) throw new Error('reproduce --plan 与 --cancel 不能同时使用');
    if (value.cancel) return result(await api.cancelReproduction(id), '已请求停止复现；通过 workflow status 查看 Runner 确认结果。');
    const data = value.plan ? await api.getReproduction(id) : await api.reproduceWorkflow(id);
    return result(data, value.plan ? JSON.stringify(data, null, 2) : `已提交冻结候选的干净重建复现：${id}；不调用模型。使用 workflow status 或报告查看新实验，原审批和交付记录保留。`);
  }
  if (action === 'cancel') {
    const data = await api.cancelOptimizationWorkflow(id) as { ok?: boolean; status?: string; message?: string };
    return result(data, `${data.status ?? 'UNKNOWN'}：${data.message ?? ''}`, data.ok !== false);
  }
  if (action === 'retry-validation') {
    const data = await api.retryOptimizationValidation(id);
    return result(data, `已重新验证当前候选：${id}。创建新实验，保留原记录，本次不调用模型。使用 workflow watch 查看进展。`);
  }
  if (action === 'delivery-check' || action === 'delivery-cleanup') {
    const data = action === 'delivery-check' ? await api.reconcileWorkflowDelivery(id) : await api.cleanupWorkflowDelivery(id);
    const operation = data.workflow.delivery_operation;
    return result(data, operation ? `${operation.status}：${operation.message}${operation.cleanup_message ? '\n' + operation.cleanup_message : ''}` : '没有交付记录。');
  }
  if (action === 'delivery-resume') {
    const data = await api.resumeWorkflowDelivery(id, value['confirm-stopped'] === true);
    return result(data, `已核对并完成原交付：${data.commit}${data.cleanup_warning ? '\n' + data.cleanup_warning : ''}`);
  }
  if (action === 'delivery-withdraw') {
    const current = await api.getOptimizationWorkflow(id) as { workflow: OptimizationWorkflowRecord };
    const operationId = value['operation-id'] ?? current.workflow.delivery_operation?.operation_id ?? current.workflow.delivery_history?.at(-1)?.operation_id;
    if (!operationId) throw new Error('没有可撤回的交付请求。');
    const data = await api.withdrawWorkflowDelivery(id, operationId, value['confirm-stopped'] === true);
    return result(data, '已撤回未完成的交付请求，原记录已保留；现有 Git 提交未被回退。');
  }
  if (action === 'events') {
    const after = Number(value.after ?? 0); const limit = Number(value.limit ?? 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('after/limit must be valid event cursor and count');
    const data = await api.getOptimizationSessionEvents(id, after, limit);
    return result(data, data.events.map(event => `${event.timestamp}  ${event.tool_name ?? event.role ?? event.kind}\n${event.text}`).join('\n\n') || '尚无 Agent 过程记录。');
  }
  if (action === 'message') {
    if (!value.message?.trim()) throw new Error('message requires --message <补充要求>');
    const data = await api.sendOptimizationMessage(id, value.message);
    return result(data, '补充要求已送入当前 Agent 会话。');
  }
  if (action === 'resume') {
    const budget: Partial<import('../contracts/optimization-session.js').OptimizationSessionBudget> = {};
    if (value['budget-minutes'] !== undefined) {
      const minutes = Number(value['budget-minutes']);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new Error('--budget-minutes must be from 1 to 1440');
      budget.time_limit_ms = Math.round(minutes * 60_000);
    }
    if (value['max-candidates'] !== undefined) {
      const count = Number(value['max-candidates']);
      if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('--max-candidates must be from 1 to 1000');
      budget.max_candidates = count;
    }
    const data = await api.resumeOptimizationWorkflow(id, { ...(value.message ? { message: value.message } : {}), ...(Object.keys(budget).length ? { budget } : {}),
      ...(value.allow || value.exclude ? { candidate_scope: { include: value.allow ?? [], exclude: value.exclude ?? [] } } : {}) });
    return result(data, `已继续原优化会话：${id}。使用 workflow watch 查看进展。`);
  }
  if (action === 'approve' || action === 'deliver') {
    if (!value['commit-message']?.trim()) throw new Error('deliver requires --commit-message <说明>；请先完成证据审阅与人工批准。');
    const data = await api.requestWorkflowApprove(id, { commit_message: value['commit-message'],
      ...(value['expected-baseline-commit'] ? { expected_baseline_commit: value['expected-baseline-commit'] } : {}) }) as { commit?: string; cleanup_warning?: string };
    return result(data, `已按用户请求交付并合入：${data.commit ?? id}。${data.cleanup_warning ? '\n' + data.cleanup_warning : ''}`);
  }
  let executionAttached: boolean | undefined;
  const detachedMessage = '当前后台未接管此任务；记录已保留。请核对 Runner 的已有实验状态，再决定后续操作。系统不会自动重复启动实验。';
  const read = async () => {
    const data = await api.getOptimizationWorkflow(id, options.signal) as { workflow: OptimizationWorkflowRecord; execution_attached?: boolean };
    executionAttached = data.execution_attached;
    return data.workflow;
  };
  const detached = (w: OptimizationWorkflowRecord) => executionAttached === false && ['CREATED', 'GENERATING'].includes(w.status);
  if (action === 'status') { const w = await read(); return result({ workflow: w, ...(executionAttached === undefined ? {} : { execution_attached: executionAttached }) }, workflowStatusText(w) + (detached(w) ? '\n' + detachedMessage : '')); }
  const seconds = (raw: string | undefined, fallback: number, minimum: number): number => {
    const n = Number(raw ?? fallback);
    if (!Number.isFinite(n) || n < minimum || n > 86400) throw new Error('interval/timeout must be valid seconds in range');
    return n;
  };
  const interval = seconds(value.interval, 2, 0.1) * 1000;
  const timeout = seconds(value.timeout, 0, 0) * 1000;
  const started = Date.now();
  let previous = '';
  const observe = async <T>(operation: () => Promise<T>): Promise<{ state: 'read'; value: T } | { state: 'unavailable' } | { state: 'stopped' }> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (options.signal?.aborted) return { state: 'stopped' };
      if (attempt && timeout > 0 && Date.now() - started >= timeout) return { state: 'unavailable' };
      try {
        const observed = await operation();
        if (attempt) options.print?.(value.json ? JSON.stringify({ event: 'connection_restored', workflow_id: id }) : '连接已恢复，继续读取原任务。');
        return { state: 'read', value: observed };
      } catch (error) {
        if (options.signal?.aborted) return { state: 'stopped' };
        if (!(error instanceof ApiClientError) || error.code !== 'CONNECTION_FAILED' || error.status !== null) throw error;
        if (attempt === 2 || timeout > 0 && Date.now() - started >= timeout) return { state: 'unavailable' };
        options.print?.(value.json ? JSON.stringify({ event: 'connection_interrupted', workflow_id: id, retry: attempt + 1 })
          : '连接暂时中断，正在按原任务 ID 重新读取；当前状态尚未确认。');
        const pause = timeout > 0 ? Math.min(interval, Math.max(0, timeout - (Date.now() - started))) : interval;
        try { await delay(pause, undefined, { signal: options.signal }); }
        catch (waitError) { if (options.signal?.aborted) return { state: 'stopped' }; throw waitError; }
      }
    }
    return { state: 'unavailable' };
  };
  while (!options.signal?.aborted) {
    const observed = await observe(read);
    if (observed.state === 'stopped') break;
    if (observed.state === 'unavailable') return result({ workflow_id: id, watching: false, observation: 'UNKNOWN' },
      `无法连接并读取原任务 ${id}；当前状态未知。请检查控制端连接后重新使用 workflow watch，不会重复启动任务。`, false);
    const w = observed.value;
    const fingerprint = JSON.stringify([w.status, w.progress, w.error]);
    if (fingerprint !== previous) {
      options.print?.(value.json ? JSON.stringify({ workflow: w }) : workflowStatusText(w));
      previous = fingerprint;
    }
    if (detached(w)) return result({ workflow: w, execution_attached: false }, w.agent_session ? `原会话已保留。使用 corepilot workflow resume ${id} 继续。` : detachedMessage, false);
    if (isWorkflowFinished(w)) {
      const report = await observe(() => api.getOptimizationReport(id));
      if (report.state === 'stopped') break;
      if (report.state === 'unavailable') return result({ workflow: w, watching: false, observation: 'REPORT_UNAVAILABLE' },
        `无法连接并读取原任务 ${id} 的报告；上次查询到的任务状态已保留。请检查连接后使用 workflow report 重试。`, false);
      const response = report.value;
      const root = value.output ?? path.join(options.reportRoot ?? path.resolve('.corepilot', 'reports'), id.replace(/^workflow:/, '').replace(/[^a-zA-Z0-9._-]/g, '_'));
      const files = await writeOptimizationReport(root, response);
      return result({ workflow: w, files }, `观察结束：${w.status}\n报告：${files.markdown}\n原始记录：${files.json}\n${w.status === 'WAITING_APPROVAL' ? '测试已完成，等待人工审阅；报告生成不会自动批准或合并源码。' : w.status === 'VALIDATION_BLOCKED' ? `验证受阻。修复环境后使用 corepilot workflow retry-validation ${id} 重新验证当前候选。` : ['BUDGET_EXHAUSTED', 'INTERRUPTED'].includes(w.status) ? `现场已保留。使用 corepilot workflow resume ${id} 继续。` : '报告保留已完成和失败的实验事实。'}`, !['FAILED', 'CANCELLED', 'PERFORMANCE_THRESHOLD_NOT_MET', 'BUDGET_EXHAUSTED', 'INTERRUPTED', 'VALIDATION_BLOCKED'].includes(w.status));
    }
    if (timeout > 0 && Date.now() - started >= timeout) return result({ workflow: w, watching: false }, '观察已超时，后台优化继续运行。', false);
    try { await delay(interval, undefined, { signal: options.signal }); }
    catch (error) { if (!options.signal?.aborted) throw error; }
  }
  return { ok: true, message: '已停止观察；后台优化继续运行。使用 workflow cancel 显式取消任务。' };
}
