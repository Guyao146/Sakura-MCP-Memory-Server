import { describe, expect, it } from 'vitest';
import { AuthService, requireScopes } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://mcp.example.com',
  DATABASE_URL: 'postgresql://sakura:test@localhost:5432/sakura_memory',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
  MCP_API_KEYS: 'trusted:correct-secret:memory:read|memory:write'
});

describe('AuthService API keys', () => {
  it('still checks revocation on every Agent authentication while throttling statistics', async () => {
    const calls: string[] = [];
    let revoked = false;
    const database = { query: async (sql: string) => {
      calls.push(sql);
      return { rows: !revoked && sql.startsWith('SELECT') ? [{ agent_id: 'agent', oidc_subject: 'owner',
        email: null, display_name: 'Owner', scopes: ['memory:read'], expires_at: null }] : [] };
    } };
    const service = new AuthService(config, database as never);
    await service.authenticate('Bearer sk_sakura_test');
    expect(calls[1]).toContain("last_used_at < now()-interval '5 minutes'");
    revoked = true;
    await expect(service.authenticate('Bearer sk_sakura_test')).rejects.toThrow('Invalid credential');
    expect(calls.filter(sql => sql.startsWith('SELECT'))).toHaveLength(2);
    expect(calls[2]).toContain('ac.revoked_at IS NULL');
  });

  it('authenticates a configured API key', async () => {
    const principal = await new AuthService(config).authenticate('Bearer correct-secret');
    expect(principal).toMatchObject({ id: 'trusted', source: 'api_key', scopes: ['memory:read', 'memory:write'] });
  });
  it('rejects an invalid credential', async () => {
    await expect(new AuthService(config).authenticate('Bearer wrong-secret')).rejects.toThrow('Invalid credential');
  });
  it('enforces tool scopes', async () => {
    const principal = await new AuthService(config).authenticate('Bearer correct-secret');
    expect(() => requireScopes(principal, ['memory:delete'])).toThrow('Missing required scope');
  });

  it('uses a full-scope local administrator without a Bearer header when AUTH=false', async () => {
    const disabled = loadConfig({
      PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://localhost/test', AUTH: 'false',
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64url'), MCP_API_KEYS: ''
    });
    await expect(new AuthService(disabled).authenticate(undefined)).resolves.toMatchObject({
      id: 'local-admin', source: 'local', displayName: 'Local Administrator',
      scopes: expect.arrayContaining(['memory:read', 'memory:write', 'space:manage', 'admin:system'])
    });
  });
});