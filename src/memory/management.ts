import { z } from 'zod/v4';
import type { Database } from '../database.js';
import { requireSpaceRole } from './permissions.js';

export const browseSchema = z.object({
  space_id: z.uuid(), query: z.string().max(2000).default(''),
  status: z.enum(['active','pending_confirmation','archived','superseded','deleted','all']).default('active'),
  type: z.enum(['fact','preference','event','task','person','project','summary','document','idea','other']).optional(),
  tag: z.string().max(80).optional(), sort: z.enum(['newest','oldest','importance']).default('newest'),
  page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(30)
});
export class MemoryManagement {
  constructor(private readonly database: Database) {}
  async browse(userId: string, input: z.infer<typeof browseSchema>) {
    await requireSpaceRole(this.database,userId,input.space_id,'viewer');
    const where = `space_id=$1 AND ($2='' OR content ILIKE '%'||$2||'%' OR summary ILIKE '%'||$2||'%')
      AND (($3='deleted' AND deleted_at IS NOT NULL) OR ($3<>'deleted' AND deleted_at IS NULL AND ($3='all' OR status::text=$3)))
      AND ($4::text IS NULL OR type::text=$4) AND ($5::text IS NULL OR $5=ANY(tags))`;
    const args = [input.space_id,input.query,input.status,input.type ?? null,input.tag ?? null];
    const order = {newest:'created_at DESC,id DESC',oldest:'created_at,id',importance:'importance DESC,created_at DESC,id DESC'}[input.sort];
    const [rows,count] = await Promise.all([
      this.database.query(`SELECT id,type,summary,left(content,2000) AS content_preview,tags,status,importance,created_at,updated_at,deleted_at FROM memories WHERE ${where} ORDER BY ${order} LIMIT $6 OFFSET $7`,[...args,input.limit,(input.page-1)*input.limit]),
      this.database.query<{total:string}>(`SELECT count(*)::text AS total FROM memories WHERE ${where}`,args)
    ]);
    return {memories:rows.rows,total:Number(count.rows[0].total),page:input.page,limit:input.limit};
  }
  async detail(userId: string, id: string) {
    const memory = await this.database.query(`SELECT m.* FROM memories m JOIN space_members sm ON sm.space_id=m.space_id
      JOIN spaces s ON s.id=m.space_id WHERE m.id=$1 AND sm.user_id=$2 AND s.deleted_at IS NULL`,[id,userId]);
    if(!memory.rows[0]) throw new Error('Memory not found.');
    await requireSpaceRole(this.database,userId,memory.rows[0].space_id,'viewer');
    return memory.rows[0];
  }
  async history(userId: string,id: string,page=1) {
    await this.detail(userId,id);
    const rows = await this.database.query(`SELECT version,reason,changed_by,created_at FROM memory_versions WHERE memory_id=$1 ORDER BY version DESC LIMIT 50 OFFSET $2`,[id,(page-1)*50]);
    return {versions:rows.rows,page};
  }
  async version(userId: string,id: string,version: number) {
    await this.detail(userId,id);
    const result=await this.database.query('SELECT version,snapshot,reason,created_at FROM memory_versions WHERE memory_id=$1 AND version=$2',[id,version]);
    if(!result.rows[0]) throw new Error('Version not found.');
    return result.rows[0];
  }
  async change(userId: string,spaceId: string,ids: string[],action: 'archive'|'delete'|'restore'|'purge',version?: number) {
    if(!ids.length||ids.length>100||new Set(ids).size!==ids.length) throw new Error('Select 1–100 distinct memories.');
    await requireSpaceRole(this.database,userId,spaceId,action==='purge'?'admin':'editor');
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // Same lock order as quota/owner changes: space before memory.
      const lockedSpace=await client.query('SELECT id FROM spaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[spaceId]);
      const member=await client.query('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[spaceId,userId]);
      if(!lockedSpace.rows.length||!(action==='purge'?['owner','admin']:['owner','admin','editor']).includes(member.rows[0]?.role))throw new Error('Memory management permission revoked.');
      const rows=await client.query('SELECT * FROM memories WHERE space_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[spaceId,ids]);
      if(rows.rows.length!==ids.length) throw new Error('Memory not found in this space.');
      for(const memory of rows.rows) {
        if(memory.deleted_at&&action==='archive')throw new Error('Restore a trashed memory before archiving it.');
        if(action==='purge') {
          if(!memory.deleted_at) throw new Error('Only trashed memories can be permanently deleted.');
          await client.query('DELETE FROM memories WHERE id=$1',[memory.id]); continue;
        }
        if(version!==undefined) {
          if(ids.length!==1||action!=='restore') throw new Error('Version restore requires one memory.');
          const old=await client.query('SELECT snapshot FROM memory_versions WHERE memory_id=$1 AND version=$2',[memory.id,version]);
          if(!old.rows[0]) throw new Error('Version not found.');
          const s=old.rows[0].snapshot;
          await client.query(`UPDATE memories SET content=$2,summary=$3,tags=$4,type=$5,importance=$6,confidence=$7,sensitivity=$8,
            valid_from=$9,valid_until=$10,expires_at=$11,status=$12,deleted_at=NULL WHERE id=$1`,
            [memory.id,s.content,s.summary,s.tags,s.type,s.importance,s.confidence,s.sensitivity,s.valid_from??null,s.valid_until??null,s.expires_at??null,s.status==='deleted'?'active':s.status]);
        }
        const status=action==='archive'?'archived':action==='delete'?'deleted':'active';
        const updated=await client.query(`UPDATE memories SET status=CASE WHEN $3::boolean THEN status ELSE $2::memory_status END,deleted_at=CASE WHEN $2='deleted' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
          [memory.id,status,version!==undefined]);
        await client.query(`INSERT INTO memory_versions(memory_id,version,snapshot,changed_by,reason)
          SELECT $1,coalesce(max(version),0)+1,$2,$3,$4 FROM memory_versions WHERE memory_id=$1`,
          [memory.id,updated.rows[0],userId,version===undefined?action:`restore version ${version}`]);
      }
      await client.query('COMMIT'); return {changed:ids.length};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
}
