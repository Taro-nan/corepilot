import { useEffect, useRef, useState } from 'react';
import type { ControlIdentity } from '../../../src/contracts/control-identity';
import { clearTestingRequest, completeTestingRequest, readTestingRequest, reserveTestingRequest, testingRequestChannel } from './testing-request-storage';

interface State { loading: boolean; id: string | null; identity: ControlIdentity | null; error: string | null }

/** Request and task identities are durable; drafts remain in session storage. */
export function useTestingRequest() {
  const [state, setState] = useState<State>({ loading: true, id: null, identity: null, error: null });
  const mounted = useRef(false);
  async function refresh() {
    try { const value = await readTestingRequest(); if (mounted.current) setState({ loading: false, id: value.pending?.id ?? null, identity: value.pending?.identity ?? null, error: null }); }
    catch (error) { if (mounted.current) setState({ loading: false, id: null, identity: null, error: (error as Error).message }); }
  }
  useEffect(() => {
    mounted.current = true; void refresh();
    let channel: BroadcastChannel | null = null;
    try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(testingRequestChannel); }
    catch { /* Focus refresh and IndexedDB transactions still protect against duplicate creation. */ }
    if (channel) channel.onmessage = () => { void refresh(); };
    const focused = () => { void refresh(); }; window.addEventListener('focus', focused);
    return () => { mounted.current = false; channel?.close(); window.removeEventListener('focus', focused); };
  }, []);
  async function begin(identity: ControlIdentity): Promise<string> {
    const value = await reserveTestingRequest(identity);
    if (mounted.current) setState({ loading: false, id: value.pending?.id ?? null, identity: value.pending?.identity ?? null, error: null });
    if (!value.reserved || !value.pending) throw new Error('上次测试创建请求尚未确认，请先核对或关闭未创建的请求。');
    return value.pending.id;
  }
  async function clear(id: string, identity: ControlIdentity) {
    const value = await clearTestingRequest(id, identity);
    if (mounted.current) setState({ loading: false, id: value.pending?.id ?? null, identity: value.pending?.identity ?? null, error: null });
    return value.pending?.id ?? null;
  }
  async function complete(id: string, identity: ControlIdentity, taskId: string) {
    const value = await completeTestingRequest(id, identity, taskId);
    if (mounted.current) setState({ loading: false, id: value.pending?.id ?? null, identity: value.pending?.identity ?? null, error: null });
  }
  return { ...state, begin, clear, complete, refresh };
}
