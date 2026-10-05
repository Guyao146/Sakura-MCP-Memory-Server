import { z } from 'zod/v4';
import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { providerMetrics } from '../providers/metrics.js';
export const quotaSchema=z.object({max_memories:z.number().int().min(1).max(10000000).nullable(),
  max_content_bytes:z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER).nullable(),
  max_provider_calls_daily:z.number().int().min(1).max(10000000).nullable()});
export class OperationsService {
  constructor(private readonly database:Database){}
  async space(userId:string,id:string){
    await requireSpaceRole(this.database,userId,id,'viewer');
    const [quota,usage,provider]=await Promise.all([
      this.database.query('SELECT max_memories,max_content_bytes,max_provider_calls_daily FROM spaces WHERE id=$1',[id]),
      this.database.query(`SELECT count(*) FILTER(WHERE deleted_at IS NULL)::text AS memories,coalesce(sum(octet_length(content)) FILTER(WHERE deleted_at IS NULL),0)::text AS content_bytes,count(*) FILTER(WHERE deleted_at IS NOT NULL)::text AS trashed FROM memories WHERE space_id=$1`,[id]),
      this.database.query('SELECT day,calls,failures,duration_ms FROM provider_usage WHERE space_id=$1 ORDER BY day DESC LIMIT 30',[id])]);
    return {quota:quota.rows[0],usage:usage.rows[0],provider:provider.rows};
  }
  async quota(userId:string,id:string,value:z.infer<typeof quotaSchema>){
    await requireSpaceRole(this.database,userId,id,'owner');
    const client=await this.database.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT id FROM spaces WHERE id=$1 FOR NO KEY UPDATE',[id]);
      const role=await client.query('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[id,userId]);
      if(role.rows[0]?.role!=='owner')throw new Error('Space owner permission is required.');
      await client.query('UPDATE spaces SET max_memories=$2,max_content_bytes=$3,max_provider_calls_daily=$4 WHERE id=$1',[id,value.max_memories,value.max_content_bytes,value.max_provider_calls_daily]);
      await client.query('COMMIT');return {saved:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async system(){
    const [queue,embeddings,size]=await Promise.all([
      this.database.query('SELECT status,count(*)::text AS count FROM ingestion_jobs GROUP BY status'),
      this.database.query('SELECT status,count(*)::text AS count FROM memory_embeddings GROUP BY status'),
      this.database.query('SELECT pg_database_size(current_database())::text AS bytes')]);
    return {uptimeSeconds:Math.floor(process.uptime()),memory:process.memoryUsage(),provider:{...providerMetrics},queue:queue.rows,embeddings:embeddings.rows,database:size.rows[0]};
  }
  async cleanup(days:number){
    if(!Number.isInteger(days)||days<30||days>3650)throw new Error('Retention must be 30–3650 days.');
    const deleted=await this.database.query(`DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE created_at<now()-($1||' days')::interval ORDER BY id LIMIT 10000)`,[days]);
    await this.database.query(`DELETE FROM web_sessions WHERE expires_at<now()-interval '30 days'`);
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // Lock terminal jobs before removing payloads; retry's UPDATE takes the same lock.
      const jobs=await client.query<{id:string}>(`SELECT id FROM ingestion_jobs WHERE job_type='import_v2'
        AND status IN ('completed','cancelled','failed') AND updated_at<now()-($1||' days')::interval
        AND EXISTS(SELECT 1 FROM import_items item WHERE item.job_id=ingestion_jobs.id)
        ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`,[days]);
      await client.query('DELETE FROM import_items WHERE job_id=ANY($1::uuid[])',[jobs.rows.map(row=>row.id)]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    await this.database.query(`DELETE FROM provider_usage WHERE day<CURRENT_DATE-$1::integer`,[days]);
    return {auditDeleted:deleted.rowCount,retentionDays:days};
  }
}
