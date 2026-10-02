import { afterEach, describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { ConfigCipher } from '../src/settings/crypto.js';
import { setupPage, setupScript } from '../src/setup/page.js';
import { SetupService } from '../src/setup/service.js';
import { SettingsRepository } from '../src/settings/repository.js';

const key = Buffer.alloc(32, 7).toString('base64url');
afterEach(() => vi.unstubAllGlobals());

describe('installation security', () => {
  it('encrypts configuration with authenticated AES-256-GCM', () => {
    const cipher = new ConfigCipher(key);
    const envelope = cipher.encrypt({ apiKey: 'never-plaintext' });
    expect(JSON.stringify(envelope)).not.toContain('never-plaintext');
    expect(cipher.decrypt(envelope)).toEqual({ apiKey: 'never-plaintext' });
  });

  it('rejects decryption with a different configuration key', () => {
    const envelope = new ConfigCipher(key).encrypt({ secret: true });
    expect(() => new ConfigCipher(Buffer.alloc(32, 8).toString('base64url')).decrypt(envelope)).toThrow();
  });

  it('loads a token-free CSP-compatible setup script and checks automatically', () => {
    expect(setupPage).toContain('<script src="/assets/setup.js" defer></script>');
    expect(setupPage).not.toMatch(/\son(?:click|change)=/);
    expect(setupPage).not.toContain('setupToken');
    expect(setupScript).not.toContain('X-Setup-Token');
    expect(setupScript).toContain("headers:body?{'Content-Type':'application/json'}:undefined");
    expect(setupScript).toContain('raw.slice(0,500)');
    expect(setupScript).toContain("$('diagnoseButton').addEventListener('click',diagnose)");
    expect(setupScript).toContain('else{void diagnose()}');
    expect(setupScript).toContain('go(authEnabled?1:2)');
    expect(setupScript).toContain("const auth=authEnabled?");
    expect(setupScript).toContain('go(authEnabled?1:0)');
    expect(setupPage).toContain('AUTH=false');
    expect(setupPage).toContain('authApplicationSlug');
    expect(setupPage).toContain('获取 OpenID 配置');
    for (const label of ['签发者地址（Issuer）', '令牌受众（Audience）', '客户端 ID（公共客户端 + PKCE）',
      '签名密钥地址（JWKS URI）', '授权地址', '令牌地址', '用户信息地址（可选）', '登出地址（End Session，可选）', '管理员用户组（可选，留空表示 authentik Admins）', '权限范围字段（Scope Claim）']) {
      expect(setupPage).toContain(label);
    }
    expect(setupPage).not.toContain('<label>Issuer</label>');
    expect(setupPage).not.toContain('<label>Audience</label>');
    expect(setupPage).toContain('embeddingBase');
    expect(setupPage).toContain('embeddingSameSite');
    expect(setupPage).toContain('同一服务（同站配置）');
    expect(setupScript).toContain("$('embeddingSameSite').checked");
    expect(setupScript).toContain("api('discover-authentik',{baseUrl,applicationSlug})");
    expect(setupScript).toContain('setTimeout(()=>void discoverAuthentik(false),600)');
    expect(setupScript).toContain('requestId!==discoveryRequestId');
    expect(setupScript).toContain("MCP URL：'+location.origin");
    expect(setupScript).toContain("兼容地址：'+location.origin+'/mcp'");
    for (const field of ['issuer','jwksUri','authorizationUrl','tokenUrl','userinfoUrl','endSessionUrl']) {
      expect(setupScript).toContain(`$('${field}').value=data.${field}`);
    }
    expect(setupScript).toContain("'HTTP '+response.status");
    expect(() => new Script(setupScript)).not.toThrow();
  });

  it('requires Authentik only when authentication is enabled', async () => {
    const settings = { complete: async () => undefined };
    await expect(new SetupService(true, 'https://mcp.example.com', {} as never, settings as never).complete({})).rejects.toThrow('AUTH=true');
    await expect(new SetupService(false, 'https://mcp.example.com', {} as never, settings as never).complete({})).resolves.toBeUndefined();
  });

  it('accepts a local admin account in place of Authentik', async () => {
    let saved: unknown;
    const settings = { complete: async (input: unknown) => { saved = input; } };
    const service = new SetupService(true, 'https://mcp.example.com', {} as never, settings as never);
    await service.complete({ localAdmin: { username: 'admin', password: 'very-secret-123' } });
    expect(saved).toMatchObject({ localAdmin: { username: 'admin', password: 'very-secret-123' } });
  });

  it('keeps local admin credentials out of the stored Authentik settings', async () => {
    let saved: unknown;
    const settings = { complete: async (input: unknown) => { saved = input; } };
    const service = new SetupService(false, 'https://mcp.example.com', {} as never, settings as never);
    await service.complete({ localAdmin: { username: 'admin', password: 'very-secret-123' }, ollama: { baseUrl: 'http://ollama:11434' } });
    expect(saved).toEqual({ openaiCompatible: undefined, ollama: { baseUrl: 'http://ollama:11434' } });
  });

  it('removes Authentik fields before completing no-auth setup', async () => {
    let saved: unknown;
    const settings = { complete: async (input: unknown) => { saved = input; } };
    const service = new SetupService(false, 'https://mcp.example.com', {} as never, settings as never);
    await service.complete({
      administratorEmail: 'ignored@example.com',
      authentik: {
        issuer: 'https://login.example.com', audience: 'mcp', jwksUri: 'https://login.example.com/jwks',
        scopeClaim: 'scope', clientId: 'ignored', authorizationUrl: 'https://login.example.com/authorize',
        tokenUrl: 'https://login.example.com/token'
      },
      ollama: { baseUrl: 'http://ollama:11434' }
    });
    expect(saved).toEqual({ openaiCompatible: undefined, ollama: { baseUrl: 'http://ollama:11434' } });
  });

  it('discovers and validates Authentik OpenID configuration', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: 'https://login.example.com/application/o/sakura-mcp/',
      authorization_endpoint: 'https://login.example.com/application/o/authorize/',
      token_endpoint: 'https://login.example.com/application/o/token/',
      jwks_uri: 'https://login.example.com/application/o/sakura-mcp/jwks/',
      userinfo_endpoint: 'https://login.example.com/application/o/userinfo/',
      end_session_endpoint: 'https://login.example.com/application/o/sakura-mcp/end-session/'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const service = new SetupService(true, 'https://mcp.example.com', {} as never, {} as never);
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura-mcp' }))
      .resolves.toMatchObject({
        issuer: 'https://login.example.com/application/o/sakura-mcp/',
        jwksUri: 'https://login.example.com/application/o/sakura-mcp/jwks/',
        authorizationUrl: 'https://login.example.com/application/o/authorize/',
        tokenUrl: 'https://login.example.com/application/o/token/',
        userinfoUrl: 'https://login.example.com/application/o/userinfo/',
        endSessionUrl: 'https://login.example.com/application/o/sakura-mcp/end-session/'
      });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://login.example.com/application/o/sakura-mcp/.well-known/openid-configuration'),
      expect.objectContaining({ redirect: 'error', headers: { Accept: 'application/json' } })
    );
  });

  it('rejects unsafe, cross-origin, and disabled Authentik discovery', async () => {
    const enabled = new SetupService(true, 'https://mcp.example.com', {} as never, {} as never);
    await expect(enabled.discoverAuthentik({ baseUrl: 'http://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('HTTPS origin');
    await expect(enabled.discoverAuthentik({ baseUrl: 'https://login.example.com/path', applicationSlug: 'sakura' }))
      .rejects.toThrow('HTTPS origin');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: 'https://evil.example.com/application/o/sakura/',
      authorization_endpoint: 'https://login.example.com/application/o/authorize/',
      token_endpoint: 'https://login.example.com/application/o/token/',
      jwks_uri: 'https://login.example.com/application/o/sakura/jwks/'
    }), { status: 200 })));
    await expect(enabled.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('cross-origin');
    await expect(new SetupService(false, 'https://mcp.example.com', {} as never, {} as never)
      .discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('AUTH=false');
  });

  it('rejects malformed, failed, and oversized discovery responses', async () => {
    const service = new SetupService(true, 'https://mcp.example.com', {} as never, {} as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream error', { status: 502 })));
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('(502)');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not-json', { status: 200 })));
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('not valid JSON');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('x', {
      status: 200, headers: { 'Content-Length': '1000001' }
    })));
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: 'sakura' }))
      .rejects.toThrow('too large');
    await expect(service.discoverAuthentik({ baseUrl: 'https://login.example.com', applicationSlug: '../admin' }))
      .rejects.toThrow('slug');
  });

  it('accepts only a Public Client during Authentik preflight', async () => {
    const authentik = {
      issuer: 'https://login.example.com/application/o/sakura/', audience: 'https://mcp.example.com',
      jwksUri: 'https://login.example.com/application/o/sakura/jwks/', scopeClaim: 'scope', clientId: 'public-client',
      authorizationUrl: 'https://login.example.com/application/o/authorize/',
      tokenUrl: 'https://login.example.com/application/o/token/'
    };
    const metadata = () => new Response(JSON.stringify({ issuer: authentik.issuer,
      authorization_endpoint: authentik.authorizationUrl, token_endpoint: authentik.tokenUrl }), { status: 200 });
    const jwks = () => new Response(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'test' }] }), { status: 200 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(metadata()).mockResolvedValueOnce(jwks())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code is invalid' }), { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new SetupService(true, 'https://mcp.example.com', {} as never, {} as never);
    await expect(service.testAuthentik(authentik)).resolves.toMatchObject({ publicClient: true, signingKeys: 1 });
    const tokenCall = fetcher.mock.calls[2];
    expect(tokenCall[0]).toBe(authentik.tokenUrl);
    const body = tokenCall[1]?.body as URLSearchParams;
    expect(body.get('client_id')).toBe('public-client');
    expect(body.get('redirect_uri')).toBe('https://mcp.example.com/auth/callback');
    expect(body.get('code_verifier')).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(metadata()).mockResolvedValueOnce(jwks())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_client',
        error_description: 'Client authentication failed', request_id: 'must-not-leak' }), { status: 400 })));
    let failure: unknown;
    try { await service.testAuthentik(authentik); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('客户端类型改为 Public');
    expect((failure as Error).message).not.toContain('must-not-leak');
  });

  it('saves Authentik recovery configuration transactionally', async () => {
    const client = { release: vi.fn(), query: vi.fn().mockResolvedValue({ rows: [] }) };
    const database = { pool: { connect: vi.fn().mockResolvedValue(client) } };
    const repository = new SettingsRepository(database as never, key);
    const value = { issuer: 'https://login.example.com/application/o/sakura/', audience: 'mcp',
      jwksUri: 'https://login.example.com/jwks/', scopeClaim: 'scope', clientId: 'client',
      authorizationUrl: 'https://login.example.com/authorize', tokenUrl: 'https://login.example.com/token' };
    await repository.saveAuthentik(value, 'Admin@Example.com');
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("VALUES('authentik',$1,false)"), [value]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('system_admin_allowlist'), ['Admin@Example.com']);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('does not enable stored Authentik configuration while AUTH=false', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ completed: true }] })
      .mockResolvedValue({ rows: [] });
    const repository = new SettingsRepository({ query } as never, key);
    const applied = await repository.apply({ authEnabled: false, authentik: {
      issuer: 'https://login.example.com/application/o/sakura/', audience: 'mcp',
      jwksUri: 'https://login.example.com/jwks/', scopeClaim: 'scope', clientId: 'client',
      authorizationUrl: 'https://login.example.com/authorize', tokenUrl: 'https://login.example.com/token'
    } } as never);
    expect(applied.authEnabled).toBe(false);
    expect(applied.authentik).toBeUndefined();
    expect(query).not.toHaveBeenCalledWith(expect.any(String), ['authentik']);
  });
});