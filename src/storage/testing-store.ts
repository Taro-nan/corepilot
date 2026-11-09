import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ApiError } from '../core/api-error.js';
import type { TestingAsset, TestingTaskDetails, TestingTaskRecord } from '../contracts/testing.js';

interface ClosedTestingRequest { schema_version: 1; kind: 'CLOSED_TESTING_REQUEST'; task_id: string; request_key_digest: string }
type RequestDecision = { state: 'NOT_FOUND' } | { state: 'CLOSED' } | { state: 'CREATED'; task: TestingTaskRecord };

export function testingRequestIdentity(requestId: string): { keyDigest: string; taskId: string } {
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 160) throw new ApiError(400, 'INVALID_REQUEST_ID', '请求标识应为 1 到 160 个字符。');
  const keyDigest = createHash('sha256').update('corepilot-testing-request-v1\0').update(requestId).digest('hex');
  const variant = ((Number.parseInt(keyDigest[16], 16) & 3) | 8).toString(16);
  const uuid = `${keyDigest.slice(0, 8)}-${keyDigest.slice(8, 12)}-8${keyDigest.slice(13, 16)}-${variant}${keyDigest.slice(17, 20)}-${keyDigest.slice(20, 32)}`;
  return { keyDigest, taskId: `testing:${uuid}` };
}

function closed(record: TestingTaskRecord | ClosedTestingRequest): record is ClosedTestingRequest {
  return 'kind' in record && record.kind === 'CLOSED_TESTING_REQUEST';
}

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

  private write(filename: string, value: unknown, durable = false): void {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); if (durable) fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
      if (durable && process.platform !== 'win32') {
        const dir = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    }
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
    const record = this.read<TestingTaskRecord | ClosedTestingRequest>(path.join(this.taskRoot(id), 'task.json'));
    if (closed(record)) throw new ApiError(404, 'TESTING_NOT_FOUND', '测试记录不存在，该创建请求已关闭。');
    if (record.task_id !== id) throw new Error('testing task identity mismatch');
    return record;
  }
  saveTask(record: TestingTaskRecord): void {
    this.withTaskWriteLock(() => {
      const filename = path.join(this.taskRoot(record.task_id), 'task.json');
      if (fs.existsSync(filename)) throw new ApiError(409, 'TESTING_TASK_EXISTS', '测试记录已存在，请核对原任务。');
      this.replaceTask(filename, record);
    });
  }
  private replaceTask(filename: string, record: TestingTaskRecord): void {
    try { this.write(filename, record, true); }
    catch { throw new ApiError(503, 'TESTING_STATE_UNCONFIRMED', '测试状态的保存结果尚未确认，请检查数据目录并查询原任务。'); }
  }
  /** A short SQLite write transaction serializes file updates across Control processes. */
  private withTaskWriteLock<T>(write: () => T): T {
    let database: DatabaseSync | undefined;
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      database = new DatabaseSync(path.join(this.root, 'task-write-lock.sqlite'));
      database.exec('PRAGMA busy_timeout = 250; BEGIN IMMEDIATE');
    } catch {
      try { database?.close(); } catch { /* Preserve the lock error. */ }
      throw new ApiError(503, 'TESTING_STATE_LOCK_UNAVAILABLE', '无法锁定测试状态，请检查数据目录权限及文件系统的 SQLite 锁支持后重试。原任务已保留。');
    }
    try {
      const result = write();
      try { database.exec('COMMIT'); }
      catch { throw new ApiError(503, 'TESTING_STATE_UNCONFIRMED', '测试状态的保存结果尚未确认，请查询原任务；不要重复提交。'); }
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* The file may already have been replaced; callers must reconcile it. */ }
      throw error;
    } finally {
      try { database.close(); }
      catch { throw new ApiError(503, 'TESTING_STATE_UNCONFIRMED', '测试状态的保存结果尚未确认，请查询原任务；不要重复提交。'); }
    }
  }
  updateTask(id: string, change: (record: TestingTaskRecord) => void): TestingTaskRecord {
    return this.withTaskWriteLock(() => {
      let record: TestingTaskRecord;
      try { record = this.task(id); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'TESTING_STATE_UNCONFIRMED', '无法读取测试状态，请检查数据目录并核对原任务。');
      }
      change(record); record.updated_at = new Date().toISOString();
      this.replaceTask(path.join(this.taskRoot(id), 'task.json'), record); return record;
    });
  }
  tasks(): TestingTaskRecord[] {
    const root = path.join(this.root, 'tasks');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root).filter(id => /^[a-f0-9-]{36}$/.test(id) && fs.existsSync(path.join(root, id, 'task.json')))
      .flatMap(id => { const record = this.read<TestingTaskRecord | ClosedTestingRequest>(path.join(root, id, 'task.json'));
        if (closed(record)) return [];
        if (record.task_id !== `testing:${id}`) throw new Error('testing task identity mismatch');
        return [record]; }).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  requestDecision(requestId: string): RequestDecision {
    const identity = testingRequestIdentity(requestId);
    const filename = path.join(this.taskRoot(identity.taskId), 'task.json');
    const gate = fs.existsSync(filename) ? this.read<TestingTaskRecord | ClosedTestingRequest>(filename) : null;
    if (gate && (gate.task_id !== identity.taskId || (closed(gate) ? gate.request_key_digest !== identity.keyDigest : gate.request_id !== requestId))) {
      throw new ApiError(409, 'TESTING_REQUEST_IDENTITY_CONFLICT', '请求身份与已有记录不一致，请维护者核对。');
    }
    const matches = this.tasks().filter(task => task.request_id === requestId);
    if (matches.length > 1 || gate && closed(gate) && matches.length) {
      throw new ApiError(409, 'TESTING_REQUEST_AMBIGUOUS', '同一请求标识对应多条历史记录，请维护者核对；原记录均已保留。');
    }
    if (gate && closed(gate)) return { state: 'CLOSED' };
    if (matches.length === 1) return { state: 'CREATED', task: matches[0] };
    if (gate) return { state: 'CREATED', task: gate as TestingTaskRecord };
    return { state: 'NOT_FOUND' };
  }
  private publishRequestDecision(filename: string, value: TestingTaskRecord | ClosedTestingRequest): boolean {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try {
        fs.linkSync(temporary, filename);
        if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
        return true;
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    } catch {
      throw new ApiError(503, 'TESTING_ATOMIC_STORAGE_UNAVAILABLE', '无法确认测试请求是否原子保存；请检查数据目录权限与文件系统是否支持硬链接，并核对原请求。');
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  claimRequest(task: TestingTaskRecord): { created: boolean; decision: RequestDecision } {
    if (!task.request_id) throw new Error('a testing request key is required');
    const identity = testingRequestIdentity(task.request_id);
    if (task.task_id !== identity.taskId) throw new Error('testing request task identity mismatch');
    const prior = this.requestDecision(task.request_id);
    if (prior.state !== 'NOT_FOUND') return { created: false, decision: prior };
    const created = this.publishRequestDecision(path.join(this.taskRoot(task.task_id), 'task.json'), task);
    return { created, decision: this.requestDecision(task.request_id) };
  }
  closeRequest(requestId: string): RequestDecision {
    const identity = testingRequestIdentity(requestId);
    const prior = this.requestDecision(requestId);
    if (prior.state !== 'NOT_FOUND') return prior;
    const marker: ClosedTestingRequest = { schema_version: 1, kind: 'CLOSED_TESTING_REQUEST', task_id: identity.taskId, request_key_digest: identity.keyDigest };
    this.publishRequestDecision(path.join(this.taskRoot(identity.taskId), 'task.json'), marker);
    return this.requestDecision(requestId);
  }
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
  saveResult(result: TestingTaskDetails): boolean {
    return this.withTaskWriteLock(() => {
      const current = this.task(result.task.task_id);
      if (!isDeepStrictEqual(current.execution, result.task.execution)) return false;
      this.write(path.join(this.taskRoot(result.task.task_id), 'result.json'), result);
      return true;
    });
  }
}
