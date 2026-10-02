import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { providerRequest } from '../src/providers/request.js';
import { operationContext } from '../src/operations.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const providers = [new OpenAICompatibleProvider('http://unused', undefined, 'chat', 'embed'), new OllamaProvider('http://unused', 'chat', 'embed')];

describe('Provider request lifetime', () => {
  it.each(providers)('cancels embedding and extraction for %s', async provider => {
    vi.useFakeTimers();
    for (const call of [() => provider.embed(['x']), () => provider.extractMemories('x')]) {
      const parent = new AbortController();
      let upstream!: AbortSignal;
      vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
        upstream = init.signal;
        upstream.addEventListener('abort', () => reject(upstream.reason), { once: true });
      })));
      const pending = operationContext.run({ signal: parent.signal, pending: new Set() }, call);
      const rejected = expect(pending).rejects.toThrow('cancelled');
      parent.abort(new Error('cancelled'));
      await rejected;
      expect(upstream.aborted).toBe(true);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('disposes all listeners/deadlines over 100 successful calls', async () => {
    vi.useFakeTimers(); const parent = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"data":[{"index":0,"embedding":[1]}]}')));
    for (let i = 0; i < 100; i++) await providers[0].embed(['x'], undefined, parent.signal);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline active during a stalled response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true }); }
    }))));
    const pending = providerRequest('http://unused', {}, 100, response => response.json());
    const rejected = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels unconsumed error bodies and never starts pre-cancelled requests', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    await expect(providers[1].embed(['x'])).rejects.toThrow('500');
    expect(cancel).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(providers[0].embed(['x'], undefined, controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
