import { MemoryRepository } from '../memory/repository.js';
import type { Database } from '../database.js';
import { hashPassword, validatePassword, validateUsername, verifyPassword } from '../security/password.js';

/** Why a local login was rejected, so the caller can audit without details. */
export class LoginRejected extends Error {}

export interface LocalAccount {
  userId: string; username: string; displayName: string; email: string | null; isSystemAdmin: boolean;
}

export interface LocalAccountRecord extends LocalAccount {
  failedAttempts: number; lockedUntil: Date; updatedAt: Date;
}

interface CredentialRow {
  user_id: string; username: string; password_hash: string;
  failed_attempts: number; locked_until: string;
  display_name: string; email: string | null; is_system_admin: boolean;
}

/** Lock an account for 5 minutes per lockout cycle, doubling up to one hour. */
const LOCKOUT_THRESHOLD = 5;
const lockoutMinutes = (failedAttempts: number) =>
  Math.min(5 * 2 ** (Math.floor(failedAttempts / LOCKOUT_THRESHOLD) - 1), 60);

const subjectOf = (username: string) => `local:${username.toLowerCase()}`;


/**
 * Username/password accounts stored in the server's own database.
 *
 * This exists so a deployment does not need Authentik (or any external OIDC
 * provider) to secure the admin UI. Local accounts only ever receive web
 * sessions; MCP Bearer authentication keeps using API keys and provider tokens.
 *
 * Failed guesses are counted per account in the database and lock the account
 * for a growing window, so an attacker rotating IP addresses cannot bypass the
 * per-IP rate limiter. Username existence is never revealed: every failure
 * raises {@link LoginRejected} with a generic message.
 */
export class LocalLoginService {
  constructor(private readonly database: Database) {}

  async login(username: string, password: string): Promise<LocalAccount> {
    const name = username.trim();
    try {
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CredentialRow>(
          `SELECT lc.user_id,lc.username,lc.password_hash,lc.failed_attempts,lc.locked_until,
                  u.display_name,u.email,u.is_system_admin
           FROM local_credentials lc JOIN users u ON u.id=lc.user_id
           WHERE lc.username=$1 FOR UPDATE`, [name]);
        const row = result.rows[0];
        if (!row) throw new LoginRejected('用户名或密码不正确。');
        if (new Date(row.locked_until).getTime() > Date.now()) {
          throw new LoginRejected('账号已锁定，请稍后再试。');
        }
        if (await verifyPassword(password, row.password_hash)) {
          await client.query('UPDATE local_credentials SET failed_attempts=0,locked_until=now() WHERE username=$1', [name]);
          await client.query('COMMIT');
          return { userId: row.user_id, username: row.username, displayName: row.display_name,
            email: row.email, isSystemAdmin: row.is_system_admin };
        }
        const failed = row.failed_attempts + 1;
        const lockedNow = failed % LOCKOUT_THRESHOLD === 0;
        const lockedUntil = lockedNow ? new Date(Date.now() + lockoutMinutes(failed) * 60_000) : new Date();
        await client.query('UPDATE local_credentials SET failed_attempts=$2,locked_until=$3 WHERE username=$1',
          [name, failed, lockedUntil]);
        await client.query('COMMIT');
        // The lockout notice is only shown when this very attempt triggered a
        // new lock, so the message stays a truthful signal for the real owner.
        throw new LoginRejected(lockedNow ? '用户名或密码不正确，账号已临时锁定。' : '用户名或密码不正确。');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    } catch (error) {
      // A locked or unknown account stays indistinguishable from a bad password.
      if (error instanceof LoginRejected) throw error;
      throw new LoginRejected('用户名或密码不正确。');
    }
  }

  /** Creates the account, or rotates its password when it already exists. */
  async upsert(username: string, password: string, profile: { displayName?: string; email?: string; isSystemAdmin?: boolean }): Promise<LocalAccount> {
    const name = username.trim();
    validateUsername(name);
    validatePassword(password);
    const identity = await new MemoryRepository(this.database).ensureUser(subjectOf(name), {
      displayName: profile.displayName || name, email: profile.email, adminByGroup: profile.isSystemAdmin
    });
    const passwordHash = await hashPassword(password);
    await this.database.query(
      `INSERT INTO local_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
       ON CONFLICT (username) DO UPDATE SET user_id=EXCLUDED.user_id,password_hash=EXCLUDED.password_hash,updated_at=now()`,
      [identity.userId, name, passwordHash]);
    const result = await this.database.query<{ display_name: string; email: string | null; is_system_admin: boolean }>(
      'SELECT display_name,email,is_system_admin FROM users WHERE id=$1', [identity.userId]);
    const user = result.rows[0];
    return { userId: identity.userId, username: name, displayName: user.display_name,
      email: user.email, isSystemAdmin: user.is_system_admin };
  }

  async list(): Promise<LocalAccountRecord[]> {
    const result = await this.database.query<LocalAccountRecord & { failed_attempts: number; locked_until: string; updated_at: string }>(
      `SELECT lc.user_id,lc.username,lc.failed_attempts,lc.locked_until,lc.updated_at,
              u.display_name,u.email,u.is_system_admin
       FROM local_credentials lc JOIN users u ON u.id=lc.user_id ORDER BY lc.username`);
    return result.rows.map(row => ({ ...row, lockedUntil: new Date(row.locked_until), updatedAt: new Date(row.updated_at) }));
  }

  async setPassword(username: string, password: string): Promise<void> {
    const name = username.trim();
    validatePassword(password);
    const result = await this.database.query(
      'UPDATE local_credentials SET password_hash=$2,failed_attempts=0,locked_until=now(),updated_at=now() WHERE username=$1',
      [name, await hashPassword(password)]);
    if (result.rowCount === 0) throw new LoginRejected('账号不存在。');
  }

  async remove(username: string): Promise<void> {
    const result = await this.database.query('DELETE FROM local_credentials WHERE username=$1', [username.trim()]);
    if (result.rowCount === 0) throw new LoginRejected('账号不存在。');
  }

  /** Self-service rotation: the current password must match before the new one applies. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const result = await this.database.query<{ username: string; password_hash: string }>(
      'SELECT username,password_hash FROM local_credentials WHERE user_id=$1', [userId]);
    const row = result.rows[0];
    if (!row) throw new LoginRejected('当前账号未设置本地密码。');
    if (!(await verifyPassword(currentPassword, row.password_hash))) throw new LoginRejected('当前密码不正确。');
    await this.setPassword(row.username, newPassword);
  }
}
