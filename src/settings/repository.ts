import type { AppConfig } from '../config.js';
import type { Database } from '../database.js';
import { ConfigCipher } from './crypto.js';
import { hashPassword } from '../security/password.js';
import type { LocalAdminInput } from '../setup/service.js';
import { MemoryRepository } from '../memory/repository.js';
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
    const openaiCompatible = await this.get<AppConfig['openaiCompatible']>('provider.openai_compatible');
    const ollama = await this.get<AppConfig['ollama']>('provider.ollama');
    const embedding = await this.get<AppConfig['embedding']>('provider.embedding');
    return { ...base, authentik: base.authEnabled ? authentik ?? base.authentik : undefined,
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
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO system_settings(key,value,encrypted) VALUES('authentik',$1,false)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,encrypted=false,updated_at=now()`, [value]);
      await client.query('INSERT INTO system_admin_allowlist(email) VALUES(lower($1)) ON CONFLICT(email) DO NOTHING',
        [administratorEmail]);
      await client.query('UPDATE installation_state SET administrator_email=lower($1),updated_at=now() WHERE singleton=true',
        [administratorEmail]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async complete(input: {
    administratorEmail?: string;
    authentik?: NonNullable<AppConfig['authentik']>;
    localAdmin?: LocalAdminInput;
    openaiCompatible?: AppConfig['openaiCompatible'];
    ollama?: AppConfig['ollama'];
    embedding?: AppConfig['embedding'];
  }): Promise<void> {
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
    // The local admin account is provisioned after the installation row is
    // committed: it must not be possible to end up "installed" without the
    // account that the administrator was told had been created.
    if (input.localAdmin) await this.provisionLocalAdmin(input.localAdmin);
  }

  private async provisionLocalAdmin(admin: LocalAdminInput): Promise<void> {
    const identity = await new MemoryRepository(this.database).ensureUser(`local:${admin.username.toLowerCase()}`, {
      displayName: admin.displayName || admin.username, email: admin.email, adminByGroup: true
    });
    const passwordHash = await hashPassword(admin.password);
    await this.database.query(
      `INSERT INTO local_credentials(user_id,username,password_hash) VALUES($1,$2,$3)
       ON CONFLICT (username) DO UPDATE SET user_id=EXCLUDED.user_id,password_hash=EXCLUDED.password_hash,updated_at=now()`,
      [identity.userId, admin.username, passwordHash]);
  }
}