import type { Context } from 'hono';
import { isJsonContentType } from '@modelcontextprotocol/server';

export function isRootMcpRequest(method: string, headers: Headers): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD') return true;
  const accept = headers.get('accept')?.toLowerCase() ?? '';
  if (accept.includes('text/html')) return false;
  if (headers.has('authorization') || headers.has('mcp-protocol-version') || headers.has('mcp-session-id')) return true;
  return accept.includes('text/event-stream');
}
/**
 * Reads the buffered JSON-RPC body once, so neither this layer nor the SDK
 * parses it again. Malformed JSON is answered with the same JSON-RPC Parse
 * Error (-32700) the SDK produces, instead of a plain-text 400. The returned
 * `Response` must short-circuit the request.
 */
export async function readMcpBody(context: Context): Promise<unknown> {
  if (context.req.method !== 'POST' || !isJsonContentType(context.req.header('content-type'))) return undefined;
  try { return await context.req.json(); }
  catch { return context.json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null }, 400); }
}

/**
 * Wraps a streaming Response so that `cleanup` runs only after the body has
 * fully flushed, errored, or been cancelled by the client — never before the
 * first byte is written. The MCP SSE transport resolves its Response as soon as
 * the object exists while the body keeps streaming, so closing the transport
 * eagerly (in a `finally`) tore the stream down and clients saw an empty stream
 * that timed out. Non-streaming responses run cleanup immediately.
 */
export function streamWithDeferredCleanup(response: Response, cleanup: () => Promise<void>, signal?: AbortSignal): Response {
  let completion: Promise<void> | undefined;
  let ended = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const reader = response.body?.getReader();
  const runOnce = () => completion ??= Promise.resolve().then(cleanup).catch(() => undefined);
  const finish = async (reason?: unknown, cancel = false) => {
    if (ended) { await runOnce(); return; }
    ended = true;
    signal?.removeEventListener('abort', abort);
    // Start cleanup even if an upstream cancel implementation never resolves.
    const cleaned = runOnce();
    try { if (cancel) await reader?.cancel(reason).catch(() => undefined); }
    finally { reader?.releaseLock(); }
    await cleaned;
  };
  const abort = () => {
    if (!ended) output?.error(signal?.reason);
    void finish(signal?.reason, true);
  };
  if (!reader) { void finish(); return response; }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (ended) return;
        if (done) { controller.close(); await finish(); }
        else controller.enqueue(value);
      } catch (error) {
        if (!ended) controller.error(error);
        await finish();
      }
    },
    async cancel(reason) { await finish(reason, true); }
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
