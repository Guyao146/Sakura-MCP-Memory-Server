import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { AuthService } from '../src/auth.js';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { loadConfig, type OidcProvider } from '../src/config.js';
import { WebSessionService, browserLoginConfigured, primaryOidcProvider } from '../src/web/session.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { oidcSubject } from '../src/security/oidc.js';

// Local assertions use the same hashing primitives as production PKCE.
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'review', alg: 'RS256', use: 'sig' };
let origin = '';
const tokens = new Map<string, string>();
const exchanges: URLSearchParams[] = [];
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/jwks.json') { res.end(JSON.stringify({ keys: [jwk] })); return; }
  if (req.url === '/token') {
    let body = ''; for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body); exchanges.push(params);
    const token = tokens.get(params.get('code') || '');
    if (!token) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return; }
    res.end(JSON.stringify({ id_token: token })); return;
  }
  res.statusCode = 404; res.end('{}');
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
afterEach(() => { vi.restoreAllMocks(); tokens.clear(); exchanges.length = 0; });

function fixture() {
  const config = loadConfig({ PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://unused',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
  const provider = { issuer: origin, audience: 'client', clientId: 'client', jwksUri: `${origin}/jwks.json`,
    authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, scopeClaim: 'scope' };
  config.sakura = { ...provider }; config.authentik = { ...provider };
  const attempts = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, args: any[] = []) => {
    if (sql.includes('INSERT INTO oidc_login_attempts')) attempts.set(args[0], {
      code_verifier: args[1], nonce: args[2], return_to: args[3], purpose: args[4], binding: args[5], provider: args[6]
    });
    if (sql.includes('RETURNING code_verifier')) {
      const row = attempts.get(args[0]);
      if (row && (!args[1] || row.purpose === args[1]) && row.binding === args[2]) {
        attempts.delete(args[0]); return { rows: [row] };
      }
    }
    return { rows: [] };
  });
  const service = new WebSessionService({ query, pool: { connect: async () => ({ query, release() {} }) } } as never, () => config);
  const ensure = vi.spyOn(MemoryRepository.prototype, 'ensureUser').mockResolvedValue({ userId: 'user', personalSpaceId: 'space' });
  async function login(providerName: OidcProvider, claims: JWTPayload = {}) {
    const attempt = await service.begin('/admin', 'login', providerName);
    const url = new URL(attempt.url); const state = url.searchParams.get('state')!;
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: origin, aud: 'client', sub: 'same-sub', iat: now, exp: now + 600,
      nonce: url.searchParams.get('nonce'), ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'review' }).sign(keys.privateKey);
    tokens.set(state, token);
    return { state, token, authorization: url, cookie: attempt.cookie.split(';')[0], result: () => service.callback(state, state, attempt.cookie.split(';')[0]) };
  }
  return { config, service, query, ensure, login };
}

describe('real signed OIDC callback regression', () => {
  it('isolates identical subjects and ignores unverified Sakura email and Authentik groups', async () => {
    const f = fixture();
    const a = await f.login('authentik'); await a.result();
    expect(f.ensure.mock.calls[0][0]).toBe('same-sub');
    const s = await f.login('sakura', { email: 'admin@example.com', email_verified: false, groups: ['authentik Admins'] });
    expect(await s.result()).toMatchObject({ authSource: 'sakura', returnTo: '/admin' });
    expect(f.ensure.mock.calls[1]).toEqual([oidcSubject('sakura', origin, 'same-sub'),
      { displayName: 'same-sub', email: undefined, adminByGroup: undefined }]);
    expect(createHash('sha256').update(exchanges[1].get('code_verifier')!).digest('base64url'))
      .toBe(s.authorization.searchParams.get('code_challenge'));
    expect(s.authorization.searchParams.get('code_challenge_method')).toBe('S256');
    await expect(s.result()).rejects.toThrow('state');
    expect(exchanges).toHaveLength(2);
  });

  it('uses explicitly configured Sakura groups and rejects unsupported probes', async () => {
    const f = fixture(); f.config.sakura!.adminGroups = ['MCP Admins'];
    await (await f.login('sakura', { groups: ['MCP Admins'] })).result();
    expect(f.ensure.mock.calls[0][1]?.adminByGroup).toBe(true);
    await (await f.login('sakura', { groups: ['Users'] })).result();
    expect(f.ensure.mock.calls[1][1]?.adminByGroup).toBe(false);
    await (await f.login('sakura')).result();
    expect(f.ensure.mock.calls[2][1]?.adminByGroup).toBe(false);
    await expect(f.service.begin('/admin', 'probe', 'sakura')).rejects.toThrow('silent');
  });

  it('preserves legacy Authentik subjects but rejects local namespaces', async () => {
    const f = fixture();
    for (const sub of ['local-admin', 'local:admin', 'sakura:any']) {
      await expect((await f.login('authentik', { sub })).result()).rejects.toThrow('reserved');
    }
    expect(f.ensure).not.toHaveBeenCalled();
    expect(oidcSubject('sakura', origin, 'same')).not.toBe(oidcSubject('sakura', 'https://other.example', 'same'));
  });

  it('reports only complete browser configurations and respects AUTH=false', () => {
    const f = fixture();
    expect(primaryOidcProvider(f.config)).toBe('sakura');
    f.config.sakura!.tokenUrl = undefined;
    expect(browserLoginConfigured(f.config, 'sakura')).toBe(false);
    expect(primaryOidcProvider(f.config)).toBe('authentik');
    f.config.authEnabled = false;
    expect(primaryOidcProvider(f.config)).toBeUndefined();
  });

  it.each([false, undefined, 'true', true])('accepts Sakura email only with boolean verification: %s', async verified => {
    const f = fixture(); await (await f.login('sakura', { email: 'owner@example.com', email_verified: verified })).result();
    expect(f.ensure.mock.calls[0][1]?.email).toBe(verified === true ? 'owner@example.com' : undefined);
  });

  it('rejects a forged signature before creating an identity', async () => {
    const f = fixture(); const s = await f.login('sakura');
    const parts = s.token.split('.'); parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    tokens.set(s.state, parts.join('.'));
    await expect(s.result()).rejects.toThrow(); expect(f.ensure).not.toHaveBeenCalled();
  });

  it('guards reserved subjects in the Authentik Bearer path and never accepts Sakura-only Bearer', async () => {
    const f = fixture(); const auth = new AuthService(f.config);
    for (const sub of ['local-admin', 'local:owner', 'sakura:any']) {
      const s = await f.login('authentik', { sub });
      await expect(auth.authenticate(`Bearer ${s.token}`)).rejects.toThrow('reserved');
    }
    const valid = await f.login('authentik', { scope: 'memory:read' });
    await expect(auth.authenticate(`Bearer ${valid.token}`)).resolves.toMatchObject({ id: 'same-sub', source: 'authentik' });
    await expect(new AuthService({ ...f.config, authentik: undefined }).authenticate(`Bearer ${valid.token}`)).rejects.toThrow('Invalid credential');
  });

  it('rejects unknown, disabled and incomplete browser providers before storing attempts', async () => {
    const f = fixture();
    await expect(f.service.begin('/admin', 'login', 'unknown' as OidcProvider)).rejects.toThrow();
    f.config.sakura!.tokenUrl = undefined;
    await expect(f.service.begin('/admin', 'login', 'sakura')).rejects.toThrow();
    f.config.authEnabled = false;
    await expect(f.service.begin('/admin', 'login', 'authentik')).rejects.toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });

  it('does not attach RP logout parameters to Sakura or redirect local logout', () => {
    const f = fixture(); f.config.sakura!.endSessionUrl = `${origin}/logout`;
    expect(f.service.endSessionUrl('/auth/login', 'sakura')).toBe(`${origin}/logout`);
    expect(f.service.endSessionUrl('/auth/login', 'local')).toBeUndefined();
  });

  it('accepts multiple audiences only when azp binds the configured client', async () => {
    const f = fixture();
    await expect((await f.login('sakura', { aud: ['client', 'other'], azp: 'client' })).result()).resolves.toMatchObject({ authSource: 'sakura' });
  });

  it.each([{ azp: 'other-client' }, { aud: ['client', 'other'] }, { nonce: 'wrong' }, { iss: 'https://wrong.example' }, { aud: 'wrong' }, { exp: 1 }, { exp: undefined }, { iat: undefined }, { sub: undefined }])(
    'rejects invalid claims before provisioning: %j', async claims => {
      const f = fixture(); const s = await f.login('sakura', claims);
      await expect(s.result()).rejects.toThrow(); expect(f.ensure).not.toHaveBeenCalled();
    });
});
