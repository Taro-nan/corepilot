import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../core/api-error.js';
import type { TestingAsset, TestingTaskDetails, TestingTaskRecord } from '../contracts/testing.js';

/** Independent test facts never overwrite project configuration or optimization evidence. */
export class TestingStore {
  readonly root: string;
  constructor(dataDir: string) { this.root = path.resolve(dataDir, 'testing'); }

  private identity(id: string, prefix = ''): string {
    const plain = prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id;
    if ((prefix && !id.startsWith(prefix)) || !/^[a-f0-9-]{36}$/.test(plain)) {
      throw new ApiError(400, 'INVALID_TESTING_ID', '测试记录标识无效，请重新选择。');
    }
    return plain;
  }
  taskRoot(id: string): string { return path.join(this.root, 'tasks', this.identity(id, 'testing:')); }
  assetRoot(id: string): string { return path.join(this.root, 'assets', this.identity(id)); }

  write(filename: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temporary, filename); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  private read<T>(filename: string): T {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')) as T; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ApiError(404, 'TESTING_NOT_FOUND', '测试或文件记录不存在，请重新选择。');
      throw error;
    }
  }
  task(id: string): TestingTaskRecord {
    const record = this.read<TestingTaskRecord>(path.join(this.taskRoot(id), 'task.json'));
    if (record.task_id !== id) throw new Error('testing task identity mismatch');
    return record;
  }
  saveTask(record: TestingTaskRecord): void { this.write(path.join(this.taskRoot(record.task_id), 'task.json'), record); }
  updateTask(id: string, change: (record: TestingTaskRecord) => void): TestingTaskRecord {
    const record = this.task(id); change(record); record.updated_at = new Date().toISOString(); this.saveTask(record); return record;
  }
  tasks(): TestingTaskRecord[] {
    const root = path.join(this.root, 'tasks');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id) && fs.existsSync(path.join(root, id, 'task.json')))
      .map(id => this.task(`testing:${id}`)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  findRequest(requestId: string): TestingTaskRecord | null { return this.tasks().find(task => task.request_id === requestId) ?? null; }
  asset(id: string): TestingAsset {
    const record = this.read<TestingAsset>(path.join(this.assetRoot(id), 'asset.json'));
    if (record.asset_id !== id) throw new Error('testing asset identity mismatch');
    return record;
  }
  saveAsset(record: TestingAsset): void { this.write(path.join(this.assetRoot(record.asset_id), 'asset.json'), record); }
  assets(): TestingAsset[] {
    const root = path.join(this.root, 'assets');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id) && fs.existsSync(path.join(root, id, 'asset.json')))
      .map(id => this.asset(id)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  cache(id: string): TestingTaskDetails | null {
    const filename = path.join(this.taskRoot(id), 'result.json');
    return fs.existsSync(filename) ? this.read<TestingTaskDetails>(filename) : null;
  }
  saveResult(result: TestingTaskDetails): void { this.write(path.join(this.taskRoot(result.task.task_id), 'result.json'), result); }
}
