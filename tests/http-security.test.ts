import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { RateLimiter, securityHeaders, attachmentHeader } from '../src/security/http.js';

describe('HTTP production security', () => {
  it.each(['记忆空间-😀.json', 'a"\r\nb.json', 'broken\ud800.json'])('encodes a portable download header for %j', async filename => {
    const app = new Hono();
    app.get('/export', context => {
      context.header('Content-Disposition', attachmentHeader(filename));
      return context.text('export');
    });
    const response = await app.request('/export');
    expect(response.status).toBe(200);
    const header = response.headers.get('content-disposition')!;
    expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/);
    expect(header).not.toMatch(/[\r\n\u0080-\uffff]/);
    expect(decodeURIComponent(header.split("UTF-8''")[1])).toBe(Buffer.from(filename.replace(/[\r\n]/g, ''), 'utf8').toString('utf8'));
  });


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