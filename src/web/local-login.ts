import type { PoolClient } from 'pg';
import type { Database } from '../database.js';
import { hashPassword, normalizeUsername, validatePassword, verifyPassword } from '../security/password.js';

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
  failed_attempts: number; locked_until: string; credential_version: string;
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

  async login(username: string, password: string): Promise<LocalAccount & { credentialVersion: string }> {
    try {
      const name = normalizeUsername(username);
      const client = await this.database.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query<CredentialRow>(
          `SELECT lc.user_id,lc.username,lc.password_hash,lc.failed_attempts,lc.locked_until,lc.credential_version,
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
            email: row.email, isSystemAdmin: row.is_system_admin, credentialVersion: row.credential_version };
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

  /** Account, personal space, credentials and session revocation commit together. */
  async upsert(username: string, password: string, profile: { displayName?: string; email?: string; isSystemAdmin?: boolean }, createOnly = false): Promise<LocalAccount> {
    const name = normalizeUsername(username);
    const passwordHash = await hashPassword(password);
    return this.transaction(async client => {
      const existing = await client.query<{ id: string; is_system_admin: boolean }>(
        'SELECT id,is_system_admin FROM users WHERE oidc_subject=$1 FOR UPDATE', [subjectOf(name)]);
      if (createOnly && existing.rows[0]) throw new LoginRejected('用户名已存在，请使用编辑或重置密码。');
      if (existing.rows[0]?.is_system_admin && profile.isSystemAdmin === false) {
        await this.requireAnotherAdmin(client, existing.rows[0].id);
      }
      const result = await client.query<{ id: string; display_name: string; email: string | null; is_system_admin: boolean }>(
        `INSERT INTO users(oidc_subject,email,display_name,is_system_admin)
         VALUES($1,$2,coalesce($3,$4),coalesce($5,false)) ON CONFLICT(oidc_subject) DO UPDATE
         SET email=coalesce($2,users.email),display_name=coalesce($3,users.display_name),
             is_system_admin=coalesce($5,users.is_system_admin),updated_at=now()
         RETURNING id,display_name,email,is_system_admin`,
        [subjectOf(name), profile.email ?? null, profile.displayName ?? null, name, profile.isSystemAdmin ?? null]);
      const user = result.rows[0];
      const space = await client.query<{ id: string }>(
        `INSERT INTO spaces(type,name,description,created_by) VALUES('personal','Personal Memory','Private long-term memory',$1)
         ON CONFLICT(created_by) WHERE type='personal' AND deleted_at IS NULL DO UPDATE SET updated_at=spaces.updated_at RETURNING id`, [user.id]);
      await client.query(`INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'owner')
        ON CONFLICT(space_id,user_id) DO UPDATE SET role='owner'`, [space.rows[0].id, user.id]);
      await client.query(
        `INSERT INTO local_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
         ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash,
         credential_version=gen_random_uuid(),failed_attempts=0,locked_until=now(),updated_at=now()`,
        [user.id, name, passwordHash]);
      await this.revokeLocalSessions(client, user.id);
      return { userId: user.id, username: name, displayName: user.display_name, email: user.email, isSystemAdmin: user.is_system_admin };
    });
  }

  async list(): Promise<LocalAccountRecord[]> {
    const result = await this.database.query<CredentialRow & { updated_at: string }>(
      `SELECT lc.user_id,lc.username,lc.failed_attempts,lc.locked_until,lc.updated_at,
              u.display_name,u.email,u.is_system_admin
       FROM local_credentials lc JOIN users u ON u.id=lc.user_id ORDER BY lc.username`);
    return result.rows.map(row => ({ userId: row.user_id, username: row.username, displayName: row.display_name,
      email: row.email, isSystemAdmin: row.is_system_admin, failedAttempts: row.failed_attempts,
      lockedUntil: new Date(row.locked_until), updatedAt: new Date(row.updated_at) }));
  }

  async setPassword(username: string, password: string): Promise<void> {
    const name = normalizeUsername(username);
    const passwordHash = await hashPassword(password);
    await this.transaction(async client => {
      const row = await this.accountForUpdate(client, name);
      await this.rotatePassword(client, row.user_id, passwordHash);
    });
  }

  async remove(username: string): Promise<void> {
    const name = normalizeUsername(username);
    await this.transaction(async client => {
      const row = await this.accountForUpdate(client, name);
      if (row.is_system_admin) await this.requireAnotherAdmin(client, row.user_id);
      await client.query('DELETE FROM local_credentials WHERE user_id=$1', [row.user_id]);
      await this.revokeLocalSessions(client, row.user_id);
    });
  }

  async updateProfile(username: string, profile: { displayName?: string; email?: string | null; isSystemAdmin?: boolean }): Promise<void> {
    const name = normalizeUsername(username);
    await this.transaction(async client => {
      const row = await this.accountForUpdate(client, name);
      if (row.is_system_admin && profile.isSystemAdmin === false) await this.requireAnotherAdmin(client, row.user_id);
      await client.query(`UPDATE users SET display_name=coalesce($2,display_name),
        email=CASE WHEN $3 THEN $4 ELSE email END,is_system_admin=coalesce($5,is_system_admin),updated_at=now() WHERE id=$1`,
      [row.user_id, profile.displayName ?? null, profile.email !== undefined, profile.email ?? null, profile.isSystemAdmin ?? null]);
    });
  }

  async unlock(username: string): Promise<void> {
    const name = normalizeUsername(username);
    await this.transaction(async client => {
      const row = await this.accountForUpdate(client, name);
      await client.query('UPDATE local_credentials SET failed_attempts=0,locked_until=now(),updated_at=now() WHERE user_id=$1', [row.user_id]);
    });
  }

  /** Check and rotation share a row lock; all local sessions must reauthenticate. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    validatePassword(newPassword);
    const passwordHash = await hashPassword(newPassword);
    const changed = await this.transaction(async client => {
      const result = await client.query<{ password_hash: string; locked_until: string; failed_attempts: number }>(
        'SELECT password_hash,locked_until,failed_attempts FROM local_credentials WHERE user_id=$1 FOR UPDATE', [userId]);
      const row = result.rows[0];
      if (!row) throw new LoginRejected('当前账号未设置本地密码。');
      if (new Date(row.locked_until).getTime() > Date.now()) throw new LoginRejected('账号已锁定，请稍后再试。');
      if (!(await verifyPassword(currentPassword, row.password_hash))) {
        const failed = row.failed_attempts + 1;
        const until = failed % LOCKOUT_THRESHOLD === 0 ? new Date(Date.now() + lockoutMinutes(failed) * 60_000) : new Date();
        await client.query('UPDATE local_credentials SET failed_attempts=$2,locked_until=$3 WHERE user_id=$1', [userId, failed, until]);
        return false; // Commit failed guesses instead of rolling their counters back.
      }
      await this.rotatePassword(client, userId, passwordHash);
      return true;
    });
    if (!changed) throw new LoginRejected('当前密码不正确。');
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // All administrative local-account mutations use the same transaction lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('sakura.local-account-management'))");
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async accountForUpdate(client: PoolClient, username: string) {
    const result = await client.query<{ user_id: string; is_system_admin: boolean }>(
      `SELECT lc.user_id,u.is_system_admin FROM local_credentials lc JOIN users u ON u.id=lc.user_id
       WHERE lc.username=$1 FOR UPDATE`, [username]);
    if (!result.rows[0]) throw new LoginRejected('账号不存在。');
    return result.rows[0];
  }

  private async requireAnotherAdmin(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(`SELECT lc.user_id FROM local_credentials lc JOIN users u ON u.id=lc.user_id
      WHERE u.is_system_admin=true AND lc.user_id<>$1 AND lc.locked_until<=clock_timestamp() FOR UPDATE`, [userId]);
    if (!result.rows.length) throw new LoginRejected('不能删除或降权最后一个可用的本地管理员，请先创建或解锁其他本地管理员。');
  }

  private async rotatePassword(client: PoolClient, userId: string, passwordHash: string): Promise<void> {
    await client.query(`UPDATE local_credentials SET password_hash=$2,credential_version=gen_random_uuid(),
      failed_attempts=0,locked_until=now(),updated_at=now() WHERE user_id=$1`, [userId, passwordHash]);
    await this.revokeLocalSessions(client, userId);
  }

  private async revokeLocalSessions(client: PoolClient, userId: string): Promise<void> {
    await client.query("UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1 AND auth_source='local' AND revoked_at IS NULL", [userId]);
  }
}
