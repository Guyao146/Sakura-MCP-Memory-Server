import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RateLimiter, securityHeaders } from '../src/security/http.js';

describe('HTTP production security', () => {
  it('adds browser hardening headers', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/admin', context => context.html('<h1>Admin</h1>'));
    const response = await app.request('https://mcp.example.com/admin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps styles and fonts first-party', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/auth/login', context => context.html('<h1>Login</h1>'));
    const policy = (await app.request('https://mcp.example.com/auth/login')).headers.get('content-security-policy') ?? '';
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("script-src 'self' 'unsafe-inline';");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('script-src \'self\' \'unsafe-inline\' https://api.mcylyr.cn');
  });

  it('returns standard rate limit headers and 429', async () => {
    const app = new Hono();
    const limiter = new RateLimiter(60_000);
    app.use('/api/*', limiter.middleware('test', 2, true));
    app.get('/api/data', context => context.json({ ok: true }));
    const headers = { 'X-Forwarded-For': '203.0.113.10' };
    expect((await app.request('/api/data', { headers })).status).toBe(200);
    const second = await app.request('/api/data', { headers });
    expect(second.headers.get('ratelimit-remaining')).toBe('0');
    const limited = await app.request('/api/data', { headers });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    await expect(limited.json()).resolves.toMatchObject({ error: 'rate_limited' });
  });

  it('keeps trusted proxy clients in separate buckets', async () => {
    const app = new Hono();
    const limiter = new RateLimiter(60_000);
    app.use('*', limiter.middleware('proxy', 1, true));
    app.get('/', context => context.text('ok'));
    expect((await app.request('/', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'X-Forwarded-For': '198.51.100.2' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'X-Forwarded-For': '198.51.100.1' } })).status).toBe(429);
  });
});