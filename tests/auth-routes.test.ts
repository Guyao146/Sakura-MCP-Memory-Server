import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { WebSessionService } from '../src/web/session.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SetupService } from '../src/setup/service.js';
import { oidcSubject } from '../src/security/oidc.js';
import { loginDatabase } from './helpers/login-database.js';
import { hiddenInputs, IdpBrowser, startSakura } from './helpers/sakura-process.js';

const state = vi.hoisted(() => ({ config: undefined as unknown as AppConfig,
  backend: undefined as unknown as Awaited<ReturnType<typeof loginDatabase>>,
  fetch: undefined as unknown as (r: Request, env: object) => Promise<Response>, completed: true }));
vi.mock('../src/config.js', async original => ({ ...await original<object>(), loadConfig: () => state.config }));
vi.mock('../src/database.js', () => ({ Database: class {
  pool = { connect: () => state.backend.database.pool.connect() };
  query(sql: string, args?: unknown[]) { return state.backend.query(sql, args); }
  async close() {}
} }));
vi.mock('../src/settings/repository.js', () => ({ SettingsRepository: class {
  async apply() { return state.config; }
  async installation() { return { completed: state.completed }; }
} }));
vi.mock('../src/audit.js', () => ({ AuditLogger: class { async record() {} } }));
vi.mock('@hono/node-server', () => ({ serve: (options: { fetch: typeof state.fetch }) => {
  state.fetch = options.fetch;
  return { close(callback: () => void) { callback(); }, closeAllConnections() {} };
} }));

const origin = 'http://localhost:3001';
const provider = (name: string) => ({ issuer: `https://${name}.example`, audience: 'client', clientId: 'client',
  jwksUri: `https://${name}.example/jwks.json`, authorizationUrl: `https://${name}.example/authorize`,
  tokenUrl: `https://${name}.example/token`, scopeClaim: 'scope' });
let defaults: AppConfig;
const signals = new Map<string, Function[]>();
beforeAll(async () => {
  const { loadConfig } = await vi.importActual<typeof import('../src/config.js')>('../src/config.js');
  defaults = loadConfig({ PUBLIC_BASE_URL: origin, HOST: '0.0.0.0', DATABASE_URL: 'postgresql://unused',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('base64url'), WORKER_ENABLED: 'false', AUTO_MIGRATE: 'false',
    LOG_LEVEL: 'fatal', RATE_LIMIT_AUTH_PER_MINUTE: '1000' });
  state.config = { ...defaults }; state.backend = await loginDatabase();
  vi.spyOn(MemoryRepository.prototype, 'ensureUser').mockImplementation((...args) => state.backend.ensureUser(...args));
  for (const name of ['SIGINT', 'SIGTERM']) signals.set(name, process.listeners(name));
  await import('../src/index.js'); // Exercise registered production routes, not copies.
});
beforeEach(async () => {
  Object.assign(state.config, defaults, { authentik: undefined, sakura: undefined });
  state.completed = true;
  state.backend = await loginDatabase();
});
afterAll(() => {
  for (const [name, previous] of signals) for (const listener of process.listeners(name)) {
    if (!previous.includes(listener)) process.removeListener(name, listener);
  }
  vi.restoreAllMocks();
});
async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set('Host', new URL(origin).host);
  const response = await state.fetch(new Request(new URL(path, origin), { ...init, headers }),
    { incoming: { socket: { remoteAddress: '127.0.0.1', remotePort: 12345, remoteFamily: 'IPv4' } } });
  // Drain the real request lifecycle even when a test only inspects headers.
  const body = await response.text();
  return new Response(body, { status: response.status, headers: response.headers });
}

describe('application authentication routes', () => {
  it.skipIf(!process.env.SAKURA_AUTH_SOURCE)('exchanges a real Sakura authorization code and confirms upstream logout in an isolated IdP', async () => {
    const idp = await startSakura(process.env.SAKURA_AUTH_SOURCE!, `${origin}/auth/callback`);
    try {
      const setup = new SetupService(true, origin, state.backend.database, {} as never);
      const discovered = await setup.discoverSakura({ baseUrl: idp.origin });
      state.config.sakura = { ...discovered, audience: idp.clientId, clientId: idp.clientId,
        scopeClaim: 'groups', groupsClaim: 'groups', adminGroups: ['MCP-Admins'] };
      await expect(setup.testSakura({ ...state.config.sakura, clientId: idp.clientId,
        authorizationUrl: discovered.authorizationUrl, tokenUrl: discovered.tokenUrl, groupsClaim: 'groups' }))
        .resolves.toMatchObject({ publicClient: true, signingKeys: 1 });
      const start = await request('/auth/start?provider=sakura&return_to=/admin');
      expect(start.status).toBe(302);
      const binding = start.headers.getSetCookie().find(c => c.startsWith('sakura_oidc_'))!.split(';')[0];
      const authorization = new URL(start.headers.get('location')!);
      expect(authorization.searchParams.get('prompt')).toBeNull();
      const browser = new IdpBrowser(idp.origin);
      const unauthenticated = await browser.request(authorization.href);
      expect(unauthenticated.status).toBe(302);
      const loginForm = await browser.request(unauthenticated.headers.get('location')!);
      const loginFields = hiddenInputs(await loginForm.text());
      const rejectedLogin = await browser.request('/login', { ...loginFields, username: 'integration-owner', password: 'wrong-password' });
      expect(rejectedLogin.status).toBe(401);
      const login = await browser.request('/login', { ...loginFields, username: 'integration-owner', password: 'idp-password-123' });
      expect(login.status).toBe(302);
      const consent = await browser.request(login.headers.get('location')!);
      expect(consent.status).toBe(200);
      const consentFields = hiddenInputs(await consent.text());
      expect((await browser.request('/authorize', { ...consentFields, _csrf: 'wrong', decision: 'approve' })).status).toBe(403);
      const approved = await browser.request('/authorize', { ...consentFields, decision: 'approve', remember: 'on' });
      expect(approved.status).toBe(302);
      const callback = new URL(approved.headers.get('location')!);
      expect(callback.origin).toBe(origin);
      expect(callback.searchParams.get('state')).toBe(authorization.searchParams.get('state'));
      // An attacker without the initiating browser's cookie cannot consume the code.
      expect((await request(callback.pathname + callback.search)).status).toBe(401);
      const result = await request(callback.pathname + callback.search, { headers: { Cookie: binding } });
      expect(result.status).toBe(302); expect(result.headers.get('location')).toBe('/admin');
      const cookie = result.headers.getSetCookie().find(c => c.startsWith('sakura_session='))!.split(';')[0];
      expect(result.headers.getSetCookie().filter(c => c.includes('Max-Age=0'))).toHaveLength(2);
      const profile = await (await request('/api/me', { headers: { Cookie: cookie } })).json();
      expect(profile).toMatchObject({ authSource: 'sakura', displayName: 'Integration Owner', email: null, isSystemAdmin: true });
      expect(state.backend.ensureUser).toHaveBeenCalledWith(oidcSubject('sakura', idp.origin, idp.subject),
        { email: undefined, displayName: 'Integration Owner', adminByGroup: true, allowAdminByEmail: false });
      expect((await request(callback.pathname + callback.search, { headers: { Cookie: binding } })).status).toBe(401);
      const sessions = new WebSessionService(state.backend.database, () => state.config);
      const identity = await sessions.authenticate(WebSessionService.readCookie(cookie));
      const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': sessions.csrf(identity) } });
      expect(await logout.json()).toEqual({ loggedOut: true, redirectTo: `${idp.origin}/logout` });
      expect((await request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
      const confirmation = await browser.request('/logout');
      expect(confirmation.status).toBe(200);
      // Merely visiting GET /logout must not terminate the upstream SSO session.
      expect((await browser.request('/login')).status).toBe(302);
      const confirmed = await browser.request('/logout', hiddenInputs(await confirmation.text()));
      expect(confirmed.status).toBe(302);
      expect((await browser.request('/login')).status).toBe(200);
    } finally { await idp.stop(); }
    await idp.stop(); // Cleanup is idempotent and the disposable listener is gone.
    await expect(fetch(`${idp.origin}/healthz`, { signal: AbortSignal.timeout(500) })).rejects.toThrow();
  }, 30_000);

  it('probes only Authentik-only login and honours logout and account switching', async () => {
    state.config.localLogin = { enabled: false }; state.config.authentik = provider('authentik');
    const probe = await request('/auth/login');
    expect(new URL(probe.headers.get('location')!).searchParams.get('prompt')).toBe('none');
    expect((await request('/auth/login?reason=logged_out')).status).toBe(200);
    const switched = await request('/auth/start?provider=authentik&switch=1');
    expect(new URL(switched.headers.get('location')!).searchParams.get('prompt')).toBe('select_account');
    state.config.sakura = provider('sakura');
    expect((await request('/auth/login')).status).toBe(200);
  });

  it('announces only Authentik for MCP OAuth resource metadata', async () => {
    state.config.sakura = provider('sakura');
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect((await request(path)).status).toBe(404);
      state.config.authentik = provider('authentik');
      expect(await (await request(path)).json()).toMatchObject({ authorization_servers: ['https://authentik.example'] });
      state.config.authentik = undefined;
    }
  });

  it('does not permit login before installation or when AUTH=false', async () => {
    state.completed = false;
    expect((await request('/auth/start?provider=sakura')).headers.get('location')).toBe('/setup');
    state.completed = true; state.config.authEnabled = false; state.config.localLogin = { enabled: false };
    expect((await request('/auth/login')).headers.get('location')).toBe('/admin');
    expect(await (await request('/auth/modes')).json()).toMatchObject({ local: false, oidc: false, provider: null });
    expect((await request('/auth/local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it.each<Record<string, string>>([
    { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
    { Origin: 'http://localhost:9999', 'Content-Type': 'application/json' },
    { Origin: 'null', 'Content-Type': 'application/json' },
    { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
    { 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json' }
  ])('rejects cross-origin login before checking credentials: %j', async headers => {
    const response = await request('/auth/local', { method: 'POST', headers,
      body: JSON.stringify({ username: 'owner', password: 'local-password-123' }) });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(state.backend.sessions.size).toBe(0);
    expect(state.backend.query).not.toHaveBeenCalled();
  });

  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])('rejects simple login submissions (%s)', async type => {
    const response = await request('/auth/local', { method: 'POST', headers: { 'Content-Type': type },
      body: JSON.stringify({ username: 'owner', password: 'local-password-123' }) });
    expect(response.status).toBe(415);
    expect(state.backend.sessions.size).toBe(0);
    expect(state.backend.query).not.toHaveBeenCalled();
  });

  it('accepts same-origin browser login with a JSON charset', async () => {
    const response = await request('/auth/local', { method: 'POST', headers: {
      Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=UTF-8'
    }, body: JSON.stringify({ username: 'owner', password: 'local-password-123' }) });
    expect(response.status).toBe(200);
    expect(state.backend.sessions.size).toBe(1);
  });

  it('authenticates local credentials, binds logout to CSRF and revokes the session', async () => {
    const response = await request('/auth/local', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: 'local-password-123', return_to: '//evil.example' }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ redirectTo: '/admin' });
    const cookie = response.headers.getSetCookie()[0].split(';')[0];
    expect(await (await request('/api/me', { headers: { Cookie: cookie } })).json()).toMatchObject({ authSource: 'local', isSystemAdmin: true });
    const service = new WebSessionService(state.backend.database, () => state.config);
    const identity = await service.authenticate(WebSessionService.readCookie(cookie));
    expect((await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403);
    const logout = await request('/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': service.csrf(identity) } });
    expect(await logout.json()).toEqual({ loggedOut: true, redirectTo: '/auth/login?reason=logged_out' });
    expect((await request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('protects session management with CSRF and ownership checks', async () => {
    const web = new WebSessionService(state.backend.database, () => state.config);
    const first = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    const second = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    state.backend.users.set('other', { subject: 'other', displayName: 'Other', email: null, admin: false });
    const foreign = await web.issueSession('other', '/admin', 'sakura');
    const identity = await web.authenticate(first.token); const foreignIdentity = await web.authenticate(foreign.token);
    const headers = { Cookie: web.cookie(first.token), 'X-CSRF-Token': web.csrf(identity) };
    const list = await (await request('/api/me/sessions', { headers })).json() as { sessions: Array<{ id: string; current: boolean }> };
    expect(list.sessions).toHaveLength(2); expect(list.sessions.filter(s => s.current)).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/token_hash|sess_|other/);
    expect((await request('/api/me/sessions/revoke-others', { method: 'POST', headers: { Cookie: headers.Cookie } })).status).toBe(403);
    expect((await request('/api/me/sessions/' + foreignIdentity.sessionId, { method: 'DELETE', headers })).status).toBe(200);
    await expect(web.authenticate(foreign.token)).resolves.toBeTruthy();
    expect((await request('/api/me/sessions/revoke-others', { method: 'POST', headers })).status).toBe(200);
    await expect(web.authenticate(second.token)).rejects.toThrow('revoked');
    await expect(web.authenticate(first.token)).resolves.toBeTruthy();
    await expect(web.authenticate(foreign.token)).resolves.toBeTruthy();
    const out = await request('/api/me/sessions/' + identity.sessionId, { method: 'DELETE', headers });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(web.authenticate(first.token)).rejects.toThrow('revoked');
  });

  it('changes the local password through the production route and clears all local sessions', async () => {
    const web = new WebSessionService(state.backend.database, () => state.config);
    const s = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    const identity = await web.authenticate(s.token);
    const headers = { Cookie: web.cookie(s.token), 'Content-Type': 'application/json', 'X-CSRF-Token': web.csrf(identity) };
    const body = JSON.stringify({ currentPassword: 'local-password-123', newPassword: 'new-password-123' });
    expect((await request('/api/me/password', { method: 'POST', headers: { Cookie: headers.Cookie }, body })).status).toBe(403);
    const r = await request('/api/me/password', { method: 'POST', headers, body });
    expect(r.status).toBe(200); expect(r.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await r.json()).toEqual({ changed: true, redirectTo: '/auth/local-login' });
    expect((await request('/api/me', { headers })).status).toBe(401);
    const login = (password: string) => request('/auth/local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'OWNER', password }) });
    expect((await login('local-password-123')).status).toBe(400);
    expect((await login('new-password-123')).status).toBe(200);
  });

  it('denies non-admin account operations and rejects deletion/demotion of the last admin', async () => {
    const web = new WebSessionService(state.backend.database, () => state.config);
    const s = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    const identity = await web.authenticate(s.token);
    const headers = { Cookie: web.cookie(s.token), 'Content-Type': 'application/json', 'X-CSRF-Token': web.csrf(identity) };
    for (const method of ['DELETE', 'PATCH']) {
      const r = await request('/api/admin/local-users/OWNER', { method, headers, body: method === 'PATCH' ? JSON.stringify({ isSystemAdmin: false }) : undefined });
      expect(r.status).toBe(400); expect(await r.text()).toContain('最后一个可用');
    }
    state.backend.users.get('local-user')!.admin = false;
    for (const [method, path] of [['GET', ''], ['POST', ''], ['PUT', '/owner'], ['PATCH', '/owner'], ['DELETE', '/owner'], ['POST', '/owner/unlock']]) {
      const r = await request('/api/admin/local-users' + path, { method, headers, body: method === 'GET' ? undefined : '{}' });
      expect(r.status).toBe(400); expect(await r.text()).toContain('administrator permission');
    }
  });

  it('lists camelCase accounts, unlocks them and revokes sessions on administrative password reset', async () => {
    const web = new WebSessionService(state.backend.database, () => state.config);
    const s = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    const identity = await web.authenticate(s.token);
    const headers = { Cookie: web.cookie(s.token), 'Content-Type': 'application/json', 'X-CSRF-Token': web.csrf(identity) };
    expect(await (await request('/api/admin/local-users', { headers })).json()).toMatchObject({ users: [{ userId: 'local-user', isSystemAdmin: true, failedAttempts: 0 }] });
    state.backend.credential.failed = 5; state.backend.credential.lockedUntil = new Date(Date.now() + 60_000);
    expect((await request('/api/admin/local-users/OWNER/unlock', { method: 'POST', headers })).status).toBe(200);
    expect(state.backend.credential.failed).toBe(0);
    const r = await request('/api/admin/local-users/OWNER', { method: 'PUT', headers, body: JSON.stringify({ password: 'reset-password-123' }) });
    expect(r.status).toBe(200);
    expect((await request('/api/me', { headers })).status).toBe(401);
  });

  it('allows an external administrator to delete local credentials without affecting their own session', async () => {
    const web = new WebSessionService(state.backend.database, () => state.config);
    const local = await web.issueSession('local-user', '/admin', 'local', state.backend.credential.version);
    state.backend.users.get('local-user')!.admin = false;
    state.backend.users.set('external-admin', { subject: 'sakura:issuer:admin', displayName: 'Admin', email: null, admin: true });
    const external = await web.issueSession('external-admin', '/admin', 'sakura');
    const identity = await web.authenticate(external.token);
    const headers = { Cookie: web.cookie(external.token), 'X-CSRF-Token': web.csrf(identity) };
    expect((await request('/api/admin/local-users/owner', { method: 'DELETE', headers })).status).toBe(200);
    await expect(web.authenticate(local.token)).rejects.toThrow('revoked');
    await expect(web.authenticate(external.token)).resolves.toMatchObject({ authSource: 'sakura' });
    expect(state.backend.users.has('local-user')).toBe(true);
    expect((await request('/api/me/password', { method: 'POST', headers, body: '{}' })).status).toBe(400);
  });

  it('keeps mixed login explicit and reports all three enabled methods', async () => {
    state.config.authentik = provider('authentik'); state.config.sakura = provider('sakura');
    const response = await request('/auth/login');
    expect(response.status).toBe(200); expect(response.headers.get('location')).toBeNull();
    expect(await response.text()).toContain('localLoginLink');
    expect(await (await request('/auth/modes')).json()).toEqual({ local: true, oidc: true, provider: 'sakura', sakura: true, authentik: true });
  });

  it.each(['unknown', '', 'authentik', 'sakura'])('rejects unavailable explicit provider %j before creating an attempt', async selected => {
    const count = state.backend.attempts.size;
    expect((await request(`/auth/start?provider=${selected}`)).status).toBe(400);
    expect(state.backend.attempts.size).toBe(count);
  });

  it('rejects incomplete providers instead of falling back to another enabled provider', async () => {
    state.config.authentik = provider('authentik'); state.config.sakura = { ...provider('sakura'), tokenUrl: undefined };
    expect((await request('/auth/start?provider=sakura')).status).toBe(400);
    expect(await (await request('/auth/modes')).json()).toMatchObject({ provider: 'authentik', sakura: false });
  });
});
