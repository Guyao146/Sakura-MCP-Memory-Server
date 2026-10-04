import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/security/app.js';
import { readMcpBody } from '../src/mcp-routing.js';
import { loadConfig } from '../src/config.js';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { operationContext } from '../src/operations.js';
import { serve } from '@hono/node-server';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'), TRUST_PROXY: 'true',
  MAX_REQUEST_BODY_BYTES: '1024', RATE_LIMIT_MCP_PER_MINUTE: '1' });
const headers = { host: 'localhost', 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' };
afterEach(() => vi.restoreAllMocks());

describe('bounded lazy HTTP parsing', () => {
  it.each(['/mcp', '/', '/api/admin/spaces'])('does not parse rejected credentials on %s', async path => {
    const app = createHttpApp(config);
    app.post(path, c => c.json({ error: 'unauthorized' }, 401));
    const parse = vi.spyOn(JSON, 'parse');
    const response = await app.request(path, { method: 'POST', headers, body: '{bad json' });
    expect(response.status).toBe(401);
    // Vitest/Node can parse source maps lazily; count only this request body.
    expect(parse.mock.calls.filter(([text]) => text === '{bad json')).toHaveLength(0);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rejects Host, local Origin and rate limits before parsing', async () => {
    const app = createHttpApp(config);
    app.post('/mcp', c => c.text('ok'));
    const parse = vi.spyOn(JSON, 'parse');
    for (const extra of [{ host: 'evil.test' }, { origin: 'https://evil.test' }] as Record<string, string>[]) {
      expect((await app.request('/mcp', { method: 'POST', headers: { ...headers, ...extra }, body: '{}' })).status).toBe(403);
    }
    expect((await app.request('/mcp', { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect((await app.request('/mcp', { method: 'POST', headers, body: '{}' })).status).toBe(429);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([undefined, '2', '2048'])('enforces actual bytes with content-length %s', async length => {
    const app = createHttpApp(config);
    app.post('/mcp', async c => c.json(await c.req.json()));
    const parse = vi.spyOn(JSON, 'parse');
    const response = await app.request('/mcp', { method: 'POST',
      headers: { ...headers, ...(length ? { 'content-length': length } : {}) }, body: JSON.stringify('樱'.repeat(400)) });
    expect(response.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
  });

  it('accepts the exact byte boundary and parses once for admin handlers', async () => {
    const app = createHttpApp(config);
    app.post('/api/admin/spaces', async c => c.json(await c.req.json()));
    const body = '{"value":"' + 'a'.repeat(1012) + '"}';
    expect(Buffer.byteLength(body)).toBe(1024);
    const parse = vi.spyOn(JSON, 'parse');
    const response = await app.request('/api/admin/spaces', { method: 'POST', headers, body });
    expect(response.status).toBe(200);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(await response.text()).toBe(body);
  });

  it('passes one parsed MCP body through the actual SDK transport', async () => {
    const app = createHttpApp(config);
    const server = new McpServer({ name: 'parse-test', version: '1' });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    app.post('/mcp', async c => transport.handleRequest(c.req.raw, { parsedBody: await c.req.json() }));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const response = await app.request('/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
      expect(response.status).toBe(200);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(await response.text()).toContain('parse-test');
    } finally { await transport.close(); await server.close(); }
  });

  it('answers malformed JSON with the SDK Parse Error and skips parsing other content types', async () => {
    const app = createHttpApp({ ...config, security: { ...config.security, mcpPerMinute: 10 } });
    const handler = vi.fn(async (c: import('hono').Context) => {
      const body = await readMcpBody(c);
      if (body instanceof Response) return body;
      return c.json({ parsed: body === undefined ? null : body });
    });
    app.post('/mcp', handler);
    const response = await app.request('/mcp', { method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' }, body: '{bad json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: Invalid JSON' }, id: null });
    // A non-JSON POST is left untouched for the transport to handle itself.
    const other = await app.request('/mcp', { method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain' }, body: 'not json' });
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ parsed: null });
  });

  it('rejects compressed bodies rather than permitting a decompression bypass', async () => {
    const app = createHttpApp(config);
    const response = await app.request('/mcp', { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: 'compressed' });
    expect(response.status).toBe(415);
  });

  it('enforces limits on a real Node HTTP chunked request without trusting proxy headers', async () => {
    const app = createHttpApp({ ...config, publicBaseUrl: 'http://127.0.0.1',
      security: { ...config.security, trustProxy: false, mcpPerMinute: 2 } });
    const handler = vi.fn(async (c: import('hono').Context) => c.json(await c.req.json()));
    app.post('/mcp', handler);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TCP address');
    try {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(Buffer.from('"' + 'a'.repeat(700)));
        controller.enqueue(Buffer.from('b'.repeat(700) + '"')); controller.close();
      } });
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers,
        body, duplex: 'half' } as RequestInit);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: 'payload_too_large' });
      expect(handler).not.toHaveBeenCalled();
      const accepted = await fetch(`http://127.0.0.1:${address.port}/mcp`, { method: 'POST', headers, body: '{"ok":true}' });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('rejects public browser writes over real Node HTTP before entering the handler', async () => {
    // Real fetch overwrites the forbidden Host header with the actual target, so
    // align the configured public host as a deployment behind a proxy would.
    const app = createHttpApp({ ...config, host: '0.0.0.0', publicBaseUrl: 'http://127.0.0.1',
      security: { ...config.security, trustProxy: false, authPerMinute: 100 } });
    const handler = vi.fn(async (c: import('hono').Context) => c.json(await c.req.json()));
    app.post('/auth/local', handler);
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing TCP address');
    const target = `http://127.0.0.1:${address.port}/auth/local`;
    try {
      const crossSite = await fetch(target, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' });
      expect(crossSite.status).toBe(403); await crossSite.text();
      const sameSite = await fetch(target, { method: 'POST', headers: { ...headers, origin: 'http://localhost:9999' }, body: '{}' });
      expect(sameSite.status).toBe(403); await sameSite.text();
      const simple = await fetch(target, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: '{}' });
      expect(simple.status).toBe(415); await simple.text();
      expect(handler).not.toHaveBeenCalled();
      const sameOrigin = await fetch(target, { method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1' }, body: '{"ok":true}' });
      expect(sameOrigin.status).toBe(200);
      expect(await sameOrigin.json()).toEqual({ ok: true });
      expect(handler).toHaveBeenCalledOnce();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('cancels a stalled upload when the application operation is aborted', async () => {
    const app = createHttpApp(config);
    app.onError((_error, c) => c.text('cancelled', 499 as ContentfulStatusCode));
    const cancel = vi.fn(); const controller = new AbortController();
    let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
    const body = new ReadableStream<Uint8Array>({ pull() { started(); }, cancel });
    const request = new Request('http://localhost/mcp', { method: 'POST', headers, body, duplex: 'half' } as RequestInit);
    const response = operationContext.run({ signal: controller.signal, pending: new Set() }, () => app.fetch(request));
    await reading; controller.abort();
    expect((await response).status).toBe(499);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
