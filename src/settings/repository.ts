import type { AppConfig } from '../config.js';
import type { Database } from '../database.js';
import { ConfigCipher } from './crypto.js';
import { hashPassword, normalizeUsername } from '../security/password.js';
import type { LocalAdminInput } from '../setup/service.js';
import type { PoolClient } from 'pg';
import { APP_VERSION } from '../version.js';

export interface InstallationState {
  completed: boolean; completed_at: string | null; installed_version: string | null; administrator_email: string | null;
}

export class SettingsRepository {
  private readonly cipher: ConfigCipher;
  constructor(private readonly database: Database, encryptionKey: string) { this.cipher = new ConfigCipher(encryptionKey); }

  async installation(): Promise<InstallationState> {
    const result = await this.database.query<InstallationState>('SELECT completed,completed_at,installed_version,administrator_email FROM installation_state WHERE singleton=true');
    if (!result.rows[0]) throw new Error('Installation state is unavailable. Run database migrations.');
    return result.rows[0];
  }

  async get<T>(key: string): Promise<T | undefined> {
    const result = await this.database.query<{ value: unknown; encrypted: boolean }>('SELECT value,encrypted FROM system_settings WHERE key=$1', [key]);
    const row = result.rows[0];
    if (!row) return undefined;
    return row.encrypted ? this.cipher.decrypt<T>(row.value as Parameters<ConfigCipher['decrypt']>[0]) : row.value as T;
  }

  async apply(base: AppConfig): Promise<AppConfig> {
    const state = await this.installation();
    if (!state.completed) return base;
    const authentik = base.authEnabled ? await this.get<AppConfig['authentik']>('authentik') : undefined;
    const sakura = base.authEnabled ? await this.get<AppConfig['sakura']>('sakura') : undefined;
    const openaiCompatible = await this.get<AppConfig['openaiCompatible']>('provider.openai_compatible');
    const ollama = await this.get<AppConfig['ollama']>('provider.ollama');
    const embedding = await this.get<AppConfig['embedding']>('provider.embedding');
    const localEnabled = base.authEnabled ? await this.get<boolean>('local_login.enabled') : undefined;
    return { ...base,
      localLogin: { ...base.localLogin, enabled: base.authEnabled && (base.localLogin?.explicit ?? localEnabled ?? base.localLogin?.enabled ?? false) },
      authentik: base.authEnabled ? authentik ?? base.authentik : undefined,
      sakura: base.authEnabled ? sakura ?? base.sakura : undefined,
      openaiCompatible: openaiCompatible ?? base.openaiCompatible, ollama: ollama ?? base.ollama,
      embedding: embedding ?? base.embedding };
  }

  async saveProvider(kind: 'openai_compatible' | 'ollama' | 'embedding', value: AppConfig['openaiCompatible'] | AppConfig['ollama'] | AppConfig['embedding']): Promise<void> {
    if (!value) throw new Error('Provider configuration is required.');
    const key = `provider.${kind}`;
    const encrypted = kind === 'openai_compatible' || kind === 'embedding';
    const stored = encrypted ? this.cipher.encrypt(value) : value;
    await this.database.query(
      `INSERT INTO system_settings(key,value,encrypted) VALUES($1,$2,$3)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,encrypted=EXCLUDED.encrypted,updated_at=now()`,
      [key, stored, encrypted]);
  }

  async saveAuthentik(value: NonNullable<AppConfig['authentik']>, administratorEmail: string): Promise<void> {
    await this.saveOidcProviderSetting('authentik', value, administratorEmail);
  }

  /**
   * Stores a SakuraID (Sakura-Auth-Server) provider configuration. Unlike
   * Authentik this carries no administrator email: the installation's primary
   * administrator email belongs to whichever provider was set up first, and a
   * SakuraID user becomes an administrator through its `adminGroups` or the
   * existing email allowlist.
   */
  async saveSakura(value: NonNullable<AppConfig['sakura']>): Promise<void> {
    await this.saveOidcProviderSetting('sakura', value);
  }

  private async saveOidcProviderSetting(key: string, value: NonNullable<AppConfig['authentik']>, administratorEmail?: string): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO system_settings(key,value,encrypted) VALUES($1,$2,false)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,encrypted=false,updated_at=now()`, [key, value]);
      if (administratorEmail) {
        await client.query('INSERT INTO system_admin_allowlist(email) VALUES(lower($1)) ON CONFLICT(email) DO NOTHING',
          [administratorEmail]);
        await client.query('UPDATE installation_state SET administrator_email=lower($1),updated_at=now() WHERE singleton=true',
          [administratorEmail]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async complete(input: {
    administratorEmail?: string;
    authentik?: NonNullable<AppConfig['authentik']>;
    sakura?: NonNullable<AppConfig['sakura']>;
    localAdmin?: LocalAdminInput;
    openaiCompatible?: AppConfig['openaiCompatible'];
    ollama?: AppConfig['ollama'];
    embedding?: AppConfig['embedding'];
  }): Promise<void> {
    // Hash before opening the transaction; account creation and installation
    // completion then commit atomically, or both roll back on any failure.
    const passwordHash = input.localAdmin ? await hashPassword(input.localAdmin.password) : undefined;
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await client.query<{ completed: boolean }>('SELECT completed FROM installation_state WHERE singleton=true FOR UPDATE');
      if (state.rows[0]?.completed) throw new Error('Sakura-MCP-Server is already installed.');
      const put = async (key: string, value: unknown, encrypted: boolean) => client.query(
        `INSERT INTO system_settings(key,value,encrypted) VALUES($1,$2,$3)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,encrypted=EXCLUDED.encrypted,updated_at=now()`,
        [key, encrypted ? this.cipher.encrypt(value) : value, encrypted]);
      if (input.authentik) await put('authentik', input.authentik, false);
      else await client.query("DELETE FROM system_settings WHERE key='authentik'");
      if (input.sakura) await put('sakura', input.sakura, false);
      if (input.localAdmin) {
        await this.provisionLocalAdmin(client, input.localAdmin, passwordHash!);
        await put('local_login.enabled', true, false);
      }
      if (input.openaiCompatible) await put('provider.openai_compatible', input.openaiCompatible, true);
      if (input.ollama) await put('provider.ollama', input.ollama, false);
      if (input.embedding) await put('provider.embedding', input.embedding, true);
      if (input.administratorEmail) {
        await client.query('INSERT INTO system_admin_allowlist(email) VALUES(lower($1)) ON CONFLICT(email) DO NOTHING', [input.administratorEmail]);
      }
      await client.query(
        `UPDATE installation_state SET completed=true,completed_at=now(),installed_version=$1,administrator_email=lower($2),updated_at=now()
         WHERE singleton=true`, [APP_VERSION, input.administratorEmail ?? null]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async provisionLocalAdmin(client: PoolClient, admin: LocalAdminInput, passwordHash: string): Promise<void> {
    const username = normalizeUsername(admin.username);
    const user = await client.query<{ id: string }>(
      `INSERT INTO users(oidc_subject,email,display_name,is_system_admin,last_login_at)
       VALUES($1,$2,$3,true,now()) ON CONFLICT(oidc_subject) DO UPDATE
       SET is_system_admin=true,display_name=EXCLUDED.display_name RETURNING id`,
      [`local:${username.toLowerCase()}`, admin.email ?? null, admin.displayName || username]);
    const userId = user.rows[0].id;
    const space = await client.query<{ id: string }>(
      `INSERT INTO spaces(type,name,description,created_by) VALUES('personal','Personal Memory','Private long-term memory',$1)
       ON CONFLICT(created_by) WHERE type='personal' AND deleted_at IS NULL DO UPDATE SET updated_at=spaces.updated_at RETURNING id`, [userId]);
    await client.query(`INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'owner')
      ON CONFLICT(space_id,user_id) DO UPDATE SET role='owner'`, [space.rows[0].id, userId]);
    await client.query(
      `INSERT INTO local_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
       ON CONFLICT (username) DO UPDATE SET user_id=EXCLUDED.user_id,password_hash=EXCLUDED.password_hash,
       credential_version=gen_random_uuid(),failed_attempts=0,locked_until=now(),updated_at=now()`,
      [userId, username, passwordHash]);
    await client.query("UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1 AND auth_source='local' AND revoked_at IS NULL", [userId]);
  }
}