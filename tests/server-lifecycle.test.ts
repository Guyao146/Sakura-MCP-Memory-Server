import { once, getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestLifecycle, createShutdown } from '../src/lifecycle.js';
import { operationSignal, trackOperation } from '../src/operations.js';
import { providerRequest } from '../src/providers/request.js';

afterEach(() => vi.useRealTimers());
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const request = () => new Request('http://localhost/');

describe('HTTP request lifecycle', () => {
  it('bounds concurrent streams and releases slots and listeners after cancellation', async () => {
    const lifecycle = new RequestLifecycle(2); const parent = new AbortController();
    const cancel = vi.fn();
    const handler = vi.fn(() => new Response(new ReadableStream({ cancel })));
    const first = await lifecycle.handle(new Request('http://localhost/', { signal: parent.signal }), handler);
    const second = await lifecycle.handle(request(), handler);
    expect((await lifecycle.handle(request(), handler)).status).toBe(503);
    expect(handler).toHaveBeenCalledTimes(2);
    parent.abort();
    await expect(first.text()).rejects.toThrow();
    await second.body!.cancel(); await lifecycle.stop();
    expect(lifecycle.size).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    expect((await lifecycle.handle(request(), handler)).status).toBe(503);
  });

  it('retains a slot until detached MCP handlers and their finalizers finish', async () => {
    const lifecycle = new RequestLifecycle(); const finalizer = deferred();
    const started = deferred(); let signal!: AbortSignal;
    const response = await lifecycle.handle(request(), async () => {
      signal = operationSignal()!;
      void trackOperation(async () => {
        started.resolve();
        await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
        await finalizer.promise;
      });
      return new Response(new ReadableStream());
    });
    await started.promise;
    let stopped = false;
    const stopping = lifecycle.stop().then(() => { stopped = true; });
    await expect(response.text()).rejects.toThrow();
    expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
    expect(lifecycle.size).toBe(1);
    finalizer.resolve(); await stopping;
    expect(lifecycle.size).toBe(0);
  });

  it('cleans up thrown and bodyless responses', async () => {
    const lifecycle = new RequestLifecycle();
    await expect(lifecycle.handle(request(), async () => { throw new Error('oops'); })).rejects.toThrow('oops');
    await lifecycle.handle(request(), () => new Response(null, { status: 204 }));
    await lifecycle.stop(); expect(lifecycle.size).toBe(0);
  });
});

describe('real HTTP cleanup', () => {
  it('aborts a stalled upstream socket and drains the listening server', async () => {
    const upstreamSeen = deferred(); const upstreamClosed = deferred();
    const upstream = serve({ hostname: '127.0.0.1', port: 0, fetch: req => {
      upstreamSeen.resolve();
      return new Response(new ReadableStream({
        start(controller) {
          req.signal.addEventListener('abort', () => { upstreamClosed.resolve(); controller.close(); }, { once: true });
        },
        cancel() { upstreamClosed.resolve(); }
      }));
    } });
    await once(upstream, 'listening');
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const lifecycle = new RequestLifecycle();
    const server = serve({ hostname: '127.0.0.1', port: 0, fetch: req => lifecycle.handle(req, async () => {
      try { return new Response(await providerRequest(upstreamUrl, {}, 60_000, response => response.text())); }
      catch { return new Response(null, { status: 503 }); }
    }) });
    await once(server, 'listening');
    const database = { close: vi.fn(async () => { expect(lifecycle.size).toBe(0); }) };
    const shutdown = createShutdown(server, lifecycle, { stop: async () => undefined }, database, 2000);
    try {
      const pending = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      await upstreamSeen.promise;
      await expect(shutdown()).resolves.toBe(true);
      expect((await pending).status).toBe(503);
      await upstreamClosed.promise;
      expect(database.close).toHaveBeenCalledTimes(1);
      expect(server.listening).toBe(false);
    } finally {
      server.closeAllConnections(); server.close();
      upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});

describe('server shutdown', () => {
  it('is single-flight and closes PostgreSQL only after worker and requests drain', async () => {
    vi.useFakeTimers(); const pending = deferred();
    const server = { close: vi.fn(callback => callback()), closeAllConnections: vi.fn() };
    const worker = { stop: vi.fn(() => pending.promise) };
    const database = { close: vi.fn(async () => undefined) };
    const lifecycle = new RequestLifecycle();
    const shutdown = createShutdown(server, lifecycle, worker, database);
    const first = shutdown(); expect(shutdown()).toBe(first);
    expect(database.close).not.toHaveBeenCalled();
    pending.resolve(); await expect(first).resolves.toBe(true);
    expect(database.close).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forces sockets closed at the deadline without racing the database against active work', async () => {
    vi.useFakeTimers(); const pending = deferred();
    const server = { close: vi.fn(callback => callback()), closeAllConnections: vi.fn() };
    const database = { close: vi.fn(async () => undefined) };
    const shutdown = createShutdown(server, new RequestLifecycle(), { stop: () => pending.promise }, database, 100);
    const closing = shutdown(); await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe(false);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(database.close).not.toHaveBeenCalled();
    pending.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
