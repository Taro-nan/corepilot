import type { TaskStore } from '../storage/task-store.js';
import type { OptimizationWorkflowRecord } from '../contracts/workflow.js';

export interface OptimizationWorkflowStore {
  save(record: OptimizationWorkflowRecord): void;
  get(workflowId: string): OptimizationWorkflowRecord | null;
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
