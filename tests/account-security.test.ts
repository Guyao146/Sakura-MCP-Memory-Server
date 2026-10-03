import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { LocalLoginService } from '../src/web/local-login.js';
import { hashPassword, normalizeUsername, verifyPassword } from '../src/security/password.js';
import { WebSessionService } from '../src/web/session.js';
import { loadConfig } from '../src/config.js';
import { loginDatabase } from './helpers/login-database.js';

const password = 'new-password-123';
const config = loadConfig({ PUBLIC_BASE_URL: 'https://mcp.example.com', DATABASE_URL: 'postgresql://unused', CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url') });

// Explicit SQL contract/transaction boundary double; real rollback is covered by PostgreSQL tests.
function accountDatabase(options: { existing?: boolean; otherAdmin?: boolean; failure?: string } = {}) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (options.failure && sql.includes(options.failure)) throw new Error('injected failure');
    if (sql.startsWith('SELECT id,is_system_admin')) return { rows: options.existing ? [{ id: 'user', is_system_admin: true }] : [] };
    if (sql.includes('WHERE u.is_system_admin=true')) return { rows: options.otherAdmin ? [{ user_id: 'other' }] : [] };
    if (sql.startsWith('SELECT lc.user_id,u.is_system_admin')) return { rows: [{ user_id: 'user', is_system_admin: true }] };
    if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'user', display_name: 'Owner', email: null, is_system_admin: true }] };
    if (sql.includes('INSERT INTO spaces')) return { rows: [{ id: 'space' }] };
    return { rows: [] };
  });
  const release = vi.fn();
  return { query, release, database: { pool: { connect: async () => ({ query, release }) } } as never };
}

describe('account security transactions', () => {
  it.each(['INSERT INTO users', 'INSERT INTO spaces', 'INSERT INTO space_members', 'INSERT INTO local_credentials', 'UPDATE web_sessions'])(
    'rolls back account provisioning after failure at %s', async failure => {
      const b = accountDatabase({ failure });
      await expect(new LocalLoginService(b.database).upsert('OWNER', password, {})).rejects.toThrow('injected');
      expect(b.query.mock.calls[0][0]).toBe('BEGIN');
      expect(b.query.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
      expect(b.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
      expect(b.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
      expect(b.release).toHaveBeenCalledOnce();
    });
  it('provisions canonical names and resets credentials without reassigning their owner', async () => {
    const b = accountDatabase();
    expect(await new LocalLoginService(b.database).upsert(' Owner ', password, { isSystemAdmin: true })).toMatchObject({ username: 'owner' });
    const insert = b.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO local_credentials'))!;
    expect(insert[1]).toEqual(['user', 'owner', expect.any(String)]);
    expect(insert[0]).not.toContain('user_id=EXCLUDED');
    expect(b.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  });
  it('rejects case-colliding registration instead of resetting an existing account', async () => {
    const b = accountDatabase({ existing: true });
    await expect(new LocalLoginService(b.database).upsert('OWNER', password, {}, true)).rejects.toThrow('用户名已存在');
    expect(b.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });
  it.each(['remove', 'updateProfile', 'upsert'] as const)('protects the last usable admin during %s', async operation => {
    const b = accountDatabase({ existing: true }); const service = new LocalLoginService(b.database);
    const result = operation === 'remove' ? service.remove('owner') : operation === 'updateProfile'
      ? service.updateProfile('owner', { isSystemAdmin: false }) : service.upsert('owner', password, { isSystemAdmin: false });
    await expect(result).rejects.toThrow('最后一个可用');
    const guard = b.query.mock.calls.find(([sql]) => sql.includes('WHERE u.is_system_admin=true'))![0];
    expect(guard).toContain('locked_until<=clock_timestamp()'); expect(guard).toContain('FOR UPDATE');
    expect(b.query.mock.calls.some(([sql]) => /^(UPDATE|DELETE|INSERT)/.test(sql))).toBe(false);
  });
  it.each(['setPassword', 'remove'] as const)('revokes only local sessions in the same transaction for %s', async operation => {
    const b = accountDatabase({ otherAdmin: true }); const service = new LocalLoginService(b.database);
    await (operation === 'remove' ? service.remove('OWNER') : service.setPassword('OWNER', password));
    const calls = b.query.mock.calls.map(([sql]) => sql);
    expect(calls.at(-2)).toContain("auth_source='local'"); expect(calls.at(-1)).toBe('COMMIT');
    expect(calls.join(' ')).not.toMatch(/agent_keys|api_keys/);
  });
});

describe('local credential and session security', () => {
  it('accepts ASCII case folding only and rejects tampered scrypt parameters/hex', async () => {
    expect(normalizeUsername(' OwNeR ')).toBe('owner');
    expect(() => normalizeUsername('Key')).toThrow();
    const encoded = await hashPassword(password);
    for (const bad of [encoded.replace('$16384$', '$32768$'), encoded.replace('$8$', '$9$'),
      encoded.replace('$1$', '$2$'), encoded + 'zz', encoded.replace(/.$/, 'z'), encoded.replace('$16384$', '$999999999$')]) {
      expect(await verifyPassword(password, bad)).toBe(false);
    }
    expect(await verifyPassword(password, encoded)).toBe(true);
  });
  it('maps account fields explicitly without exposing credential internals', async () => {
    const b = await loginDatabase();
    const users = await new LocalLoginService(b.database).list();
    expect(Object.keys(users[0]).sort()).toEqual(['displayName', 'email', 'failedAttempts', 'isSystemAdmin', 'lockedUntil', 'updatedAt', 'userId', 'username']);
    expect(users[0]).toMatchObject({ userId: 'local-user', username: 'owner', failedAttempts: 0, isSystemAdmin: true });
  });
  it.each(['setPassword', 'changePassword', 'remove'] as const)('invalidates old local sessions after %s but leaves OIDC alone', async operation => {
    const b = await loginDatabase(); b.users.get('local-user')!.admin = false;
    const local = new LocalLoginService(b.database); const web = new WebSessionService(b.database, () => config);
    const account = await local.login('OWNER', 'local-password-123');
    const old = await web.issueSession(account.userId, '/admin', 'local', account.credentialVersion);
    const oidc = await web.issueSession(account.userId, '/admin', 'sakura');
    if (operation === 'remove') await local.remove('owner');
    else if (operation === 'setPassword') await local.setPassword('owner', password);
    else await local.changePassword(account.userId, 'local-password-123', password);
    await expect(web.authenticate(old.token)).rejects.toThrow('revoked');
    await expect(web.issueSession(account.userId, '/admin', 'local', account.credentialVersion)).rejects.toThrow('changed');
    // Even a late INSERT missed by bulk revocation fails version validation.
    for (const s of b.sessions.values()) s.revoked = false;
    await expect(web.authenticate(old.token)).rejects.toThrow('revoked');
    await expect(web.authenticate(oidc.token)).resolves.toMatchObject({ authSource: 'sakura' });
  });
  it('counts self-service wrong-password guesses and enforces lockout', async () => {
    const b = await loginDatabase(); const service = new LocalLoginService(b.database);
    for (let i = 0; i < 5; i++) await expect(service.changePassword('local-user', 'wrong', password)).rejects.toThrow('当前密码不正确');
    expect(b.credential.failed).toBe(5);
    await expect(service.changePassword('local-user', 'local-password-123', password)).rejects.toThrow('锁定');
    await service.unlock('owner');
    await expect(service.changePassword('local-user', 'local-password-123', password)).resolves.toBeUndefined();
  });
  it('never signs local sessions without the authenticated credential version', async () => {
    const b = await loginDatabase(); const web = new WebSessionService(b.database, () => config);
    await expect(web.issueSession('local-user', '/admin', 'local')).rejects.toThrow('version');
    expect(b.sessions.size).toBe(0);
  });
  it('migration detects collisions before normalization and expires legacy local sessions', async () => {
    const sql = await readFile(new URL('../migrations/015_account_security.sql', import.meta.url), 'utf8');
    expect(sql.indexOf('RAISE EXCEPTION')).toBeLessThan(sql.indexOf('UPDATE local_credentials'));
    expect(sql).toContain('CHECK (username=lower(username))');
    expect(sql).toContain('credential_version uuid NOT NULL DEFAULT gen_random_uuid()');
    expect(sql).toContain("WHERE auth_source='local' AND revoked_at IS NULL");
  });
});

