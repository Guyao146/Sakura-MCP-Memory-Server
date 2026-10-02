import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { RequestLifecycle } from '../src/lifecycle.js';
import { operationContext, operationSignal, trackOperation } from '../src/operations.js';
import { streamWithDeferredCleanup } from '../src/mcp-routing.js';

it.each(['http', 'mcp'] as const)('inherits %s cancellation without losing detached handler tracking', async source => {
  const parent = new AbortController(); const mcp = new AbortController();
  const context = { signal: parent.signal, pending: new Set<Promise<unknown>>() };
  let active!: AbortSignal;
  const pending = operationContext.run(context, () => trackOperation(async () => {
    active = operationSignal()!;
    await new Promise<void>(resolve => active.addEventListener('abort', () => resolve(), { once: true }));
  }, undefined, mcp.signal));
  await Promise.resolve();
  expect(context.pending.size).toBe(1);
  (source === 'http' ? parent : mcp).abort();
  await pending;
  expect(active.aborted).toBe(true);
  expect(context.pending.size).toBe(0);
});

it('drains real MCP SSE handlers and transport cleanup after HTTP cancellation', async () => {
  const lifecycle = new RequestLifecycle();
  const parent = new AbortController();
  let started!: () => void; const running = new Promise<void>(resolve => { started = resolve; });
  let upstream!: AbortSignal; let finalized = false; let closed = 0;
  const request = new Request('http://localhost/mcp', {
    method: 'POST', signal: parent.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'stalled', arguments: {} } })
  });
  const response = await lifecycle.handle(request, async req => {
    const server = new McpServer({ name: 'lifecycle-test', version: '1.0.0' });
    server.registerTool('stalled', { inputSchema: {} }, () => trackOperation(async () => {
      upstream = operationSignal()!;
      started();
      await new Promise<void>(resolve => upstream.addEventListener('abort', () => resolve(), { once: true }));
      finalized = true;
      return { content: [{ type: 'text', text: 'cancelled' }] };
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const context = operationContext.getStore();
    await server.connect(transport);
    const result = await transport.handleRequest(req);
    return streamWithDeferredCleanup(result, () => trackOperation(async () => {
      await transport.close(); await server.close(); closed += 1;
    }, context), operationSignal());
  });
  expect(response.status).toBe(200);
  try {
    await running;
    parent.abort(new Error('client gone'));
    await expect(response.text()).rejects.toThrow('client gone');
    await lifecycle.stop();
    expect(upstream.aborted).toBe(true);
    expect(finalized).toBe(true);
    expect(closed).toBe(1);
    expect(lifecycle.size).toBe(0);
  } finally { parent.abort(); await lifecycle.stop(); }
});
