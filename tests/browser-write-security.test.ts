import { describe, expect, it, vi } from 'vitest';
import { createHttpApp } from '../src/security/app.js';
import { loadConfig } from '../src/config.js';

const origin = 'https://mcp.example.com';
const config = loadConfig({ PUBLIC_BASE_URL: origin, HOST: '0.0.0.0', DATABASE_URL: 'postgresql://unused',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'), TRUST_PROXY: 'true' });
const headers = { host: 'mcp.example.com', 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1' };

function fixture(path: string) {
  const app = createHttpApp(config);
  const handler = vi.fn(async (context: import('hono').Context) => context.json(await context.req.json()));
  app.post(path, handler);
  return { app, handler };
}

describe('public JSON write origin protection', () => {
  it.each(['/auth/local', '/api/setup/complete', '/api/setup/test-provider'])('blocks cross-origin JSON and simple submissions on %s', async path => {
    const f = fixture(path);
    const rejected: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'https://sub.mcp.example.com' },
      { origin: 'null' }, { origin: origin + ':444' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }];
    for (const extra of rejected) {
      const response = await f.app.request(origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: '{}' });
      expect(response.status).toBe(403);
    }
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const response = await f.app.request(origin + path, { method: 'POST', headers: { ...headers, 'content-type': type }, body: '{}' });
      expect(response.status).toBe(415);
    }
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['/auth/local', '/api/setup/complete'])('accepts same-origin browser and JSON command-line clients on %s', async path => {
    const f = fixture(path);
    const accepted: Record<string, string>[] = [{}, { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json; charset=utf-8' }];
    for (const extra of accepted) {
      const response = await f.app.request(origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: '{"ok":true}' });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
  });

  it('uses the configured public origin behind TLS termination', async () => {
    const f = fixture('/auth/local');
    const response = await f.app.request('http://internal:3001/auth/local', { method: 'POST',
      headers: { ...headers, origin, 'sec-fetch-site': 'same-origin' }, body: '{}' });
    expect(response.status).toBe(200);
  });

  it('does not change safe GET requests or MCP Bearer transport', async () => {
    const app = createHttpApp(config);
    app.get('/api/setup/status', c => c.json({ completed: false }));
    app.post('/mcp', c => c.text('MCP'));
    expect((await app.request(origin + '/api/setup/status', { headers })).status).toBe(200);
    expect((await app.request(origin + '/mcp', { method: 'POST', headers: { ...headers, origin: 'https://client.example' }, body: '{}' })).status).toBe(200);
  });
});
