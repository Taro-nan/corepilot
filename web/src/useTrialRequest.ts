import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { newRequestId } from './request-id';

type Lookup = { state: 'NOT_FOUND' | 'PREPARING' | 'CLOSED' } | { state: 'CREATED'; trial_id: string };
type Stored = { key: string; id: string | null; error: string | null };

function read(key: string): Stored {
  try {
    const id = localStorage.getItem(key);
    if (id && !/^[a-f0-9-]{36}$/i.test(id)) return { key, id: null, error: '无法读取上次请求标识，请检查浏览器存储。' };
    return { key, id, error: null };
  } catch { return { key, id: null, error: '无法访问浏览器存储，请检查浏览器设置后重试。' }; }
}

/** Only the opaque request ID is stored, never the build command or settings. */
export function useTrialRequest(projectId: string, packageId: string, version: string, targetId: string, purpose: string) {
  const key = ['corepilot-trial-request-v1', projectId, packageId, version, targetId, purpose].map(encodeURIComponent).join(':');
  const [stored, setStored] = useState<Stored>(() => read(key));
  const mounted = useRef(false), currentKey = useRef(key); currentKey.current = key;
  useEffect(() => {
    mounted.current = true; setStored(read(key));
    const onStorage = (event: StorageEvent) => { if (event.key === key) setStored(read(key)); };
    window.addEventListener('storage', onStorage);
    return () => { mounted.current = false; window.removeEventListener('storage', onStorage); };
  }, [key]);
  const value = stored.key === key ? stored : read(key);
  const url = `/v1/projects/${encodeURIComponent(projectId)}/validation-trial-request`;

  function begin(): string {
    const current = read(key);
    if (current.error) throw new Error(current.error);
    if (current.id) throw new Error('上次请求尚未确认，请先核对或关闭尚未创建的请求。');
    const id = newRequestId();
    try { localStorage.setItem(key, id); }
    catch { throw new Error('无法保存请求标识，请检查浏览器存储设置后重试。'); }
    setStored({ key, id, error: null }); return id;
  }
  function clear(id: string) {
    if (!mounted.current || currentKey.current !== key) return;
    try { if (localStorage.getItem(key) === id) localStorage.removeItem(key); setStored(read(key)); }
    catch { setStored({ key, id, error: '无法清除浏览器中的请求标识，请检查浏览器存储。' }); }
  }
  function check(id: string): Promise<Lookup> { return request(url, 'GET', undefined, undefined, { 'idempotency-key': id }); }
  function close(id: string): Promise<Lookup> { return request(`${url}/close`, 'POST', {}, undefined, { 'idempotency-key': id }); }
  return { pending: value.id, storageError: value.error, begin, clear, check, close,
    isCurrent: () => mounted.current && currentKey.current === key };
}
