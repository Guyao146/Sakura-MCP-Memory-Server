import { describe, expect, it, vi } from 'vitest';
import { hashPassword, validatePassword, validateUsername, verifyPassword, PASSWORD_MIN_LENGTH } from '../src/security/password.js';
import { LocalLoginService, LoginRejected } from '../src/web/local-login.js';
import type { Database } from '../src/database.js';

const CORRECT = 'correct horse battery staple';

function credentialBackend() {
  const state = { failed: 0, lockedUntil: new Date(0), hash: '' as string, exists: true };
  return {
    state,
    async seed(password: string) { state.hash = await hashPassword(password); },
    snapshot: () => ({ ...state }),
    database(): Database {
      const client = {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          if (sql === 'BEGIN') return { rows: [] };
          if (sql.startsWith('SELECT lc.user_id')) {
            if (!state.exists) return { rows: [] };
            return { rows: [{
              user_id: 'user-1', username: 'admin', password_hash: state.hash,
              failed_attempts: state.failed, locked_until: state.lockedUntil.toISOString(),
              display_name: 'Admin', email: null, is_system_admin: true
            }] };
          }
          if (sql.startsWith('UPDATE local_credentials SET failed_attempts=$2')) {
            state.failed = params[1] as number;
            state.lockedUntil = params[2] as Date;
            return { rows: [] };
          }
          if (sql.startsWith('UPDATE local_credentials SET failed_attempts=0')) {
            state.failed = 0;
            state.lockedUntil = new Date(0);
            return { rows: [] };
          }
          return { rows: [] };
        }),
        release: vi.fn()
      };
      return { pool: { connect: vi.fn(async () => client) } } as unknown as Database;
    }
  };
}


describe('local password hashing', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const encoded = await hashPassword(CORRECT);
    expect(encoded.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(CORRECT, encoded)).toBe(true);
    expect(await verifyPassword('wrong password', encoded)).toBe(false);
    // The verifier must never crash on garbage; it just says "no".
    for (const junk of ['', 'plaintext', 'scrypt$', 'scrypt$1$1$1$00$00', '$'.repeat(64), 'scrypt$N$r$p$salt']) {
      await expect(verifyPassword(CORRECT, junk)).resolves.toBe(false);
    }
  });

  it('salts every hash and rejects short or padded passwords', async () => {
    const a = await hashPassword(CORRECT);
    const b = await hashPassword(CORRECT);
    expect(a).not.toBe(b);
    expect(() => validatePassword('x'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow();
    expect(() => validatePassword(' padded-pair ')).toThrow();
    expect(() => validateUsername('ab')).toThrow();
    expect(() => validateUsername('not valid!')).toThrow();
    expect(() => validateUsername('a'.repeat(61))).toThrow();
    expect(() => validateUsername('valid.name_1-2')).not.toThrow();
  });
});

describe('LocalLoginService', () => {
  it('returns the account on a valid login and resets the failure counters', async () => {
    const backend = credentialBackend();
    await backend.seed(CORRECT);
    const service = new LocalLoginService(backend.database());
    const account = await service.login('admin', CORRECT);
    expect(account).toMatchObject({ userId: 'user-1', username: 'admin', displayName: 'Admin', isSystemAdmin: true });
    expect(backend.snapshot().failed).toBe(0);
  });

  it('reports a single generic error for unknown users and wrong passwords', async () => {
    const backend = credentialBackend();
    await backend.seed(CORRECT);
    const service = new LocalLoginService(backend.database());
    backend.state.exists = false;
    await expect(service.login('admin', CORRECT)).rejects.toThrow('用户名或密码不正确');
    backend.state.exists = true;
    await expect(service.login('admin', 'wrong password')).rejects.toThrow('用户名或密码不正确');
    // Four failures accumulate without locking.
    expect(backend.snapshot().failed).toBe(1);
    for (let attempt = 2; attempt <= 4; attempt++) {
      await expect(service.login('admin', 'wrong password')).rejects.toThrow('用户名或密码不正确');
      expect(backend.snapshot().failed).toBe(attempt);
    }
    // The lock date was only nudged forward, not into the future, so the account
    // is not yet locked and a correct login still succeeds.
    await expect(service.login('admin', CORRECT)).resolves.toBeTruthy();
  });

  it('locks the account on the fifth failure and keeps the correct password out', async () => {
    const backend = credentialBackend();
    await backend.seed(CORRECT);
    const service = new LocalLoginService(backend.database());
    for (let attempt = 1; attempt <= 4; attempt++) {
      await expect(service.login('admin', 'wrong password')).rejects.toThrow('用户名或密码不正确');
    }
    const before = Date.now();
    await expect(service.login('admin', 'wrong password')).rejects.toThrow('锁定');
    const state = backend.snapshot();
    expect(state.failed).toBe(5);
    // ~5 minutes, not hours, and definitely in the future.
    expect(state.lockedUntil.getTime()).toBeGreaterThan(before);
    expect(state.lockedUntil.getTime()).toBeLessThan(before + 10 * 60_000);
    // Even the correct password cannot unlock the account early.
    await expect(service.login('admin', CORRECT)).rejects.toThrow('账号已锁定');
    // Expiry restores access and clears the counters.
    backend.state.lockedUntil = new Date(Date.now() - 1);
    await expect(service.login('admin', CORRECT)).resolves.toBeTruthy();
    expect(backend.snapshot().failed).toBe(0);
  });

  it('grows the lockout window over repeated lock cycles', async () => {
    const backend = credentialBackend();
    await backend.seed(CORRECT);
    const service = new LocalLoginService(backend.database());
    let locked = 0;
    for (let cycle = 1; cycle <= 3; cycle++) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try { await service.login('admin', 'wrong password'); }
        catch (error) { if (error instanceof LoginRejected && error.message.includes('锁定')) locked++; }
      }
      const state = backend.snapshot();
      expect(state.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      const minutes = (state.lockedUntil.getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThanOrEqual(Math.min(5 * 2 ** (cycle - 1), 60) - 1);
      backend.state.lockedUntil = new Date(0); // serve the sentence instantly
    }
    expect(locked).toBe(3);
  });

  it('validates credentials before they are stored', async () => {
    const service = new LocalLoginService({ query: async () => ({ rows: [] }), pool: { connect: async () => ({ query: async () => ({ rows: [] }), release: () => undefined }) } } as never);
    await expect(service.upsert('no', 'valid-password', {})).rejects.toThrow('用户名');
    await expect(service.upsert('admin', 'short', {})).rejects.toThrow('密码');
  });

  it('refuses a self-service password change without the current password', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT password_hash,locked_until')) {
        return { rows: [{ password_hash: await hashPassword(CORRECT), locked_until: new Date(0), failed_attempts: 0 }] };
      }
      return { rows: [] };
    });
    const database = { pool: { connect: async () => ({ query, release() {} }) } } as unknown as Database;
    const service = new LocalLoginService(database);
    await expect(service.changePassword('user-1', 'wrong password', 'new-password')).rejects.toThrow('当前密码不正确');
    await expect(service.changePassword('user-1', CORRECT, 'short')).rejects.toThrow('密码');
    await expect(service.changePassword('user-1', CORRECT, 'new-password-123')).resolves.toBeUndefined();
  });
});
