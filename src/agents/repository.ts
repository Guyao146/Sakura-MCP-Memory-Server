import { createHash, randomBytes } from 'node:crypto';
import type { Scope } from '../config.js';
import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { ConfigCipher } from '../settings/crypto.js';

export class AgentRepository {
  private readonly cipher?: ConfigCipher;
  constructor(private readonly database: Database, encryptionKey?: string) {
    if (encryptionKey) this.cipher = new ConfigCipher(encryptionKey);
  }

  async create(ownerId: string, name: string, scopes: Scope[], expiresAt?: string) {
    const prefix = randomBytes(6).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const token = `sk_sakura_${prefix}_${secret}`;
    const secretHash = createHash('sha256').update(token).digest('hex');
    const result = await this.database.query<{ id: string; name: string; key_prefix: string; scopes: Scope[]; expires_at: string | null; created_at: string }>(
      `INSERT INTO agent_credentials(owner_id,name,key_prefix,secret_hash,secret_encrypted,scopes,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,key_prefix,scopes,expires_at,created_at`,
      [ownerId, name, prefix, secretHash, this.cipher ? this.cipher.encrypt(token) : null, scopes, expiresAt ?? null]);
    return { ...result.rows[0], token };
  }

  /**
   * Returns the Agent token again so that the console can show it on demand
   * instead of only once at creation time. Throws when the credential predates
   * encrypted storage, was revoked, or is not owned by the caller.
   */
  async reveal(ownerId: string, agentId: string): Promise<{ id: string; name: string; token: string }> {
    if (!this.cipher) throw new Error('Agent secret storage is not configured.');
    const result = await this.database.query<{ id: string; name: string; secret_encrypted: unknown }>(
      'SELECT id,name,secret_encrypted FROM agent_credentials WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL',
      [agentId, ownerId]);
    const row = result.rows[0];
    if (!row) throw new Error('Agent credential not found or revoked.');
    if (!row.secret_encrypted) throw new Error('该 Agent 创建于旧版本，密钥未加密保存，无法再次查看。请撤销后重新创建。');
    return { id: row.id, name: row.name, token: this.cipher.decrypt<string>(row.secret_encrypted as Parameters<ConfigCipher['decrypt']>[0]) };
  }

  async list(ownerId: string, limit = 200) {
    const result = await this.database.query(
      `SELECT ac.id,ac.name,ac.key_prefix,ac.scopes,ac.expires_at,ac.revoked_at,ac.last_used_at,ac.created_at,
       ac.secret_encrypted IS NOT NULL AS revealable,
       coalesce(json_agg(json_build_object('space_id',asg.space_id,'scopes',asg.scopes)) FILTER (WHERE asg.space_id IS NOT NULL),'[]') AS space_grants
       FROM agent_credentials ac LEFT JOIN agent_space_grants asg ON asg.agent_id=ac.id
       WHERE ac.owner_id=$1 GROUP BY ac.id ORDER BY ac.created_at DESC LIMIT $2`, [ownerId, limit]);
    return result.rows;
  }

  async page(ownerId:string,page=1) {
    const result=await this.database.query(`SELECT id,name,key_prefix,scopes,expires_at,revoked_at,last_used_at,created_at,
      count(*) OVER()::text AS total FROM agent_credentials WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $2`,[ownerId,(page-1)*50]);
    return {agents:result.rows,page};
  }

  /**
   * Permanently deletes an Agent credential. Space grants cascade, while
   * memories and audit entries keep their history with the Agent reference set
   * to NULL. The key stops authenticating immediately because its hash is gone.
   */
  async remove(ownerId: string, agentId: string): Promise<void> {
    const result = await this.database.query('DELETE FROM agent_credentials WHERE id=$1 AND owner_id=$2', [agentId, ownerId]);
    if (!result.rowCount) throw new Error('Agent credential not found.');
  }

  async grant(ownerId: string, agentId: string, spaceId: string, scopes: Scope[]) {
    await requireSpaceRole(this.database, ownerId, spaceId, 'viewer');
    const agent = await this.database.query<{ scopes: Scope[] }>('SELECT scopes FROM agent_credentials WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL', [agentId, ownerId]);
    if (!agent.rowCount) throw new Error('Agent credential not found or revoked.');
    const invalid = scopes.filter(scope => !agent.rows[0].scopes.includes(scope));
    if (invalid.length) throw new Error(`Space grant exceeds Agent global scopes: ${invalid.join(', ')}.`);
    await this.database.query(
      `INSERT INTO agent_space_grants(agent_id,space_id,scopes) VALUES($1,$2,$3)
       ON CONFLICT(agent_id,space_id) DO UPDATE SET scopes=EXCLUDED.scopes`, [agentId, spaceId, scopes]);
    return { agentId, spaceId, scopes };
  }

  async revokeGrant(ownerId: string, agentId: string, spaceId: string): Promise<void> {
    const result = await this.database.query(
      `DELETE FROM agent_space_grants asg USING agent_credentials ac
       WHERE asg.agent_id=ac.id AND asg.agent_id=$1 AND asg.space_id=$2 AND ac.owner_id=$3`, [agentId, spaceId, ownerId]);
    if (!result.rowCount) throw new Error('Agent space grant not found.');
  }
}