import { describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { adminPage } from '../src/web/admin-page.js';
import { loginPage } from '../src/web/login-page.js';
import { adminByGroup, DEFAULT_ADMIN_GROUPS, describeTokenExchangeFailure, WebSessionService, type WebIdentity } from '../src/web/session.js';

const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://localhost/test',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 15).toString('base64url'), MCP_API_KEYS: ''
});
const identity: WebIdentity = {
  sessionId: '10000000-0000-4000-8000-000000000001', userId: '20000000-0000-4000-8000-000000000002',
  subject: 'subject', email: 'user@example.com', displayName: 'User', avatarUrl: null, isSystemAdmin: false,
  expiresAt: new Date(Date.now() + 3600000).toISOString()
};

describe('Web management security', () => {
  it('signs the probe hint so the browser cannot forge an identity', () => {
    const service = new WebSessionService({} as never, () => config);
    const cookie = service.probeHintCookie('张三');
    // Displayed by the page script, so it must be readable, but it carries no
    // token and the value is only ever rendered as text.
    expect(cookie).toContain('sakura_login_hint=');
    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Path=/auth');
    expect(cookie).toContain('Max-Age=120');
    expect(cookie).toContain('Secure');
    const [value, signature] = cookie.slice('sakura_login_hint='.length).split(';')[0].split('.');
    expect(Buffer.from(value, 'base64url').toString('utf8')).toBe('张三');
    expect(signature).toBeTruthy();
    // A different name must not validate against the same signature.
    expect(service.probeHintCookie('李四')).not.toContain(signature);
    expect(service.clearProbeHintCookie()).toContain('Max-Age=0');
  });

  it('treats only standard OIDC "no session" errors as a probe miss', () => {
    for (const miss of ['login_required', 'interaction_required', 'consent_required', 'account_selection_required']) {
      expect(WebSessionService.isProbeMiss(miss)).toBe(true);
    }
    // Real configuration failures must not be silently swallowed as "not signed in".
    for (const failure of ['invalid_client', 'server_error', 'access_denied', undefined]) {
      expect(WebSessionService.isProbeMiss(failure)).toBe(false);
    }
  });

  it('binds CSRF tokens to the Web session and server key', () => {
    const service = new WebSessionService({} as never, () => config);
    const token = service.csrf(identity);
    expect(service.verifyCsrf(identity, token)).toBe(true);
    expect(service.verifyCsrf({ ...identity, sessionId: '30000000-0000-4000-8000-000000000003' }, token)).toBe(false);
    expect(service.verifyCsrf(identity, 'invalid')).toBe(false);
  });

  it('uses textContent for server data and does not template user identity into HTML', () => {
    expect(adminPage).toContain('textContent=x.summary');
    expect(adminPage).toContain("textContent=d.me.displayName");
    expect(adminPage).not.toContain('${identity.');
  });

  it('includes management views for spaces, memories, Agents and members', () => {
    for (const marker of ['记忆空间', '记忆管理', '冲突确认', '后台任务', '审计日志', 'Agent 密钥', '身份认证', '模型 Provider', 'AI 策略', '导入', '导出 JSON', 'inviteMember', 'grantAgent', 'saveStrategy', 'saveProvider', 'loadAuthentik', 'saveAuthentik', 'resolveConflict', 'importMemories', 'startRebuild', 'loadAudit']) {
      expect(adminPage).toContain(marker);
    }
  });

  it('provides an Authentik recovery form with mandatory validation', () => {
    for (const marker of ['/api/admin/authentik', 'Public Client + PKCE', '测试并保存', 'saveAuthentikButton',
      '签发者地址（Issuer）', '令牌受众（Audience）', '系统管理员邮箱']) expect(adminPage).toContain(marker);
  });

  it('provides a dedicated embedding provider form separate from chat', () => {
    for (const marker of ['独立向量服务（Embedding）', 'emBase', 'emKey', 'emModel', "saveProvider('embedding')"]) {
      expect(adminPage).toContain(marker);
    }
  });

  it('uses the root domain as the preferred MCP URL', () => {
    expect(adminPage).toContain("$('mcpUrl').textContent=location.origin");
    expect(adminPage).not.toContain("$('mcpUrl').textContent=location.origin+'/mcp'");
  });

  it('shows the running version and update controls', () => {
    for (const marker of ['当前版本', '版本更新', '检查更新', '/api/admin/version', 'headerVersion']) {
      expect(adminPage).toContain(marker);
    }
  });

  it('only declares JSON content for requests that have a body', () => {
    expect(adminPage).toContain("if(opt.body!==undefined)headers['Content-Type']='application/json'");
    expect(adminPage).toContain('raw.slice(0,500)');
  });

  it('shows an explicit warning and hides logout in no-auth mode', () => {
    expect(adminPage).toContain('AUTH=false：身份验证已关闭');
    expect(adminPage).toContain("$('authWarning').style.display=d.authEnabled?'none':'block'");
    expect(adminPage).toContain("$('logoutButton').style.display=d.authEnabled?'inline-block':'none'");
  });

  it('creates and caches a stable local system administrator identity', async () => {
    const client = { release: vi.fn(), query: vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: '20000000-0000-4000-8000-000000000002' }] })
      .mockResolvedValueOnce({ rows: [{ id: '30000000-0000-4000-8000-000000000003' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({}) };
    const database = { pool: { connect: vi.fn().mockResolvedValue(client) }, query: vi.fn().mockResolvedValue({}) };
    const disabled = loadConfig({ ...config as never, PUBLIC_BASE_URL: config.publicBaseUrl,
      DATABASE_URL: config.database.connectionString, CONFIG_ENCRYPTION_KEY: config.setup.encryptionKey,
      MCP_API_KEYS: '', AUTH: 'false' } as never);
    const service = new WebSessionService(database as never, () => disabled);
    const first = await service.localIdentity();
    const second = await service.localIdentity();
    expect(first).toMatchObject({ subject: 'local-admin', displayName: 'Local Administrator', isSystemAdmin: true });
    expect(second).toBe(first);
    expect(database.pool.connect).toHaveBeenCalledTimes(1);
    expect(database.query).toHaveBeenCalledWith('UPDATE users SET is_system_admin=true WHERE id=$1', [first.userId]);
  });

  it('performs RP-initiated logout so the Authentik SSO session also ends', () => {
    expect(adminPage).toContain("location=d.redirectTo||'/auth/login'");
    const authentik = {
      issuer: 'https://login.example.com/application/o/sakura-mcp/', audience: 'https://mcp.example.com',
      jwksUri: 'https://login.example.com/jwks/', scopeClaim: 'scope', clientId: 'client-id',
      authorizationUrl: 'https://login.example.com/authorize/', tokenUrl: 'https://login.example.com/token/',
      endSessionUrl: 'https://login.example.com/application/o/sakura-mcp/end-session/'
    };
    const service = new WebSessionService({} as never, () => ({ ...config, authentik }));
    const url = new URL(service.endSessionUrl()!);
    expect(url.origin + url.pathname).toBe('https://login.example.com/application/o/sakura-mcp/end-session/');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://mcp.example.com/auth/login');
  });

  it('derives the Authentik end-session URL and rejects unsafe return targets', () => {
    const authentik = {
      issuer: 'https://login.example.com/application/o/sakura-mcp', audience: 'https://mcp.example.com',
      jwksUri: 'https://login.example.com/jwks/', scopeClaim: 'scope', clientId: 'client-id',
      authorizationUrl: 'https://login.example.com/authorize/', tokenUrl: 'https://login.example.com/token/'
    };
    const service = new WebSessionService({} as never, () => ({ ...config, authentik }));
    const derived = new URL(service.endSessionUrl('https://evil.example.com/')!);
    expect(derived.pathname).toBe('/application/o/sakura-mcp/end-session/');
    expect(derived.searchParams.get('post_logout_redirect_uri')).toBe('https://mcp.example.com/auth/login');
    expect(new WebSessionService({} as never, () => config).endSessionUrl()).toBeUndefined();
  });

  it('renders a branded login landing page that never auto-starts the OIDC redirect', () => {
    for (const marker of ['使用 Authentik 登录', '本站使用 Authentik 单点登录', '/auth/start', 'id="notice"']) {
      expect(loginPage).toContain(marker);
    }
    expect(loginPage).not.toContain('${');
    expect(loginPage).not.toContain('location.href=');
    expect(loginPage).not.toContain('innerHTML');
    expect(loginPage).toContain("$('notice').textContent=notice");
  });

  it('offers "continue as" only from a probed session and keeps the name as text', () => {
    for (const marker of ['id="who"', 'id="whoName"', 'id="switchButton"', "params.get('probed')==='1'"]) {
      expect(loginPage).toContain(marker);
    }
    // The probed name is user-controlled, so it must never reach markup as HTML.
    expect(loginPage).toContain("$('whoName').textContent=hint");
    // Switching accounts has to bypass the existing SSO session.
    expect(loginPage).toContain("'&switch=1'");
  });

  it('appends the probe-cookie deletion instead of replacing the new login session cookie', () => {
    expect(indexSource).toContain("context.header('Set-Cookie', webSessions.clearProbeHintCookie(), { append: true })");
  });

  it('loads the shared self-hosted typeface for a consistent ecosystem look', () => {
    expect(loginPage).toContain('https://api.mcylyr.cn/obj/font/fonts.css');
    expect(loginPage).toContain("'Noto Sans SC',system-ui,sans-serif");
    expect(loginPage).toContain("'DM Mono',ui-monospace,monospace");
    // Fonts are the only third-party dependency: no external scripts or images.
    expect(loginPage).not.toContain('<script src=');
    expect(loginPage).not.toContain('fonts.googleapis.com');
  });

  it('supports light, dark and system themes without a flash on load', () => {
    for (const marker of ['data-theme-choice="light"', 'data-theme-choice="dark"', 'data-theme-choice="auto"',
      "localStorage.getItem('sakura-theme')", '[data-theme=dark]']) {
      expect(loginPage).toContain(marker);
    }
    // The theme is applied in <head>, before the body is parsed and painted.
    expect(loginPage.indexOf("document.documentElement.dataset.theme=d?'dark':'light'"))
      .toBeLessThan(loginPage.indexOf('<body>'));
  });

  it('keeps the login page return target on the local origin', () => {
    const script = loginPage.match(/<script>([\s\S]*?)<\/script>/g)?.pop()?.replace(/<\/?script>/g, '');
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
    expect(script).toContain("/^\\/(?!\\/)/.test(target)?target:'/admin'");
    expect(script).toContain("encodeURIComponent(safeTarget)");
    for (const reason of ['expired', 'logged_out', 'probe_failed']) expect(script).toContain(`${reason}:`);
  });

  it('grants system administration from configured Authentik groups', () => {
    const auth = { issuer: 'https://login.example.com', audience: 'mcp', jwksUri: 'https://login.example.com/jwks/',
      scopeClaim: 'scope', clientId: 'client-id', adminGroups: ['Sakura Admins'] };
    expect(adminByGroup({ groups: ['Users', 'sakura admins'] }, auth)).toBe(true);
    expect(adminByGroup({ groups: ['Users'] }, auth)).toBe(false);
    expect(adminByGroup({ groups: 'Users Sakura Admins' }, { ...auth, adminGroups: ['Users'] })).toBe(true);
    expect(adminByGroup({ groups: ['Sakura Admins'] }, { ...auth, groupsClaim: 'roles' })).toBeUndefined();
    expect(adminByGroup({ roles: ['Sakura Admins'] }, { ...auth, groupsClaim: 'roles' })).toBe(true);
  });

  it('treats Authentik superusers as system administrators without configuration', () => {
    const auth = { issuer: 'https://login.example.com', audience: 'mcp', jwksUri: 'https://login.example.com/jwks/',
      scopeClaim: 'scope', clientId: 'client-id' };
    expect(DEFAULT_ADMIN_GROUPS).toContain('authentik Admins');
    expect(adminByGroup({ groups: ['authentik Admins'] }, auth)).toBe(true);
    expect(adminByGroup({ groups: ['authentik admins'] }, auth)).toBe(true);
    // Without configuration a miss must not revoke manually granted administrators.
    expect(adminByGroup({ groups: ['Users'] }, auth)).toBeUndefined();
    // An explicit list replaces the built-in group and becomes authoritative.
    expect(adminByGroup({ groups: ['authentik Admins'] }, { ...auth, adminGroups: ['Sakura Admins'] })).toBe(false);
  });

  it('falls back to the allowlist when groups are unusable', () => {
    const auth = { issuer: 'https://login.example.com', audience: 'mcp', jwksUri: 'https://login.example.com/jwks/',
      scopeClaim: 'scope', clientId: 'client-id' };
    expect(adminByGroup({}, auth)).toBeUndefined();
    expect(adminByGroup({}, { ...auth, adminGroups: ['Sakura Admins'] })).toBeUndefined();
    expect(adminByGroup({ groups: [42] }, { ...auth, adminGroups: ['Sakura Admins'] })).toBe(false);
    expect(adminByGroup({ groups: [42] }, auth)).toBeUndefined();
  });

  it('requests the groups scope and exposes the admin group field', () => {
    for (const marker of ['akAdminGroups', '管理员用户组（可选，留空表示 authentik Admins）', 'akGroupList()']) {
      expect(adminPage).toContain(marker);
    }
  });

  it('shows Agent secrets on demand instead of only at creation time', () => {
    for (const marker of ['查看密钥', '隐藏密钥', 'revealAgent(', "'/api/admin/agents/'+id+'/reveal'",
      'a.revealable', '密钥（可随时在列表中再次查看）：']) {
      expect(adminPage).toContain(marker);
    }
    expect(adminPage).not.toContain('仅显示一次');
    expect(adminPage).toContain('box.textContent=d.token');
  });

  it('deletes Agent keys instead of leaving revoked rows behind', () => {
    for (const marker of ['deleteAgent(', "{method:'DELETE'}", '后密钥立即永久失效且无法恢复', 'Agent 已删除']) {
      expect(adminPage).toContain(marker);
    }
    expect(adminPage).not.toContain('revokeAgent');
    expect(adminPage).not.toContain("/revoke',{method:'POST'}");
  });

  it('shows a client session view with derived status labels', () => {
    for (const marker of ['data-view="clients"', 'loadClients()', '/api/admin/clients', 'clientStatusText',
      '上传记忆中', '已连接', '已断开', '空闲', 'clientAuto']) {
      expect(adminPage).toContain(marker);
    }
    // Client-supplied names must never be interpolated as HTML.
    expect(adminPage).toContain('title.textContent=c.client_name');
    expect(adminPage).not.toContain('innerHTML=c.');
  });

  it('contains syntactically valid browser JavaScript', () => {
    const script = adminPage.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Script(script!)).not.toThrow();
  });

  it('shows safe Authentik token endpoint errors with actionable guidance', async () => {
    const invalidClient = new Response(JSON.stringify({
      error: 'invalid_client', error_description: 'Client authentication failed', request_id: 'secret-request-id'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    const message = await describeTokenExchangeFailure(invalidClient);
    expect(message).toContain('invalid_client');
    expect(message).toContain('Client authentication failed');
    expect(message).toContain('客户端类型为 Public');
    expect(message).not.toContain('secret-request-id');

    const invalidGrant = await describeTokenExchangeFailure(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Code is invalid\n'
    }), { status: 400 }));
    expect(invalidGrant).toContain('/auth/callback');
    expect(invalidGrant).not.toContain('\n');
  });

  it('bounds and sanitizes non-JSON Authentik token errors', async () => {
    const message = await describeTokenExchangeFailure(new Response('bad\u0000\nresponse', { status: 502 }));
    expect(message).toBe('Authentik 令牌交换失败（HTTP 502）：bad response');
    const oversized = await describeTokenExchangeFailure(new Response('x', {
      status: 502, headers: { 'Content-Length': String(64 * 1024 + 1) }
    }));
    expect(oversized).toBe('Authentik 令牌交换失败（HTTP 502）。');
  });
});