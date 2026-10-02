import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  PUBLIC_BASE_URL: 'https://mcp.example.com',
  DATABASE_URL: 'postgresql://sakura:test@localhost:5432/sakura_memory',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  MCP_API_KEYS: 'agent:very-secret:memory:read|memory:write'
};

describe('loadConfig', () => {
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
});