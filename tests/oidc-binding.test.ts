import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { safeReturnPath, WebSessionService } from '../src/web/session.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(provider: 'authentik' | 'sakura' = 'authentik') {
  const rows = new Map<string, { binding: string; purpose: string; provider: string }>();
  const query = vi.fn(async (sql: string, args: string[] = []) => {
    if (sql.includes('INSERT INTO oidc_login_attempts')) rows.set(args[0], { binding: args[5], purpose: args[4], provider: args[6] });
    if (sql.includes('RETURNING code_verifier')) {
      const row = rows.get(args[0]);
      if (row && row.binding === args[2] && (!args[1] || row.purpose === args[1])) {
        rows.delete(args[0]);
        return { rows: [{ purpose: row.purpose, provider: row.provider }] };
      }
    }
    return { rows: [] };
  });
  const config = loadConfig({ PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://unused',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
  config.authentik = { issuer: 'https://idp.example.com', audience: 'client', jwksUri: 'https://idp.example.com/jwks',
    scopeClaim: 'scope', clientId: 'client', authorizationUrl: 'https://idp.example.com/authorize', tokenUrl: 'https://idp.example.com/token' };
  config.sakura = { issuer: 'https://sakura.example.com', audience: 'sakura-client', jwksUri: 'https://sakura.example.com/jwks',
    scopeClaim: 'groups', clientId: 'sakura-client', authorizationUrl: 'https://sakura.example.com/authorize', tokenUrl: 'https://sakura.example.com/token' };
  const service = new WebSessionService({ query, pool: { connect: async () => ({ query, release() {} }) } } as never, () => config);
  return { service, rows, query, config, provider };
}

afterEach(() => vi.unstubAllGlobals());
describe('OIDC browser binding', () => {
  it.each(['login', 'probe'] as const)('binds %s code exchange and rejects purpose mismatch/replay before fetch', async purpose => {
    const { service } = fixture();
    const attempt = await service.begin('/admin', purpose);
    const state = new URL(attempt.url).searchParams.get('state')!;
    const cookie = attempt.cookie.split(';')[0];
    const exchange = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    vi.stubGlobal('fetch', exchange);
    const callback = purpose === 'login' ? service.callback.bind(service) : service.probeCallback.bind(service);
    const wrongPurpose = purpose === 'login' ? service.probeCallback.bind(service) : service.callback.bind(service);
    await expect(callback('code', state)).rejects.toThrow('binding');
    await expect(callback('code', state, cookie.replace(/=.*/, `=${'x'.repeat(43)}`))).rejects.toThrow('state');
    await expect(wrongPurpose('code', state, cookie)).rejects.toThrow('state');
    expect(exchange).not.toHaveBeenCalled();
    await expect(callback('code', state, cookie)).rejects.toThrow('invalid_grant');
    expect(exchange).toHaveBeenCalledTimes(1);
    await expect(callback('code', state, cookie)).rejects.toThrow('state');
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('requires an independent HttpOnly binding, not state copied from the URL', async () => {
    const { service, rows } = fixture();
    const attempt = await service.begin('/admin');
    const state = new URL(attempt.url).searchParams.get('state')!;
    expect(attempt.cookie).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    const cookie = attempt.cookie.split(';')[0];
    expect(cookie).not.toContain(`=${state}`);
    await expect(service.callback('code', state)).rejects.toThrow('binding');
    await expect(service.probeCallback('code', state)).rejects.toThrow('binding');
    await expect(service.failedCallback(state, cookie.replace(/=.*/, `=${'x'.repeat(43)}`))).rejects.toThrow('state');
    expect(rows.has(hash(state))).toBe(true);
    await expect(service.failedCallback(state, cookie)).resolves.toBe('login');
    await expect(service.failedCallback(state, cookie)).rejects.toThrow('state');
    expect(service.clearLoginCookie(state)).toContain('Max-Age=0');
  });

  it('supports multiple tabs without overwriting a pending transaction', async () => {
    const { service } = fixture();
    const a = await service.begin('/admin', 'probe');
    const b = await service.begin('/admin');
    const cookies = [a.cookie.split(';')[0], b.cookie.split(';')[0]].join('; ');
    await expect(service.failedCallback(new URL(a.url).searchParams.get('state')!, cookies)).resolves.toBe('probe');
    await expect(service.failedCallback(new URL(b.url).searchParams.get('state')!, cookies)).resolves.toBe('login');
  });

  it('targets the configured provider per login and never probes SakuraID with prompt=none', async () => {
    const { service, query } = fixture('sakura');
    const login = await service.begin('/admin', 'login', 'sakura');
    const loginUrl = new URL(login.url);
    expect(loginUrl.searchParams.get('client_id')).toBe('sakura-client');
    // SakuraID exposes groups through the standard `groups` scope, so it must be
    // requested for the claim to appear in the ID Token.
    expect(loginUrl.searchParams.get('scope')).toContain('groups');
    // Its authorize endpoint renders a login page instead of answering
    // `prompt=none`, so the login must not ask it to stay silent.
    expect(loginUrl.searchParams.get('prompt')).toBeNull();
    expect(query.mock.calls[0][1][6]).toBe('sakura');
    const probe = await service.begin('/admin', 'probe', 'authentik');
    expect(new URL(probe.url).searchParams.get('prompt')).toBe('none');
    await expect(service.begin('/admin', 'login', 'sakura')).resolves.toBeTruthy();
    // A provider without any configuration cannot be started.
    const partial = loadConfig({ PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://unused',
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
    const unconfigured = new WebSessionService({ query, pool: { connect: async () => ({ query, release() {} }) } } as never, () => partial);
    await expect(unconfigured.begin('/admin', 'login', 'sakura')).rejects.toThrow('Sakura browser login is not configured');
  });

  it.each(['//evil.example', '/\\evil.example', '/\n/evil.example', '/a/..//evil.example', 'https://evil.example'])('rejects unsafe return target %j', path => {
    expect(safeReturnPath(path, 'https://mcp.example.com')).toBe('/admin');
  });
  it('preserves same-origin query parameters', () => {
    expect(safeReturnPath('/admin?tab=memory#item', 'https://mcp.example.com')).toBe('/admin?tab=memory#item');
  });
});
