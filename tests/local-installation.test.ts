import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SettingsRepository } from '../src/settings/repository.js';
import { SetupService, sakuraConfigSchema } from '../src/setup/service.js';
import { verifyPassword } from '../src/security/password.js';

const key = Buffer.alloc(32, 17).toString('base64url');
const admin = { username: 'owner', password: 'correct-password-123', displayName: 'Owner' };
const base = { PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://unused', CONFIG_ENCRYPTION_KEY: key };
function fixture(failAt?: string) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (failAt && sql.includes(failAt)) throw new Error('injected failure');
    if (sql.startsWith('SELECT completed')) return { rows: [{ completed: false }] };
    if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'user' }] };
    if (sql.includes('INSERT INTO spaces')) return { rows: [{ id: 'space' }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const repository = new SettingsRepository({ pool: { connect: async () => ({ query, release }) } } as never, key);
  return { repository, query, release };
}

describe('local installation transaction', () => {
  it('rejects whitespace-only administrator groups', () => {
    expect(() => sakuraConfigSchema.parse({ issuer: 'https://sakura.example', audience: 'client', clientId: 'client',
      jwksUri: 'https://sakura.example/jwks.json', authorizationUrl: 'https://sakura.example/authorize', tokenUrl: 'https://sakura.example/token',
      adminGroups: ['   '] })).toThrow();
  });

  it('provisions credentials, ownership and persisted login setting before committing installation', async () => {
    const f = fixture(); await f.repository.complete({ localAdmin: admin });
    const calls = f.query.mock.calls;
    const credential = calls.find(([sql]) => sql.includes('INSERT INTO local_credentials'))!;
    expect(credential[1]?.slice(0, 2)).toEqual(['user', 'owner']);
    expect(await verifyPassword(admin.password, credential[1]![2] as string)).toBe(true);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO space_members'), ['space', 'user']);
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO system_settings'), ['local_login.enabled', true, false]);
    expect(calls[0][0]).toBe('BEGIN'); expect(calls.at(-1)![0]).toBe('COMMIT');
    expect(calls.findIndex(([sql]) => sql.includes('INSERT INTO local_credentials')))
      .toBeLessThan(calls.findIndex(([sql]) => sql.includes('UPDATE installation_state')));
    expect(JSON.stringify(calls)).not.toContain(admin.password);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(['INSERT INTO local_credentials', 'INSERT INTO system_settings', 'UPDATE installation_state'])(
    'rolls back and releases on failure at %s', async failAt => {
      const f = fixture(failAt);
      await expect(f.repository.complete({ localAdmin: admin })).rejects.toThrow('injected failure');
      expect(f.query).toHaveBeenCalledWith('ROLLBACK'); expect(f.query).not.toHaveBeenCalledWith('COMMIT');
      expect(f.release).toHaveBeenCalledOnce();
    });

  it.each([undefined, 'true', 'false'] as const)('loads persisted local login with explicit override %s', async explicit => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => sql.includes('installation_state')
      ? { rows: [{ completed: true }] } : { rows: params[0] === 'local_login.enabled' ? [{ value: true, encrypted: false }] : [] });
    const repository = new SettingsRepository({ query } as never, key);
    const config = loadConfig({ ...base, LOCAL_LOGIN: explicit, AUTHENTIK_ISSUER: 'https://idp.example',
      AUTHENTIK_AUDIENCE: 'client', AUTHENTIK_JWKS_URI: 'https://idp.example/jwks' });
    expect((await repository.apply(config)).localLogin.enabled).toBe(explicit !== 'false');
    expect((await repository.apply({ ...config, authEnabled: false })).localLogin.enabled).toBe(false);
  });

  it('does not write account or IdP settings with AUTH=false', async () => {
    const complete = vi.fn();
    const service = new SetupService(false, base.PUBLIC_BASE_URL, {} as never, { complete } as never);
    await service.complete({ localAdmin: admin, administratorEmail: 'owner@example.com' });
    expect(complete).toHaveBeenCalledWith({ openaiCompatible: undefined, ollama: undefined, embedding: undefined });
  });

  it('rejects Sakura-only installation without explicit administrator groups before writing', async () => {
    const complete = vi.fn();
    const service = new SetupService(true, base.PUBLIC_BASE_URL, {} as never, { complete } as never);
    await expect(service.complete({ administratorEmail: 'owner@example.com', sakura: {
      issuer: 'https://sakura.example', audience: 'client', clientId: 'client', scopeClaim: 'scope', groupsClaim: 'groups',
      jwksUri: 'https://sakura.example/jwks.json', authorizationUrl: 'https://sakura.example/authorize', tokenUrl: 'https://sakura.example/token'
    } })).rejects.toThrow('管理员用户组');
    expect(complete).not.toHaveBeenCalled();
  });
});
