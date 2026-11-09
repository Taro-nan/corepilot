import { isControlIdentity, type ControlIdentity } from '../../../src/contracts/control-identity';
import { newRequestId } from '../request-id';

const DATABASE = 'corepilot-testing-request-v1';
const STORE = 'pending';
const KEY = 'active';
const CHANNEL = 'corepilot-testing-request';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sameControl = (left: ControlIdentity | null, right: ControlIdentity) => !!left && left.database_id === right.database_id && left.data_root_id === right.data_root_id;

interface PendingRequest { id: string; identity: ControlIdentity | null }
interface RequestState { pending: PendingRequest | null; reserved: boolean }

function pendingRecord(value: unknown): PendingRequest | null {
  if (value === undefined) return null;
  if (validId(value)) return { id: value, identity: null }; // Legacy key has no provable Control identity.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { version?: unknown; id?: unknown; identity?: unknown };
    if (record.version === 2 && validId(record.id) && isControlIdentity(record.identity)) return { id: record.id, identity: record.identity };
  }
  throw new Error('上次测试请求标识或控制端身份无法读取，请联系维护者核对浏览器存储。');
}

function taskIdentity(value: unknown): ControlIdentity | null {
  if (value === undefined) return null;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { version?: unknown; identity?: unknown };
    if (record.version === 1 && isControlIdentity(record.identity)) return record.identity;
  }
  throw new Error('测试任务绑定的控制端身份无法读取，请联系维护者核对；不会改用普通任务详情。');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      if (!globalThis.indexedDB) throw new Error();
      request = indexedDB.open(DATABASE, 1);
    } catch { reject(new Error('无法访问浏览器请求存储，请检查浏览器设置。')); return; }
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法访问浏览器请求存储，请检查浏览器设置。'));
    request.onblocked = () => reject(new Error('浏览器请求存储被其他页面占用，请关闭其他页面后重试。'));
  });
}

function broadcast() {
  if (typeof BroadcastChannel === 'undefined') return;
  try { const channel = new BroadcastChannel(CHANNEL); channel.postMessage('changed'); channel.close(); }
  catch { /* The IndexedDB transaction remains authoritative across tabs. */ }
}

type Action = { kind: 'read' } | { kind: 'reserve'; identity: ControlIdentity }
  | { kind: 'clear'; id: string; identity: ControlIdentity }
  | { kind: 'complete'; id: string; identity: ControlIdentity; taskId: string };

/** Publish a task binding and clear its pending request in one transaction. */
async function transact(action: Action): Promise<RequestState> {
  const proposed = action.kind === 'reserve' ? newRequestId() : null;
  const database = await open();
  return new Promise((resolve, reject) => {
    let result: RequestState = { pending: null, reserved: false };
    let error: Error | null = null;
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, action.kind === 'read' ? 'readonly' : 'readwrite'); }
    catch { database.close(); reject(new Error('无法保存浏览器请求标识，请检查浏览器存储。')); return; }
    const store = transaction.objectStore(STORE), request = store.get(KEY);
    const abort = (reason: unknown) => { error = reason instanceof Error ? reason : new Error('无法保存浏览器请求标识。'); transaction.abort(); };
    request.onsuccess = () => {
      try {
        const pending = pendingRecord(request.result);
        if (action.kind === 'reserve' && !pending) {
          store.add({ version: 2, id: proposed, identity: action.identity }, KEY);
          result = { pending: { id: proposed!, identity: action.identity }, reserved: true };
        } else if (action.kind === 'clear' && pending?.id === action.id && sameControl(pending.identity, action.identity)) {
          store.delete(KEY); result = { pending: null, reserved: false };
        } else if (action.kind === 'complete') {
          if (pending?.id === action.id && !sameControl(pending.identity, action.identity)) throw new Error('原请求的控制端身份已变化，请维护者核对。');
          const binding = store.get('task:' + action.taskId);
          binding.onsuccess = () => {
            try {
              const existing = taskIdentity(binding.result);
              if (existing && !sameControl(existing, action.identity)) throw new Error('此任务标识已绑定其他控制端，请维护者核对。');
              if (!existing) {
                try { store.add({ version: 1, identity: action.identity }, 'task:' + action.taskId); }
                catch { throw new Error('无法保存测试任务与原控制端的关联，请检查浏览器存储；原请求尚待核对。'); }
              }
              if (pending?.id === action.id) store.delete(KEY);
              result = { pending: pending?.id === action.id ? null : pending, reserved: false };
            } catch (failure) { abort(failure); }
          };
        } else result = { pending, reserved: false };
      } catch (failure) { abort(failure); }
    };
    transaction.oncomplete = () => { database.close(); if (action.kind !== 'read') broadcast(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(error ?? new Error('无法保存浏览器请求或任务身份，请检查浏览器存储；原请求尚待核对。')); };
    transaction.onerror = () => { /* onabort reports the failure after rollback. */ };
  });
}

export const readTestingRequest = () => transact({ kind: 'read' });
export const reserveTestingRequest = (identity: ControlIdentity) => transact({ kind: 'reserve', identity });
export const clearTestingRequest = (id: string, identity: ControlIdentity) => transact({ kind: 'clear', id, identity });
export const completeTestingRequest = (id: string, identity: ControlIdentity, taskId: string) => transact({ kind: 'complete', id, identity, taskId });

/** Absence means an ordinary historical task; a malformed or unreadable binding is an error. */
export async function readTestingTaskIdentity(taskId: string): Promise<ControlIdentity | null> {
  const database = await open();
  return new Promise((resolve, reject) => {
    let result: ControlIdentity | null = null, error: Error | null = null;
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, 'readonly'); }
    catch { database.close(); reject(new Error('无法读取测试任务身份，请检查浏览器存储。')); return; }
    const request = transaction.objectStore(STORE).get('task:' + taskId);
    request.onsuccess = () => { try { result = taskIdentity(request.result); } catch (failure) { error = failure as Error; transaction.abort(); } };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(error ?? new Error('无法读取测试任务身份，请检查浏览器存储；不会改用普通任务详情。')); };
    transaction.onerror = () => {};
  });
}
export const testingRequestChannel = CHANNEL;
