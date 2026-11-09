import { useEffect, useRef, useState } from 'react';
import { clearTestingRequest, readTestingRequest, reserveTestingRequest, testingRequestChannel } from './testing-request-storage';

interface State { loading: boolean; id: string | null; error: string | null }

/** Only the opaque request ID is durable; drafts remain in session storage. */
export function useTestingRequest() {
  const [state, setState] = useState<State>({ loading: true, id: null, error: null });
  const mounted = useRef(false);
  async function refresh() {
    try { const value = await readTestingRequest(); if (mounted.current) setState({ loading: false, id: value.id, error: null }); }
    catch (error) { if (mounted.current) setState({ loading: false, id: null, error: (error as Error).message }); }
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
  async function begin(): Promise<string> {
    const value = await reserveTestingRequest();
    if (mounted.current) setState({ loading: false, id: value.id, error: null });
    if (!value.reserved || !value.id) throw new Error('上次测试创建请求尚未确认，请先核对或关闭未创建的请求。');
    return value.id;
  }
  async function clear(id: string) {
    const value = await clearTestingRequest(id);
    if (mounted.current) setState({ loading: false, id: value.id, error: null });
    return value.id;
  }
  return { ...state, begin, clear, refresh };
}
