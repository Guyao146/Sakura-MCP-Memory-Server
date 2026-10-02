import type { Database } from '../database.js';
import { requireSpaceRole } from './permissions.js';
import type { MemoryRecord, RememberInput } from './types.js';

export class MemoryRepository {
  constructor(private readonly database: Database) {}

  async ensureUser(subject: string, profile?: { email?: string; displayName?: string; adminByGroup?: boolean }): Promise<{ userId: string; personalSpaceId: string }> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `INSERT INTO users(oidc_subject, email, display_name, last_login_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (oidc_subject) DO UPDATE SET email=coalesce(EXCLUDED.email,users.email),
         display_name=coalesce(EXCLUDED.display_name,users.display_name),last_login_at=now(),updated_at=now()
         RETURNING id`, [subject, profile?.email ?? null, profile?.displayName ?? subject]);
      const userId = result.rows[0].id;
      const allowlisted = profile?.email
        ? (await client.query('SELECT 1 FROM system_admin_allowlist WHERE lower(email)=lower($1)', [profile.email])).rowCount === 1
        : false;
      if (profile?.adminByGroup === undefined) {
        // No usable group information: only ever promote, never revoke.
        if (allowlisted) await client.query('UPDATE users SET is_system_admin=true WHERE id=$1', [userId]);
      } else {
        // Authentik groups are authoritative when configured and present, but the
        // installation administrator stays an administrator regardless of groups.
        await client.query('UPDATE users SET is_system_admin=$2 WHERE id=$1', [userId, allowlisted || profile.adminByGroup]);
      }
      const space = await client.query<{ id: string }>(
        `INSERT INTO spaces(type,name,description,created_by) VALUES('personal','Personal Memory','Private long-term memory', $1)
         ON CONFLICT (created_by) WHERE type='personal' AND deleted_at IS NULL DO UPDATE SET updated_at=spaces.updated_at
         RETURNING id`, [userId]);
      await client.query(
        `INSERT INTO space_members(space_id,user_id,role) VALUES($1,$2,'owner')
         ON CONFLICT(space_id,user_id) DO UPDATE SET role='owner'`, [space.rows[0].id, userId]);
      await client.query('COMMIT');
      return { userId, personalSpaceId: space.rows[0].id };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async remember(userId: string, input: RememberInput): Promise<MemoryRecord> {
    await requireSpaceRole(this.database, userId, input.spaceId, 'contributor');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const memory = await client.query<MemoryRecord>(
        `INSERT INTO memories(space_id,type,content,summary,tags,importance,confidence,sensitivity,valid_from,valid_until,expires_at,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.spaceId, input.type, input.content, input.summary ?? '', input.tags ?? [], input.importance ?? 0.5,
          input.confidence ?? 1, input.sensitivity ?? 0, input.validFrom ?? null, input.validUntil ?? null, input.expiresAt ?? null, userId]);
      if (input.source) await client.query(
        `INSERT INTO memory_sources(memory_id,source_type,source_uri,source_agent,excerpt,metadata) VALUES($1,$2,$3,$4,$5,$6)`,
        [memory.rows[0].id, input.source.type, input.source.uri ?? null, input.source.agent ?? null, input.source.excerpt ?? null, input.source.metadata ?? {}]);
      await client.query(`INSERT INTO memory_versions(memory_id,version,snapshot,changed_by,reason) VALUES($1,1,$2,$3,'created')`, [memory.rows[0].id, memory.rows[0], userId]);
      await client.query('COMMIT');
      return memory.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async get(userId: string, memoryId: string): Promise<MemoryRecord> {
    const result = await this.database.query<MemoryRecord>(
      `SELECT m.* FROM memories m JOIN space_members sm ON sm.space_id=m.space_id
       WHERE m.id=$1 AND sm.user_id=$2 AND m.deleted_at IS NULL`, [memoryId, userId]);
    if (!result.rows[0]) throw new Error('Memory not found or access denied.');
    await this.database.query('UPDATE memories SET last_accessed_at=now() WHERE id=$1', [memoryId]);
    return result.rows[0];
  }

  async spaceForMemory(userId: string, memoryId: string): Promise<string> {
    const result = await this.database.query<{ space_id: string }>(
      `SELECT m.space_id FROM memories m JOIN space_members sm ON sm.space_id=m.space_id
       WHERE m.id=$1 AND sm.user_id=$2 AND m.deleted_at IS NULL`, [memoryId, userId]);
    if (!result.rows[0]) throw new Error('Memory not found or access denied.');
    return result.rows[0].space_id;
  }

  async search(userId: string, spaceId: string, query: string, limit: number, types?: string[], tags?: string[]): Promise<MemoryRecord[]> {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const result = await this.database.query<MemoryRecord>(
      `SELECT m.*, ts_rank_cd(m.search_vector, websearch_to_tsquery('simple',$3)) AS rank
       FROM memories m WHERE m.space_id=$1 AND m.status IN ('active','pending_confirmation') AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > now())
       AND ($3 = '' OR m.search_vector @@ websearch_to_tsquery('simple',$3) OR m.content ILIKE '%' || $3 || '%')
       AND ($4::text[] IS NULL OR m.type::text = ANY($4)) AND ($5::text[] IS NULL OR m.tags && $5)
       ORDER BY rank DESC, m.importance DESC, m.updated_at DESC LIMIT $2`,
      [spaceId, limit, query, types?.length ? types : null, tags?.length ? tags : null]);
    return result.rows;
  }

  async update(userId: string, memoryId: string, patch: { content?: string; summary?: string; tags?: string[]; importance?: number; confidence?: number; status?: string }, reason: string): Promise<MemoryRecord> {
    const current = await this.get(userId, memoryId);
    await requireSpaceRole(this.database, userId, current.space_id, 'editor');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM memories WHERE id=$1 FOR UPDATE', [memoryId]);
      const version = await client.query<{ next: number }>('SELECT coalesce(max(version),0)+1 AS next FROM memory_versions WHERE memory_id=$1', [memoryId]);
      const result = await client.query<MemoryRecord>(
        `UPDATE memories SET content=coalesce($2,content),summary=coalesce($3,summary),tags=coalesce($4,tags),
         importance=coalesce($5,importance),confidence=coalesce($6,confidence),status=coalesce($7::memory_status,status),updated_at=now()
         WHERE id=$1 RETURNING *`, [memoryId, patch.content ?? null, patch.summary ?? null, patch.tags ?? null, patch.importance ?? null, patch.confidence ?? null, patch.status ?? null]);
      await client.query('INSERT INTO memory_versions(memory_id,version,snapshot,changed_by,reason) VALUES($1,$2,$3,$4,$5)', [memoryId, version.rows[0].next, result.rows[0], userId, reason]);
      await client.query('COMMIT'); return result.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async forget(userId: string, memoryId: string, permanent: boolean): Promise<void> {
    const current = await this.get(userId, memoryId);
    await requireSpaceRole(this.database, userId, current.space_id, permanent ? 'admin' : 'editor');
    if (permanent) await this.database.query('DELETE FROM memories WHERE id=$1', [memoryId]);
    else await this.database.query(`UPDATE memories SET status='deleted',deleted_at=now(),updated_at=now() WHERE id=$1`, [memoryId]);
  }
}