import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { McpClient } from '../src/mcp-client.js';

afterEach(() => vi.useRealTimers());

function stalledFetch() {
  return vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}

describe('MCP request lifetime', () => {
  it('aborts an in-flight request and removes the parent listener and deadline', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const fetchImpl = stalledFetch();
    const client = new McpClient('http://127.0.0.1/mcp', 'test', fetchImpl);
    const pending = client.initialize(20_000, parent.signal);
    const rejected = expect(pending).rejects.toThrow('cancelled');
    parent.abort(new Error('cancelled'));
    await rejected;
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out stalled I/O and disposes its resources', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const client = new McpClient('http://127.0.0.1/mcp', 'test', stalledFetch());
    const rejected = expect(client.initialize(100, parent.signal)).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accumulate abort listeners over 100 successful calls', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"result":{}}'));
    const client = new McpClient('http://127.0.0.1/mcp', 'test', fetchImpl);
    for (let i = 0; i < 100; i++) {
      await client.extractAndRemember('hello', undefined, 1000, parent.signal);
      expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts a request after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = stalledFetch();
    const client = new McpClient('http://127.0.0.1/mcp', 'test', fetchImpl);
    await expect(client.initialize(1000, controller.signal)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
