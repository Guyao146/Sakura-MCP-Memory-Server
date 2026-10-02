import { describe, expect, it, vi } from 'vitest';
import { isRootMcpRequest, streamWithDeferredCleanup } from '../src/mcp-routing.js';

describe('root MCP and browser routing', () => {
  it('keeps ordinary browser navigation on the Web entry point', () => {
    expect(isRootMcpRequest('GET', new Headers({ Accept: 'text/html,application/xhtml+xml' }))).toBe(false);
    expect(isRootMcpRequest('GET', new Headers({ Accept: '*/*' }))).toBe(false);
    expect(isRootMcpRequest('HEAD', new Headers())).toBe(false);
  });

  it('routes MCP request methods and headers to the root MCP endpoint', () => {
    expect(isRootMcpRequest('POST', new Headers({ 'Content-Type': 'application/json' }))).toBe(true);
    expect(isRootMcpRequest('DELETE', new Headers())).toBe(true);
    expect(isRootMcpRequest('GET', new Headers({ Accept: 'text/event-stream' }))).toBe(true);
    expect(isRootMcpRequest('GET', new Headers({ Authorization: 'Bearer test' }))).toBe(true);
    expect(isRootMcpRequest('GET', new Headers({ 'MCP-Protocol-Version': '2025-06-18' }))).toBe(true);
    expect(isRootMcpRequest('GET', new Headers({ 'Mcp-Session-Id': 'session' }))).toBe(true);
  });

  it('prefers browser navigation when HTML and event streams are both accepted', () => {
    expect(isRootMcpRequest('GET', new Headers({ Accept: 'text/html,text/event-stream' }))).toBe(false);
    expect(isRootMcpRequest('GET', new Headers({ Accept: 'text/html', Authorization: 'Bearer proxy-session' }))).toBe(false);
  });
});

describe('deferred MCP stream cleanup', () => {
  it('streams the whole SSE body before cleaning up the transport', async () => {
    const cleanup = vi.fn(async () => undefined);
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\n'));
        controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
        controller.close();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

    const wrapped = streamWithDeferredCleanup(source, cleanup);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get('Content-Type')).toBe('text/event-stream');
    // Cleanup must not fire until the body is drained.
    expect(cleanup).not.toHaveBeenCalled();

    const body = await wrapped.text();
    expect(body).toContain('data: {"ok":true}');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans an unread stalled stream on abort and releases the source lock', async () => {
    const controller = new AbortController(); const cleanup = vi.fn(async () => undefined);
    const cancelled = vi.fn();
    const source = new Response(new ReadableStream({ cancel: cancelled }));
    const wrapped = streamWithDeferredCleanup(source, cleanup, controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(wrapped.text()).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(source.body!.locked).toBe(false));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup immediately for a body-less response', async () => {
    const cleanup = vi.fn(async () => undefined);
    const wrapped = streamWithDeferredCleanup(new Response(null, { status: 202 }), cleanup);
    expect(wrapped.status).toBe(202);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cleans up once when the client cancels the stream', async () => {
    const cleanup = vi.fn(async () => undefined);
    const source = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode('data: chunk\n\n')); }
    }), { status: 200 });
    const wrapped = streamWithDeferredCleanup(source, cleanup);
    const reader = wrapped.body!.getReader();
    await reader.read();
    await reader.cancel('client gone');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});