import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ValidationGenerationOutcome, ValidationGenerationRecord } from '../contracts/validation-assets.js';
import { ApiError } from '../core/api-error.js';

export class ValidationGenerationNeedsInput extends Error {
  constructor(readonly blockers: string[]) { super(blockers.join('；')); }
}
export interface ValidationGenerationControl {
  signal: AbortSignal;
  progress(phase: string, message: string): void;
  observation(patch: Partial<ValidationGenerationRecord['model']>): void;
}
const active = (status: string) => status === 'RUNNING' || status === 'CANCELLING';

/** Durable receipts for code drafting; Pi remains the only model/tool runtime. */
export class ValidationGenerationRuns {
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, Promise<ValidationGenerationOutcome>>();
  private readonly records = new Map<string, ValidationGenerationRecord>();
  constructor(private readonly dataDir: string) {}

  start(input: Omit<ValidationGenerationRecord, 'generation_id' | 'status' | 'phase' | 'message' | 'created_at' | 'updated_at' | 'ended_at'>,
    execute: (control: ValidationGenerationControl) => Promise<ValidationGenerationOutcome>, redact: (text: string) => string): ValidationGenerationRecord {
    if (this.list(input.project_id).some(item => active(item.status) && item.package_id === input.package_id && item.package_version === input.package_version && item.target_id === input.target_id)) {
      throw new ApiError(409, 'GENERATION_IN_PROGRESS', '当前函数已有测试代码正在生成，请查看进度或取消后重试');
    }
    const now = new Date().toISOString(), id = randomUUID();
    const record: ValidationGenerationRecord = { ...input, generation_id: id, status: 'RUNNING', phase: 'PREPARING',
      message: '正在检查测试条件并准备源码上下文', created_at: now, updated_at: now, ended_at: null };
    const controller = new AbortController(); this.controllers.set(id, controller); this.records.set(id, record); this.write(record);
    const save = () => { record.updated_at = new Date().toISOString(); this.write(record); };
    const promise = Promise.resolve().then(() => execute({ signal: controller.signal,
      progress: (phase, message) => { if (record.status === 'RUNNING') { record.phase = phase; record.message = message; save(); } },
      observation: patch => { Object.assign(record.model, patch); save(); },
    })).then(result => {
      controller.signal.throwIfAborted();
      if ('kind' in result) {
        result.generation_id = id; record.proposal = result; record.message = '正确性方案已起草，请查看输入、独立参考和误差建议后采用';
      } else { record.result = result; record.message = '代码草稿已生成，等待查看、保存与目标机试运行'; }
      record.status = 'SUCCEEDED'; record.phase = 'COMPLETED';
      return result;
    }).catch(error => {
      if (controller.signal.aborted) { record.status = 'CANCELLED'; record.message = '已取消生成'; }
      else if (error instanceof ValidationGenerationNeedsInput) { record.status = 'NEEDS_INPUT'; record.blockers = error.blockers; record.message = error.message; }
      else { record.status = 'FAILED'; record.message = redact((error as Error).message).slice(0, 4000); }
      record.phase = record.status;
      throw error;
    }).finally(() => { record.ended_at = new Date().toISOString(); save(); this.controllers.delete(id); this.records.delete(id); this.pending.delete(id); });
    this.pending.set(id, promise);
    // Background browser requests observe the receipt; synchronous CLI requests await the same promise.
    void promise.catch(() => {});
    return structuredClone(record);
  }

  async wait(projectId: string, id: string): Promise<ValidationGenerationOutcome> {
    const pending = this.pending.get(id);
    if (pending) {
      try { return await pending; }
      catch { const record = this.get(projectId, id); throw new ApiError(record.status === 'NEEDS_INPUT' ? 422 : 400,
        record.status === 'NEEDS_INPUT' ? 'GENERATION_NEEDS_INPUT' : 'GENERATION_FAILED', record.message); }
    }
    const record = this.get(projectId, id);
    if (record.proposal && record.status === 'SUCCEEDED') return record.proposal;
    if (record.result && record.status === 'SUCCEEDED') return record.result;
    throw new Error(record.message);
  }
  list(projectId: string): ValidationGenerationRecord[] {
    const directory = this.directory(projectId);
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
      .map(name => this.get(projectId, name.slice(0, -5))).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
  }
  get(projectId: string, id: string): ValidationGenerationRecord {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(400, 'INVALID_GENERATION_ID', '生成记录 ID 不正确');
    const filename = path.join(this.directory(projectId), id + '.json');
    if (!fs.existsSync(filename)) throw new ApiError(404, 'GENERATION_NOT_FOUND', '未找到生成记录');
    const record = JSON.parse(fs.readFileSync(filename, 'utf8')) as ValidationGenerationRecord;
    if (active(record.status) && !this.controllers.has(id)) {
      record.status = 'INTERRUPTED'; record.phase = 'INTERRUPTED'; record.message = '服务已重启，未取得完整生成结果；可重新生成';
      record.ended_at = new Date().toISOString(); this.write(record);
    }
    return record;
  }
  cancel(projectId: string, id: string): ValidationGenerationRecord {
    const record = this.records.get(id) ?? this.get(projectId, id), controller = this.controllers.get(id);
    if (active(record.status) && controller) { controller.abort(new Error('用户取消生成')); record.status = 'CANCELLING'; record.message = '正在停止模型请求'; this.write(record); }
    return record;
  }
  private directory(projectId: string) { return path.join(this.dataDir, 'projects', projectId, 'validation-generations'); }
  private write(record: ValidationGenerationRecord) {
    const directory = this.directory(record.project_id); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, record.generation_id + '.json');
    fs.writeFileSync(filename + '.tmp', JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(filename + '.tmp', filename);
  }
}
