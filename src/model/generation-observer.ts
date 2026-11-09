/** Observe HTTP receipts without replacing Pi's streaming protocol or persisting credentials. */
export function observeGenerationModel(fetcher: typeof fetch, observe: (patch: {
  sent_model?: string; response_model?: string; request_id?: string; request_count?: number;
  usage?: { input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };
}) => void): typeof fetch {
  let requests = 0;
  return async (input, init) => {
    let sentModel: string | undefined;
    try { if (typeof init?.body === 'string') { const body = JSON.parse(init.body); if (typeof body.model === 'string') sentModel = body.model; } } catch {}
    observe({ request_count: ++requests, ...(sentModel ? { sent_model: sentModel } : {}) });
    const response = await fetcher(input, init);
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    if (requestId) observe({ request_id: requestId.slice(0, 200) });
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const decoder = new TextDecoder(); let buffer = '', observedModel = '', observedId = requestId ?? '';
    const inspect = (line: string) => {
      if (!line.startsWith('data:')) return;
      try {
        const value = JSON.parse(line.slice(5));
        if (typeof value.model === 'string' && value.model !== observedModel) { observedModel = value.model; observe({ response_model: value.model.slice(0, 200) }); }
        if (!requestId && typeof value.id === 'string' && value.id !== observedId) { observedId = value.id; observe({ request_id: value.id.slice(0, 200) }); }
        if (value.usage && typeof value.usage === 'object') {
          const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
          observe({ usage: { input_tokens: number(value.usage.prompt_tokens), output_tokens: number(value.usage.completion_tokens), total_tokens: number(value.usage.total_tokens) } });
        }
      } catch { /* Non-JSON events remain Pi's responsibility. */ }
    };
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk); buffer += decoder.decode(chunk, { stream: true });
        let end: number; while ((end = buffer.indexOf('\n')) >= 0) { inspect(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
        if (buffer.length > 2 * 1024 * 1024) buffer = '';
      },
      flush() { buffer += decoder.decode(); if (buffer) inspect(buffer); },
    }));
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
