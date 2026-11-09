import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowRecord, WorkflowExecutionOutcomePatch } from '../contracts/workflow.js';

export interface OptimizationWorkflowStore {
  save(record: OptimizationWorkflowRecord): void;
  get(workflowId: string): OptimizationWorkflowRecord | null;
  list(limit?: number): OptimizationWorkflowRecord[];
}

/** SQLite 持久化适配器；工作流 JSON 是唯一需要保存的运行状态。 */
export class SqliteOptimizationWorkflowStore implements OptimizationWorkflowStore {
  constructor(private readonly taskStore: TaskStore) {}

  save(record: OptimizationWorkflowRecord): void {
    this.taskStore.saveOptimizationWorkflowJson(record.workflow_id, JSON.stringify(record));
  }

  get(workflowId: string): OptimizationWorkflowRecord | null {
    const json = this.taskStore.getOptimizationWorkflowJson(workflowId);
    if (!json) return null;
    return JSON.parse(json) as OptimizationWorkflowRecord;
  }

  list(limit = 50): OptimizationWorkflowRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer in 1..200');
    return this.taskStore.listOptimizationWorkflowJson(limit).map(json => JSON.parse(json) as OptimizationWorkflowRecord);
  }
}

/** Persist an outcome without treating a storage failure as a Candidate failure. */
export function finishWorkflowExecution(store: TaskStore, workflowId: string, taskId: string,
  patch: WorkflowExecutionOutcomePatch, clean: (message: string) => string): void {
  try {
    store.finishOptimizationWorkflow(workflowId, taskId, patch);
  } catch (error) {
    const message = clean(`保存优化结束状态失败：${(error as Error).message}。已保留已有候选和实验，请核对后继续。`);
    try {
      store.finishOptimizationWorkflow(workflowId, taskId, { status: 'INTERRUPTED', error: message,
        progress: { phase: 'INTERRUPTED', last_event: message } });
    } catch {
      // Persistent DB errors may prevent even an interruption record. Keep the
      // prior state for startup reconciliation and show a diagnostic if possible.
      try {
        const current = store.getOptimizationWorkflowJson(workflowId);
        if (!current) return;
        const record = JSON.parse(current) as OptimizationWorkflowRecord;
        if (record.optimization_task_id === taskId && ['CREATED', 'GENERATING'].includes(record.status)) {
          store.saveOptimizationWorkflowJson(workflowId, JSON.stringify({ ...record, error: message,
            progress: { phase: 'PERSISTENCE_ERROR', last_event: message }, updated_at: new Date().toISOString() }));
        }
      } catch { /* A persistent storage outage also prevents saving diagnostics. */ }
    }
  }
}

export function initialOptimizationWorkflowRecord(
  workflowId: string,
  input: { functionName: string; entryFile: string | null; configPath: string; repositoryRoot: string; configFileSha256?: string; testpackDigest?: string; enablePerformance?: boolean },
  now = new Date(),
): OptimizationWorkflowRecord {
  const timestamp = now.toISOString();
  return {
    workflow_id: workflowId,
    status: 'CREATED',
    function_name: input.functionName,
    entry_file: input.entryFile,
    config_path: input.configPath,
    repository_root: input.repositoryRoot,
    ...(input.configFileSha256 ? { config_file_sha256: input.configFileSha256 } : {}),
    ...(input.testpackDigest ? { testpack_digest: input.testpackDigest } : {}),
    enable_performance: input.enablePerformance === true,
    error: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
}
