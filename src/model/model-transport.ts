import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';

export interface ModelTransport {
  readonly proxy?: string;
  readonly fetch: typeof fetch;
  close(): Promise<void>;
}

/**
 * Create a fetch implementation scoped to model requests.
 *
 * The dispatcher is deliberately injected into model discovery and Pi calls
 * instead of changing the process-wide dispatcher, so backend, SSH, and other
 * application HTTP requests keep their existing routing.
 */
export function createModelTransport(proxy?: string): ModelTransport {
  const normalized = proxy?.trim().replace(/\/+$/, '');
  if (!normalized) return { fetch, close: async () => undefined };

  const parsed = new URL(normalized);
  let dispatcher: Dispatcher;
  if (parsed.protocol === 'socks5:') {
    dispatcher = new Socks5ProxyAgent(parsed);
  } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    dispatcher = new ProxyAgent(normalized);
  } else {
    throw new Error('model.proxy must use http, https, or socks5');
  }

  const proxiedFetch: typeof fetch = (input, init) => undiciFetch(
    input as Parameters<typeof undiciFetch>[0],
    { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1],
  ) as unknown as ReturnType<typeof fetch>;

  return {
    proxy: normalized,
    fetch: proxiedFetch,
    close: () => dispatcher.close(),
  };
}
