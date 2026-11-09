import { newRequestId } from '../request-id';

const DATABASE = 'corepilot-testing-request-v1';
const STORE = 'pending';
const KEY = 'active';
const CHANNEL = 'corepilot-testing-request';
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);

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

type Action = 'read' | 'reserve' | 'clear';
async function transact(action: Action, expected?: string): Promise<{ id: string | null; reserved: boolean }> {
  const proposed = action === 'reserve' ? newRequestId() : null;
  const database = await open();
  return new Promise((resolve, reject) => {
    let result: { id: string | null; reserved: boolean } = { id: null, reserved: false };
    let error: Error | null = null;
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, action === 'read' ? 'readonly' : 'readwrite'); }
    catch { database.close(); reject(new Error('无法保存浏览器请求标识，请检查浏览器存储。')); return; }
    const store = transaction.objectStore(STORE), request = store.get(KEY);
    request.onsuccess = () => {
      const value: unknown = request.result;
      if (value !== undefined && !valid(value)) { error = new Error('上次测试请求标识无法读取，请联系维护者核对浏览器存储。'); transaction.abort(); return; }
      const id = value === undefined ? null : value;
      if (action === 'reserve' && !id) { store.add(proposed!, KEY); result = { id: proposed, reserved: true }; }
      else if (action === 'clear' && id === expected) { store.delete(KEY); result = { id: null, reserved: false }; }
      else result = { id, reserved: false };
    };
    transaction.oncomplete = () => { database.close(); if (action !== 'read') broadcast(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(error ?? new Error('无法保存浏览器请求标识，请检查浏览器存储。')); };
    transaction.onerror = () => { /* onabort reports the failure once the transaction has rolled back. */ };
  });
}

export const readTestingRequest = () => transact('read');
export const reserveTestingRequest = () => transact('reserve');
export const clearTestingRequest = (id: string) => transact('clear', id);
export const testingRequestChannel = CHANNEL;
