import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { panelHtml } from '../src/gui-page.js';

afterEach(() => vi.useRealTimers());

describe('browser polling lifetime', () => {
  it('does not pile up polls and releases pending requests and timers on pagehide', async () => {
    vi.useFakeTimers();
    const events = new Map<string, (event?: unknown) => void>();
    const pending: Array<{ signal: AbortSignal; resolve: (response: unknown) => void }> = [];
    const fetchImpl = vi.fn((_path, options) => new Promise((resolve, reject) => {
      pending.push({ signal: options.signal, resolve });
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const elements = new Map();
    const context = {
      URLSearchParams, AbortController, setTimeout, clearTimeout, fetch: fetchImpl,
      location: { search: '?token=test' },
      window: { addEventListener: (name: string, callback: (event?: unknown) => void) => events.set(name, callback) },
      document: { getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, { textContent: '', className: '' });
        return elements.get(id);
      } }
    };
    runInNewContext(panelHtml.match(/<script>([\s\S]*?)<\/script>/)![1], context);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // Initial status and inventory.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // No poll while initial status is stalled.
    pending[0].resolve({ ok: false, json: async () => ({ error: 'offline' }) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    events.get('pagehide')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.slice(1).every(item => item.signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(runInNewContext('requests.size', context)).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // A browser back/forward-cache restore must resume, not permanently freeze the panel.
    events.get('pageshow')!({ persisted: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    events.get('pagehide')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
