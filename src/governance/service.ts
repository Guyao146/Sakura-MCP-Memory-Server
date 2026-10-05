import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { MemoryRepository } from '../memory/repository.js';
import type { MemoryRecord } from '../memory/types.js';

export type ConflictResolution = 'keep_a' | 'keep_b' | 'merge' | 'dismiss';

export class MemoryGovernanceService {
  private readonly memories: MemoryRepository;
  constructor(private readonly database: Database) { this.memories = new MemoryRepository(database); }

  async listConflicts(userId: string, spaceId: string, status: 'open'|'resolved'|'dismissed' = 'open', limit = 200) {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const result = await this.database.query(
      `SELECT mc.*,a.type AS memory_a_type,a.content AS memory_a_content,a.summary AS memory_a_summary,
       b.type AS memory_b_type,b.content AS memory_b_content,b.summary AS memory_b_summary
       FROM memory_conflicts mc JOIN memories a ON a.id=mc.memory_a_id JOIN memories b ON b.id=mc.memory_b_id
       WHERE mc.space_id=$1 AND mc.status=$2 ORDER BY mc.created_at DESC LIMIT $3`, [spaceId, status, limit]);
    return result.rows;
  }

  /** Optional post-write governance must never turn a committed write into a failure. */
  async detectAfterWrite(userId: string, memoryId: string) {
    try {
      const memory = await this.memories.get(userId, memoryId);
      const role = await requireSpaceRole(this.database, userId, memory.space_id, 'contributor');
      if (role === 'contributor') return { status: 'skipped' as const, reason: 'editor_required' };
      return { status: 'completed' as const, ...await this.detect(userId, memoryId) };
    } catch {
      return { status: 'deferred' as const, reason: 'Post-write governance was not completed; the memory is stored.' };
    }
  }

  async detect(userId: string, memoryId: string) {
    const memory = await this.memories.get(userId, memoryId);
    await requireSpaceRole(this.database, userId, memory.space_id, 'editor');
    const exact = await this.database.query<{ id: string }>(
      `SELECT id FROM memories WHERE space_id=$1 AND id<>$2 AND status='active' AND deleted_at IS NULL
       AND lower(trim(regexp_replace(content,'\\s+',' ','g')))=lower(trim(regexp_replace($3,'\\s+',' ','g')))
       ORDER BY created_at LIMIT 1`, [memory.space_id, memory.id, memory.content]);
    if (exact.rows[0]) {
      await this.link(userId, memory.id, exact.rows[0].id, 'duplicate_of', 1);
      return { duplicateOf: exact.rows[0].id, conflicts: [] };
    }

    const vector = await this.database.query<{ embedding: string; dimensions: number; model: string }>(
      `SELECT embedding::text,dimensions,model FROM memory_embeddings WHERE memory_id=$1 AND status='ready'`, [memory.id]);
    if (!vector.rows[0]) return { duplicateOf: null, conflicts: [] };
    const source = vector.rows[0];
    // Rank candidates by pgvector cosine distance (= 1 - similarity) inside
    // PostgreSQL. The previous implementation shipped up to 500 embedding
    // strings (~750 KB at 1536 dimensions) to Node for a JS cosine loop on
    // every write; only the surviving ids now cross the wire.
    const similar = await this.database.query<{ id: string; distance: number }>(
      `SELECT m.id, me.embedding <=> $4::vector AS distance FROM memories m JOIN memory_embeddings me ON me.memory_id=m.id
       WHERE m.space_id=$1 AND m.id<>$2 AND m.status='active' AND m.deleted_at IS NULL
       AND me.status='ready' AND me.dimensions=$3 AND me.model=$5
       AND me.embedding <=> $4::vector <= $6
       ORDER BY me.embedding <=> $4::vector LIMIT 20`,
      [memory.space_id, memory.id, source.dimensions, source.embedding, source.model, 1 - CONFLICT_SIMILARITY]);
    const conflicts = [];
    for (const candidate of similar.rows) {
      const similarity = 1 - candidate.distance;
      const result = await this.database.query<{ id: string }>(
        `INSERT INTO memory_conflicts(space_id,memory_a_id,memory_b_id,reason)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
        [memory.space_id, memory.id, candidate.id, `Potential semantic conflict or overlap (${similarity.toFixed(3)} similarity). Human review required.`]);
      if (result.rows[0]) conflicts.push({ id: result.rows[0].id, memoryId: candidate.id, similarity });
    }
    return { duplicateOf: null, conflicts };
  }

  async resolve(userId: string, conflictId: string, resolution: ConflictResolution, merged?: { content: string; summary?: string; tags?: string[] }) {
    const initial=await this.database.query<{space_id:string}>('SELECT space_id FROM memory_conflicts WHERE id=$1',[conflictId]);
    if(!initial.rows[0])throw new Error('Open conflict not found.');
    await requireSpaceRole(this.database,userId,initial.rows[0].space_id,'editor');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM spaces WHERE id=$1 FOR UPDATE',[initial.rows[0].space_id]);
      const result = await client.query<{ space_id: string; memory_a_id: string; memory_b_id: string; status: string }>(
        `SELECT space_id,memory_a_id,memory_b_id,status FROM memory_conflicts WHERE id=$1 FOR UPDATE`, [conflictId]);
      const conflict = result.rows[0];
      if (!conflict || conflict.status !== 'open') throw new Error('Open conflict not found.');
      const currentMembers=await client.query<{role:string}>('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[conflict.space_id,userId]);
      if(!['owner','admin','editor'].includes(currentMembers.rows[0]?.role))throw new Error('Space access denied.');
      if (resolution === 'keep_a' || resolution === 'keep_b') {
        const winner = resolution === 'keep_a' ? conflict.memory_a_id : conflict.memory_b_id;
        const loser = resolution === 'keep_a' ? conflict.memory_b_id : conflict.memory_a_id;
        await client.query(`UPDATE memories SET status='superseded',updated_at=now() WHERE id=$1`, [loser]);
        await client.query(`UPDATE memories SET supersedes_id=$2,updated_at=now() WHERE id=$1`, [winner, loser]);
        await client.query(
          `INSERT INTO memory_relations(space_id,from_memory_id,to_memory_id,relation_type,confidence,created_by)
           VALUES($1,$2,$3,'superseded_by',1,$4) ON CONFLICT DO NOTHING`, [conflict.space_id, loser, winner, userId]);
      } else if (resolution === 'merge') {
        if (!merged?.content) throw new Error('Merged content is required.');
        const current = await client.query<MemoryRecord>('SELECT * FROM memories WHERE id=$1 FOR UPDATE', [conflict.memory_a_id]);
        const version = await client.query<{ next: number }>('SELECT coalesce(max(version),0)+1 AS next FROM memory_versions WHERE memory_id=$1', [conflict.memory_a_id]);
        const updated = await client.query<MemoryRecord>(
          `UPDATE memories SET content=$2,summary=$3,tags=$4,updated_at=now() WHERE id=$1 RETURNING *`,
          [conflict.memory_a_id, merged.content, merged.summary ?? '', merged.tags ?? []]);
        await client.query(`INSERT INTO memory_versions(memory_id,version,snapshot,changed_by,reason) VALUES($1,$2,$3,$4,'conflict merge')`,
          [conflict.memory_a_id, version.rows[0].next, updated.rows[0], userId]);
        await client.query(`UPDATE memories SET status='superseded',updated_at=now() WHERE id=$1`, [conflict.memory_b_id]);
        await client.query(`UPDATE memories SET supersedes_id=$2,updated_at=now() WHERE id=$1`, [conflict.memory_a_id, conflict.memory_b_id]);
        await client.query(
          `INSERT INTO memory_relations(space_id,from_memory_id,to_memory_id,relation_type,confidence,created_by)
           VALUES($1,$2,$3,'merged_into',1,$4) ON CONFLICT DO NOTHING`, [conflict.space_id, conflict.memory_b_id, conflict.memory_a_id, userId]);
        void current;
      }
      const status = resolution === 'dismiss' ? 'dismissed' : 'resolved';
      await client.query(
        `UPDATE memory_conflicts SET status=$2,resolution=$3,resolved_by=$4,resolved_at=now() WHERE id=$1`,
        [conflictId, status, { action: resolution, merged }, userId]);
      await client.query('COMMIT');
      return { conflictId, status, resolution };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async link(userId: string, fromId: string, toId: string, relationType: string, confidence: number) {
    const [from, to] = await Promise.all([this.memories.get(userId, fromId), this.memories.get(userId, toId)]);
    if (from.space_id !== to.space_id) throw new Error('Memory relations cannot cross spaces.');
    if (from.id === to.id) throw new Error('A memory cannot relate to itself.');
    await requireSpaceRole(this.database, userId, from.space_id, 'editor');
    const result = await this.database.query(
      `INSERT INTO memory_relations(space_id,from_memory_id,to_memory_id,relation_type,confidence,created_by)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(from_memory_id,to_memory_id,relation_type)
       DO UPDATE SET confidence=EXCLUDED.confidence RETURNING *`,
      [from.space_id, fromId, toId, relationType, confidence, userId]);
    return result.rows[0];
  }

  async feedback(userId: string, memoryId: string, helpful?: boolean, correction?: string) {
    const memory = await this.memories.get(userId, memoryId);
    await requireSpaceRole(this.database, userId, memory.space_id, 'viewer');
    await this.database.query(
      `INSERT INTO memory_feedback(memory_id,user_id,helpful,correction) VALUES($1,$2,$3,$4)
       ON CONFLICT(memory_id,user_id) DO UPDATE SET helpful=EXCLUDED.helpful,correction=EXCLUDED.correction,updated_at=now()`,
      [memoryId, userId, helpful ?? null, correction ?? null]);
    return { memoryId, helpful: helpful ?? null, correction: correction ?? null };
  }
}

/** Memories whose embedding cosine similarity is at least this high are flagged for human review. */
const CONFLICT_SIMILARITY = 0.88;