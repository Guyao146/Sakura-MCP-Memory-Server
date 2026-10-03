import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  PUBLIC_BASE_URL: 'https://mcp.example.com',
  DATABASE_URL: 'postgresql://sakura:test@localhost:5432/sakura_memory',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  MCP_API_KEYS: 'agent:very-secret:memory:read|memory:write'
};

describe('loadConfig', () => {
  it('loads complete browser environment settings for both providers', () => {
    const config = loadConfig({ ...base,
      AUTHENTIK_ISSUER: 'https://authentik.example', AUTHENTIK_AUDIENCE: 'mcp', AUTHENTIK_JWKS_URI: 'https://authentik.example/jwks',
      AUTHENTIK_CLIENT_ID: 'ak-client', AUTHENTIK_AUTHORIZATION_URL: 'https://authentik.example/authorize', AUTHENTIK_TOKEN_URL: 'https://authentik.example/token',
      SAKURA_ISSUER: 'https://sakura.example', SAKURA_AUDIENCE: 'sk-client', SAKURA_JWKS_URI: 'https://sakura.example/jwks.json',
      SAKURA_CLIENT_ID: 'sk-client', SAKURA_AUTHORIZATION_URL: 'https://sakura.example/authorize', SAKURA_TOKEN_URL: 'https://sakura.example/token',
      SAKURA_END_SESSION_URL: 'https://sakura.example/logout' });
    expect(config.authentik).toMatchObject({ clientId: 'ak-client', authorizationUrl: 'https://authentik.example/authorize', tokenUrl: 'https://authentik.example/token' });
    expect(config.sakura).toMatchObject({ clientId: 'sk-client', authorizationUrl: 'https://sakura.example/authorize', tokenUrl: 'https://sakura.example/token', endSessionUrl: 'https://sakura.example/logout' });
  });

  it('parses API key scopes and normalizes public URL', () => {
    const config = loadConfig({ ...base, PUBLIC_BASE_URL: 'https://mcp.example.com/' });
    expect(config.publicBaseUrl).toBe('https://mcp.example.com');
    expect(config.apiKeys[0]).toMatchObject({ id: 'agent', scopes: ['memory:read', 'memory:write'] });
  });
  it('uses a safe configurable raw request byte limit', () => {
    expect(loadConfig(base).security.maxBodyBytes).toBe(6 * 1024 * 1024);
    expect(loadConfig({ ...base, MAX_REQUEST_BODY_BYTES: '2097152' }).security.maxBodyBytes).toBe(2097152);
    for (const value of ['0', '-1', '1.5', 'NaN', '67108865']) {
      expect(() => loadConfig({ ...base, MAX_REQUEST_BODY_BYTES: value })).toThrow();
    }
  });

  it('rejects incomplete Authentik configuration', () => {
    expect(() => loadConfig({ ...base, AUTHENTIK_ISSUER: 'https://login.example.com/app' })).toThrow('must be configured together');
  });
  it('parses OpenAI-compatible and Ollama providers independently', () => {
    const config = loadConfig({ ...base, OPENAI_COMPATIBLE_BASE_URL: 'https://api.example.com/v1', OLLAMA_BASE_URL: 'http://localhost:11434' });
    expect(config.openaiCompatible?.baseUrl).toBe('https://api.example.com/v1');
    expect(config.ollama?.baseUrl).toBe('http://localhost:11434');
  });

  it('parses a dedicated embedding endpoint independent from the chat provider', () => {
    const config = loadConfig({ ...base, OPENAI_COMPATIBLE_BASE_URL: 'https://chat.example.com/v1',
      EMBEDDING_BASE_URL: 'https://vectors.example.com/v1/', EMBEDDING_API_KEY: 'embed-secret', EMBEDDING_MODEL: 'bge-m3' });
    expect(config.embedding).toEqual({ baseUrl: 'https://vectors.example.com/v1', apiKey: 'embed-secret', model: 'bge-m3' });
    expect(config.openaiCompatible?.baseUrl).toBe('https://chat.example.com/v1');
    expect(loadConfig({ ...base }).embedding).toBeUndefined();
  });

  it('uses a stable PostgreSQL host for panel-managed Compose', () => {
    const config = loadConfig({ ...base });
    expect(config.database.host).toBe('postgres');
  });

  it('defaults local login on without an OIDC provider and honours LOCAL_LOGIN', () => {
    expect(loadConfig(base).localLogin).toEqual({ enabled: true, adminUsername: undefined, adminPassword: undefined });
    const authentik = { AUTHENTIK_ISSUER: 'https://login.example.com/app', AUTHENTIK_AUDIENCE: 'mcp', AUTHENTIK_JWKS_URI: 'https://login.example.com/jwks/' };
    // An Authentik installation keeps local accounts off unless asked for.
    expect(loadConfig({ ...base, ...authentik }).localLogin.enabled).toBe(false);
    expect(loadConfig({ ...base, ...authentik, LOCAL_LOGIN: 'true' }).localLogin.enabled).toBe(true);
    expect(loadConfig({ ...base, LOCAL_LOGIN: 'false' }).localLogin.enabled).toBe(false);
    // Declaring an admin through the environment implies local login.
    expect(loadConfig({ ...base, ...authentik, LOCAL_ADMIN_USERNAME: 'ops', LOCAL_ADMIN_PASSWORD: 'ops-secret-123' }).localLogin)
      .toEqual({ enabled: true, adminUsername: 'ops', adminPassword: 'ops-secret-123' });
    expect(loadConfig({ ...base, auth: 'false' }).localLogin.enabled).toBe(false);
  });

  it('does not require a setup token for first-run configuration', () => {
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(loadConfig({ ...base }).setup).toEqual({ encryptionKey: base.CONFIG_ENCRYPTION_KEY });
  });

  it('enables authentication by default and accepts either AUTH=false spelling', () => {
    expect(loadConfig({ ...base }).authEnabled).toBe(true);
    expect(loadConfig({ ...base, AUTH: 'false' }).authEnabled).toBe(false);
    expect(loadConfig({ ...base, auth: 'false' }).authEnabled).toBe(false);
    expect(loadConfig({ ...base, AUTH: 'true', auth: 'false' }).authEnabled).toBe(false);
  });

  it('ignores incomplete Authentik variables when authentication is disabled', () => {
    const config = loadConfig({ ...base, auth: 'false', AUTHENTIK_ISSUER: 'https://login.example.com/app' });
    expect(config.authEnabled).toBe(false);
    expect(config.authentik).toBeUndefined();
  });

  it('parses Sakura provider settings independently from Authentik', () => {
    const sakura = { SAKURA_ISSUER: 'https://sakura.example.com', SAKURA_AUDIENCE: 'sakura-mcp', SAKURA_JWKS_URI: 'https://sakura.example.com/jwks' };
    // Sakura is optional: leaving it out keeps an Authentik installation unchanged.
    const authentik = { AUTHENTIK_ISSUER: 'https://login.example.com/app', AUTHENTIK_AUDIENCE: 'mcp', AUTHENTIK_JWKS_URI: 'https://login.example.com/jwks/' };
    expect(loadConfig({ ...base, ...authentik }).sakura).toBeUndefined();
    // Both providers can coexist, each with its own issuer and audience.
    const both = loadConfig({ ...base, ...authentik, ...sakura });
    expect(both.authentik).toMatchObject({ issuer: 'https://login.example.com/app', audience: 'mcp' });
    expect(both.sakura).toMatchObject({ issuer: 'https://sakura.example.com', audience: 'sakura-mcp' });
    expect(both.localLogin.enabled).toBe(false);
    // Sakura alone still counts as an external provider, so local accounts stay off.
    expect(loadConfig({ ...base, ...sakura }).localLogin.enabled).toBe(false);
    expect(loadConfig({ ...base, ...sakura, LOCAL_LOGIN: 'true' }).localLogin.enabled).toBe(true);
  });

  it('rejects incomplete Sakura configuration', () => {
    expect(() => loadConfig({ ...base, SAKURA_ISSUER: 'https://sakura.example.com' })).toThrow('SAKURA_ISSUER');
    // Incomplete Sakura variables are ignored entirely when authentication is off.
    expect(loadConfig({ ...base, auth: 'false', SAKURA_ISSUER: 'https://sakura.example.com' }).sakura).toBeUndefined();
  });
});