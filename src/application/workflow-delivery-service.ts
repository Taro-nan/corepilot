import { randomUUID } from 'node:crypto';
import type { CandidateVerificationSummary } from '../contracts/candidate-verification.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';
import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowStore } from '../workflow/optimization-workflow.js';
import { assessCandidateVerification } from '../core/candidate-verification.js';
import { applyCandidateDelivery, cleanupDeliveryWorkspaces, inspectCandidateDelivery, prepareCandidateDelivery, resolveDeliveryTarget } from '../workspace/delivery-git.js';
import type { WorkflowApprovalService } from './workflow-approval-service.js';

export type DeliveryResult = { ok: true; commit: string; tree: string; cleanup_warning?: string }
  | { ok: false; message: string; verification?: CandidateVerificationSummary };

/** Durable public delivery; recording this request is not a domain Approval Record. */
export class WorkflowDeliveryService {
  private readonly active = new Map<string, Promise<unknown>>();
  private readonly recovery: Promise<void>;
  private stopping = false;

  constructor(private readonly store: TaskStore, private readonly records: OptimizationWorkflowStore, private readonly approvals: WorkflowApprovalService) {
    this.recovery = Promise.resolve().then(async () => {
      for (const id of this.store.listPendingDeliveryWorkflowIds()) {
        if (this.stopping) break;
        try { await this.reconcile(id); }
        catch (error) { console.error(`[corepilot-delivery] recovery failed for ${id}: ${(error as Error).message}`); }
      }
    });
  }

  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.active.get(id);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(action);
    this.active.set(id, next);
    try { return await next; }
    finally { if (this.active.get(id) === next) this.active.delete(id); }
  }

  private save(record: OptimizationWorkflowRecord): void {
    const now = new Date().toISOString();
    const current = this.records.get(record.workflow_id);
    if (!current) throw new Error('workflow not found');
    if (current.delivery_operation && current.delivery_operation.operation_id !== record.delivery_operation?.operation_id) throw new Error('交付操作已改变，请重新核对。');
    if (record.delivery_operation) record.delivery_operation.updated_at = now;
    const next = { ...current, delivery_operation: record.delivery_operation, updated_at: now };
    this.records.save(next); Object.assign(record, next);
  }

  private verification(record: OptimizationWorkflowRecord): CandidateVerificationSummary {
    const task = record.optimization_task_id ? this.store.getOptimizationTask(record.optimization_task_id) : null;
    const candidate = record.candidate_id ? this.store.getCandidate(record.candidate_id) : null;
    return assessCandidateVerification({ workflow: record, task, candidate, experiments: task ? this.store.listExperiments(task.task_id) : [] });
  }

  private matchesRequest(record: OptimizationWorkflowRecord): boolean {
    const operation = record.delivery_operation!;
    const verification = this.verification(record);
    let approval;
    try { approval = this.approvals.assertDeliveryAuthorized(record, verification); } catch { return false; }
    return record.status === 'WAITING_APPROVAL' && approval.approval_id === operation.approval_id
      && approval.evidence_artifact_identity.evidence_id === operation.evidence_id && approval.evidence_artifact_identity.digest === operation.evidence_digest
      && verification.ready && verification.formal_experiment_id === operation.formal_experiment_id
      && verification.revalidation_experiment_id === operation.revalidation_experiment_id
      && record.candidate_id === operation.candidate_id && record.candidate_commit === operation.candidate_commit
      && record.candidate_tree === operation.candidate_tree && record.baseline_commit === operation.baseline_commit
      && record.repository_root === operation.repository && record.workspace_editing === operation.editing_workspace
      && record.workspace_validation === operation.validation_workspace;
  }

  async submit(id: string, input: { expectedBaselineCommit?: string; commitMessage: string }): Promise<DeliveryResult> {
    return this.exclusive(id, async () => {
      if (this.stopping) return { ok: false, message: '后台正在停止，请稍后核对交付状态。' };
      let record = this.records.get(id);
      if (!record) return { ok: false, message: `workflow '${id}' not found` };
      const existing = record.delivery_operation;
      if (existing?.status === 'COMPLETED' && record.delivery && existing.commit_message === input.commitMessage.trim()
        && (!input.expectedBaselineCommit || input.expectedBaselineCommit === existing.baseline_commit)) {
        return { ok: true, commit: record.delivery.commit, tree: record.delivery.tree, ...(existing.cleanup_message ? { cleanup_warning: existing.cleanup_message } : {}) };
      }
      if (existing) return { ok: false, message: '已有交付请求，请先核对状态并继续原请求，不要重复提交。' };
      if (record.status !== 'WAITING_APPROVAL') return { ok: false, message: `workflow is not waiting for approval (status: ${record.status})` };
      const verification = this.verification(record);
      if (!verification.ready) return { ok: false, verification, message: `当前验证记录不足以交付：${verification.issues.map(issue => issue.message).join(' ')}` };
      let approval;
      try { approval = this.approvals.assertDeliveryAuthorized(record, verification); }
      catch (error) { return { ok: false, message: (error as Error).message }; }
      if (!input.commitMessage.trim()) return { ok: false, message: '请填写合并提交说明。' };
      if (!record.repository_root || !record.workspace_editing || !record.workspace_validation || !record.candidate_id
        || !record.candidate_commit || !record.candidate_tree || !record.baseline_commit
        || !verification.formal_experiment_id || !verification.revalidation_experiment_id) {
        return { ok: false, message: '缺少候选工作区或实验身份，请先核对任务记录。' };
      }
      if (input.expectedBaselineCommit && input.expectedBaselineCommit !== record.baseline_commit) {
        return { ok: false, message: 'baseline changed after validation: 请求的基线与任务记录不一致。' };
      }
      const identity = { repository: record.repository_root, editing: record.workspace_editing, validation: record.workspace_validation,
        candidateId: record.candidate_id, candidateCommit: record.candidate_commit, candidateTree: record.candidate_tree, baseline: record.baseline_commit };
      let target: Awaited<ReturnType<typeof resolveDeliveryTarget>>;
      try { target = await resolveDeliveryTarget(record.repository_root, record.source_branch); }
      catch (error) { return { ok: false, message: (error as Error).message }; }
      if (this.stopping) return { ok: false, message: '后台正在停止，请稍后核对交付状态。' };
      if (target.commit !== record.baseline_commit) return { ok: false, message: 'baseline changed after validation: 目标分支已改变，请先核对。' };
      const latest = this.records.get(id);
      if (!latest || latest.delivery_operation || latest.status !== 'WAITING_APPROVAL') return { ok: false, message: '任务状态已改变，请刷新后重新核对。' };
      const latestVerification = this.verification(latest);
      if (!latestVerification.ready || latestVerification.formal_experiment_id !== verification.formal_experiment_id
        || latestVerification.revalidation_experiment_id !== verification.revalidation_experiment_id
        || latest.candidate_id !== record.candidate_id || latest.candidate_commit !== record.candidate_commit
        || latest.candidate_tree !== record.candidate_tree || latest.baseline_commit !== record.baseline_commit
        || latest.repository_root !== record.repository_root || latest.source_branch !== record.source_branch
        || latest.workspace_editing !== identity.editing || latest.workspace_validation !== identity.validation) {
        return { ok: false, message: '候选、验证记录或交付目标已变化，请刷新后重新审阅。' };
      }
      try {
        if (this.approvals.assertDeliveryAuthorized(latest, latestVerification).approval_id !== approval.approval_id) return { ok: false, message: '批准记录已变化，请刷新后重新审阅。' };
      } catch (error) { return { ok: false, message: (error as Error).message }; }
      record = latest;
      const now = new Date().toISOString();
      record.delivery_operation = { schema_version: 1, operation_id: randomUUID(), status: 'PREPARING', target: target.target,
        repository: identity.repository, editing_workspace: identity.editing, validation_workspace: identity.validation,
        baseline_commit: identity.baseline, candidate_id: identity.candidateId, candidate_commit: identity.candidateCommit,
        candidate_tree: identity.candidateTree, formal_experiment_id: verification.formal_experiment_id,
        revalidation_experiment_id: verification.revalidation_experiment_id, approval_id: approval.approval_id,
        evidence_id: approval.evidence_artifact_identity.evidence_id, evidence_digest: approval.evidence_artifact_identity.digest,
        commit_message: input.commitMessage.trim(), prepared_commit: null,
        requested_at: now, updated_at: now, last_checked_at: null, observation: 'UNKNOWN', message: '交付请求已保存，正在准备提交。', can_resume: false,
        stop_confirmation_required: false, stop_confirmed_at: null, cleanup: 'PENDING', cleanup_message: null };
      this.save(record); // Durable before creating or applying a Git commit.
      return this.execute(record);
    });
  }

  async resume(id: string, confirmedStopped = false): Promise<DeliveryResult> {
    return this.exclusive(id, async () => {
      if (this.stopping) return { ok: false, message: '后台正在停止，请稍后核对交付状态。' };
      const record = this.records.get(id);
      if (!record?.delivery_operation) return { ok: false, message: '没有可继续的交付请求。' };
      await this.reconcileRecord(record, false);
      const operation = record.delivery_operation;
      if (!operation) return { ok: false, message: '没有可继续的交付请求。' };
      if (operation.status === 'COMPLETED' && record.delivery) return { ok: true, commit: record.delivery.commit, tree: record.delivery.tree,
        ...(operation.cleanup_message ? { cleanup_warning: operation.cleanup_message } : {}) };
      if (!operation.can_resume) return { ok: false, message: operation.message };
      if (operation.stop_confirmation_required && !confirmedStopped) {
        return { ok: false, message: '原 Git 进程的终态未知。请确认它已停止，再继续同一次交付。' };
      }
      if (operation.stop_confirmation_required) {
        operation.stop_confirmation_required = false; operation.stop_confirmed_at = new Date().toISOString(); this.save(record);
      }
      return this.execute(record);
    });
  }

  async reconcile(id: string): Promise<OptimizationWorkflowRecord> {
    return this.exclusive(id, async () => {
      const record = this.records.get(id);
      if (!record?.delivery_operation) throw new Error('没有可核对的交付请求。');
      return this.reconcileRecord(record, false);
    });
  }

  async withdraw(id: string, operationId: string, confirmedStopped = false): Promise<OptimizationWorkflowRecord> {
    return this.exclusive(id, async () => {
      if (this.stopping) throw new Error('后台正在停止，请稍后核对交付状态。');
      const record = this.records.get(id);
      if (!record) throw new Error('workflow not found');
      if (record.delivery_history?.some(operation => operation.operation_id === operationId && operation.status === 'WITHDRAWN')) return record;
      if (!record.delivery_operation || record.delivery_operation.operation_id !== operationId) throw new Error('交付请求已变化，请刷新后重新核对。');
      await this.reconcileRecord(record, false);
      const operation = record.delivery_operation!;
      if (operation.status === 'COMPLETED') throw new Error('目标分支已包含交付提交，交付已记录，不能撤回该请求。');
      if (operation.observation === 'UNKNOWN') throw new Error('尚无法核对目标分支，请恢复仓库访问后再撤回。');
      if (operation.stop_confirmation_required && !confirmedStopped) throw new Error('原 Git 进程的终态未知。请确认它已停止，再撤回交付请求。');
      const now = new Date().toISOString();
      if (operation.stop_confirmation_required) operation.stop_confirmed_at = now;
      operation.stop_confirmation_required = false; operation.can_resume = false; operation.status = 'WITHDRAWN';
      operation.updated_at = now; operation.message = '未完成的交付请求已撤回；原记录已保留。';
      const current = this.records.get(id);
      if (!current?.delivery_operation || current.delivery_operation.operation_id !== operation.operation_id) throw new Error('交付操作已改变，请重新核对。');
      const next = { ...current, delivery_operation: undefined, delivery_history: [...(current.delivery_history ?? []), operation], updated_at: now };
      this.records.save(next);
      return next;
    });
  }

  async retryCleanup(id: string): Promise<OptimizationWorkflowRecord> {
    return this.exclusive(id, async () => {
      const record = this.records.get(id);
      if (!record?.delivery_operation || record.delivery_operation.status !== 'COMPLETED') throw new Error('交付尚未确认，不能清理候选工作区。');
      if (record.delivery_operation.cleanup !== 'DONE') await this.cleanup(record);
      return record;
    });
  }

  private async execute(record: OptimizationWorkflowRecord): Promise<DeliveryResult> {
    const operation = record.delivery_operation!;
    try {
      const observed = await inspectCandidateDelivery(operation);
      if (observed.state === 'APPLIED' && observed.commit) return await this.complete(record, observed.commit);
      operation.observation = observed.state;
      operation.last_checked_at = new Date().toISOString();
      if (observed.state === 'DIVERGED') throw new Error('目标分支已改变，请核对原基线和交付记录。');
      const current = this.records.get(record.workflow_id);
      if (!current || current.delivery_operation?.operation_id !== operation.operation_id || !this.matchesRequest(current)) {
        throw new Error('候选或验证记录已变化，请先重新审阅；原交付请求不会自动应用。');
      }
      if (!operation.prepared_commit) {
        operation.prepared_commit = observed.commit ?? await prepareCandidateDelivery(operation);
        operation.status = 'PREPARED'; operation.message = '交付提交已固定，等待更新目标分支。'; this.save(record);
      }
      operation.status = 'APPLYING'; operation.observation = 'UNKNOWN'; operation.can_resume = false; operation.message = '正在更新目标分支。'; this.save(record);
      if (!this.matchesRequest(record)) throw new Error('任务状态或验证记录已变化，请先重新审阅；原交付请求不会自动应用。');
      const result = await applyCandidateDelivery(operation);
      return await this.complete(record, result.commit);
    } catch (error) {
      const reason = (error as Error).message;
      try {
        const latest = this.records.get(record.workflow_id);
        if (latest?.delivery_operation) {
          const checked = await this.reconcileRecord(latest, true);
          if (checked.delivery_operation?.status === 'COMPLETED' && checked.delivery) return { ok: true, commit: checked.delivery.commit, tree: checked.delivery.tree,
            ...(checked.delivery_operation.cleanup_message ? { cleanup_warning: checked.delivery_operation.cleanup_message } : {}) };
          checked.delivery_operation!.status = 'NEEDS_ATTENTION'; checked.delivery_operation!.message = reason; this.save(checked);
        }
      } catch { /* The saved intent remains available for a later reconciliation. */ }
      return { ok: false, message: `交付尚未确认：${reason}。请先核对交付状态。` };
    }
  }

  private async reconcileRecord(record: OptimizationWorkflowRecord, processStopped: boolean): Promise<OptimizationWorkflowRecord> {
    const operation = record.delivery_operation!;
    if (operation.status === 'COMPLETED') {
      if (operation.cleanup === 'PENDING') await this.cleanup(record);
      return record;
    }
    const wasApplying = operation.status === 'APPLYING';
    let observed: Awaited<ReturnType<typeof inspectCandidateDelivery>>;
    try { observed = await inspectCandidateDelivery(operation); }
    catch (error) {
      operation.status = 'NEEDS_ATTENTION'; operation.observation = 'UNKNOWN'; operation.can_resume = false;
      if (wasApplying && !processStopped) operation.stop_confirmation_required = true;
      operation.message = `无法核对交付状态：${(error as Error).message}`; operation.last_checked_at = new Date().toISOString();
      this.save(record); return record;
    }
    operation.last_checked_at = new Date().toISOString(); operation.observation = observed.state;
    if (!operation.prepared_commit && observed.commit) operation.prepared_commit = observed.commit;
    if (observed.state === 'APPLIED' && observed.commit) { await this.complete(record, observed.commit); return record; }
    if (wasApplying && !processStopped) operation.stop_confirmation_required = true;
    operation.can_resume = observed.state === 'NOT_APPLIED' && this.matchesRequest(record);
    if (observed.state === 'DIVERGED') {
      operation.status = 'NEEDS_ATTENTION'; operation.message = '目标分支已改变，尚无法确认本次交付；请核对基线与分支历史。';
    } else if (!operation.approval_id) {
      operation.status = 'NEEDS_ATTENTION'; operation.message = '历史交付请求没有关联正式批准；请先核对目标分支，再撤回请求并重新审阅。';
    } else if (!operation.can_resume) {
      operation.status = 'NEEDS_ATTENTION'; operation.message = '候选或验证记录已变化，请先重新审阅；原交付请求不会自动应用。';
    } else if (operation.stop_confirmation_required) {
      operation.status = 'NEEDS_ATTENTION'; operation.message = '目标分支尚未包含交付提交；请先在 CorePilot 运行机器上确认原 Git 进程已停止，再继续。';
    } else {
      operation.status = 'WAITING'; operation.message = '交付请求已保存，目标分支尚未更新；可以继续原交付。';
    }
    this.save(record); return record;
  }

  private async complete(record: OptimizationWorkflowRecord, commit: string): Promise<DeliveryResult> {
    const current = this.records.get(record.workflow_id);
    if (!current?.delivery_operation || current.delivery_operation.operation_id !== record.delivery_operation?.operation_id) throw new Error('交付操作已改变，请重新核对。');
    // Keep the just-observed identity while preserving other fields updated concurrently.
    current.delivery_operation = record.delivery_operation;
    Object.assign(record, current);
    const operation = record.delivery_operation!;
    operation.prepared_commit = commit; operation.status = 'COMPLETED'; operation.observation = 'APPLIED'; operation.can_resume = false;
    operation.stop_confirmation_required = false; operation.message = '已核对目标分支包含本次交付提交。';
    operation.updated_at = new Date().toISOString(); operation.last_checked_at = operation.updated_at;
    record.status = 'DELIVERABLE'; record.delivery = { commit, tree: operation.candidate_tree, candidate_id: operation.candidate_id,
      approved_at: operation.requested_at, commit_message: operation.commit_message,
      ...(operation.approval_id ? { approval_id: operation.approval_id } : {}), ...(operation.evidence_id ? { evidence_id: operation.evidence_id } : {}) };
    record.progress = { phase: 'DELIVERABLE', last_event: 'candidate delivery confirmed from Git identity' };
    record.updated_at = operation.updated_at;
    const task = record.optimization_task_id ? this.store.getOptimizationTask(record.optimization_task_id) : null;
    this.store.saveCompletedDelivery(record.workflow_id, JSON.stringify(record), task ? { ...task, status: 'COMPLETED', updated_at: record.updated_at } : null);
    await this.cleanup(record);
    return { ok: true, commit, tree: operation.candidate_tree, ...(operation.cleanup_message ? { cleanup_warning: operation.cleanup_message } : {}) };
  }

  private async cleanup(record: OptimizationWorkflowRecord): Promise<void> {
    const operation = record.delivery_operation!;
    try { await cleanupDeliveryWorkspaces(operation); operation.cleanup = 'DONE'; operation.cleanup_message = null; }
    catch (error) { operation.cleanup = 'NEEDS_ATTENTION'; operation.cleanup_message = `交付已记录，但候选工作区未清理：${(error as Error).message}`; }
    try { this.save(record); } catch { /* Completion is already durable; PENDING will be reconciled on restart. */ }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.recovery;
    await Promise.allSettled([...this.active.values()]);
  }
}
