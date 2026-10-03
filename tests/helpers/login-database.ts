import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { Database } from '../../src/database.js';
import { hashPassword } from '../../src/security/password.js';

// SQL boundary double only: the application routes, password verifier, OIDC
// exchange, cookies and session service all run unchanged. Not a PostgreSQL test.
export async function loginDatabase() {
  const users = new Map<string, { subject: string; displayName: string; email: string | null; admin: boolean }>();
  users.set('local-user', { subject: 'local:owner', displayName: 'Local Owner', email: null, admin: true });
  const credential = { hash: await hashPassword('local-password-123'), version: '11111111-1111-4111-8111-111111111111', exists: true, failed: 0, lockedUntil: new Date(0) };
  const attempts = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, { id: string; userId: string; source: string; revoked: boolean; version?: string }>();
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    const key = String(args[0]);
    if (sql.includes('INSERT INTO oidc_login_attempts')) {
      attempts.set(key, { code_verifier: args[1], nonce: args[2], return_to: args[3], purpose: args[4], binding: args[5], provider: args[6] });
      return { rows: [] };
    }
    if (sql.includes('RETURNING code_verifier')) {
      const row = attempts.get(key);
      if (!row || (args[1] && row.purpose !== args[1]) || row.binding !== args[2]) return { rows: [] };
      attempts.delete(key); return { rows: [row] };
    }
    if (sql === 'DELETE FROM oidc_login_attempts WHERE expires_at<=now()') return { rows: [] };
    if (sql.includes('INSERT INTO web_sessions')) {
      if (args[2] === 'local' && (!credential.exists || args[3] !== credential.version)) return { rows: [] };
      const id = `00000000-0000-4000-8000-${String(sessions.size).padStart(12, '0')}`;
      sessions.set(String(args[1]), { id, userId: key, source: String(args[2]), revoked: false, version: args[3] as string | undefined });
      return { rows: [{ id }] };
    }
    if (sql.includes('FROM web_sessions ws JOIN users')) {
      const s = sessions.get(key); if (!s || s.revoked || (s.source === 'local' && (!credential.exists || s.version !== credential.version))) return { rows: [] };
      const u = users.get(s.userId)!;
      return { rows: [{ session_id: s.id, user_id: s.userId, oidc_subject: u.subject, email: u.email,
        display_name: u.displayName, avatar_url: null, is_system_admin: u.admin,
        expires_at: new Date(Date.now() + 3600_000).toISOString(), auth_source: s.source }] };
    }
    if (sql.startsWith('UPDATE web_sessions SET last_seen_at')) return { rows: [] };
    if (sql.startsWith('UPDATE web_sessions SET revoked_at')) {
      if (sql.includes('WHERE user_id=$1')) {
        for (const s of sessions.values()) if (s.userId === key &&
          (!sql.includes("auth_source='local'") || s.source === 'local') &&
          (!sql.includes('id<>$2') || s.id !== args[1]) && (!sql.includes('AND id=$2') || s.id === args[1])) s.revoked = true;
      } else { const s = sessions.get(key); if (s) s.revoked = true; }
      return { rows: [] };
    }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT password_hash,locked_until')) return { rows: credential.exists ? [{ password_hash: credential.hash, locked_until: credential.lockedUntil, failed_attempts: credential.failed }] : [] };
    if (sql.includes('WHERE u.is_system_admin=true')) return { rows: [] };
    if (sql.includes('SELECT lc.user_id')) return { rows: credential.exists && (key === 'owner' || sql.includes('ORDER BY lc.username')) ? [{
      user_id: 'local-user', username: 'owner', password_hash: credential.hash, failed_attempts: credential.failed,
      locked_until: credential.lockedUntil.toISOString(), display_name: 'Local Owner', email: null,
      is_system_admin: users.get('local-user')!.admin, credential_version: credential.version, updated_at: new Date(0)
    }] : [] };
    if (sql.startsWith('UPDATE local_credentials SET')) {
      if (sql.includes('password_hash=$2')) { credential.hash = String(args[1]); credential.version = crypto.randomUUID(); }
      if (sql.includes('failed_attempts=$2')) { credential.failed = Number(args[1]); credential.lockedUntil = args[2] as Date; }
      if (sql.includes('failed_attempts=0')) { credential.failed = 0; credential.lockedUntil = new Date(0); }
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM local_credentials')) { credential.exists = false; return { rows: [] }; }
    if (sql.includes('SELECT ws.id,ws.auth_source')) return { rows: [...sessions.values()].filter(s => s.userId === key && !s.revoked &&
      (s.source !== 'local' || (credential.exists && s.version === credential.version))).map(s => ({ id: s.id, auth_source: s.source,
        created_at: new Date(0), last_seen_at: new Date(), expires_at: new Date(Date.now() + 3600_000) })) };
    throw new Error(`Unexpected test SQL: ${sql}`);
  });
  const database = { query, pool: { connect: async () => ({ query, release() {} }) } } as unknown as Database;
  const ensureUser = vi.fn(async (subject: string, profile?: { email?: string; displayName?: string; adminByGroup?: boolean }) => {
    const id = createHash('sha256').update(subject).digest('hex');
    users.set(id, { subject, displayName: profile?.displayName ?? subject, email: profile?.email ?? null, admin: profile?.adminByGroup ?? false });
    return { userId: id, personalSpaceId: `space-${id}` };
  });
  return { database, query, ensureUser, attempts, sessions, users, credential };
}
