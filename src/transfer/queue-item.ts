import type { Database } from '../database.js';
import type { BackgroundJob } from '../jobs/repository.js';
import { importMemorySchema } from './service.js';

/** Memory and item checkpoint commit together; lease/cancel is checked under a row lock. */
export async function processImportItem(database:Database,job:BackgroundJob,workerId:string,position:number,signal:AbortSignal):Promise<string|undefined> {
  const client=await database.pool.connect();
  try {
    await client.query('BEGIN');
    const locked=await client.query('SELECT id FROM spaces WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE',[job.space_id]);
    if(!locked.rows[0])throw new Error('Space not found.');
    const owned=await client.query(`SELECT id FROM ingestion_jobs WHERE id=$1 AND status='processing' AND locked_by=$2 AND cancel_requested=false FOR UPDATE`,[job.id,workerId]);
    if(!owned.rows[0])throw new Error('Import cancelled or lease lost.');
    const role=await client.query('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[job.space_id,job.requested_by]);
    if(!['owner','admin','editor','contributor'].includes(role.rows[0]?.role))throw new Error('Import permission revoked.');
    const item=await client.query(`SELECT record,status FROM import_items WHERE job_id=$1 AND position=$2 FOR UPDATE`,[job.id,position]);
    if(!item.rows[0]||['completed','skipped'].includes(item.rows[0].status)){await client.query('COMMIT');return;}
    await client.query('SAVEPOINT import_record');
    let memoryId:string|undefined;
    try {
      const r=importMemorySchema.parse(item.rows[0].record);
      const duplicate=job.payload.duplicates!=='keep'&&(await client.query(`SELECT id FROM memories WHERE space_id=$1 AND content=$2 AND deleted_at IS NULL LIMIT 1`,[job.space_id,r.content])).rows.length>0;
      if(duplicate) await client.query(`UPDATE import_items SET status='skipped',error=NULL WHERE job_id=$1 AND position=$2`,[job.id,position]);
      else {
        const memory=await client.query(`INSERT INTO memories(space_id,created_by,type,content,summary,tags,importance,confidence,sensitivity,status,valid_from,valid_until,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[job.space_id,job.requested_by,r.type,r.content,r.summary??'',r.tags??[],r.importance??0.5,r.confidence??1,r.sensitivity??0,r.status,r.validFrom??null,r.validUntil??null,r.expiresAt??null]);
        memoryId=memory.rows[0].id;
        for(const source of r.sources??[{type:job.source_type??'import',uri:undefined,agent:undefined,excerpt:undefined,metadata:undefined}]) await client.query(`INSERT INTO memory_sources(memory_id,source_type,source_uri,source_agent,excerpt,metadata) VALUES($1,$2,$3,$4,$5,$6)`,[memoryId,source.type,source.uri??null,source.agent??null,source.excerpt??null,source.metadata??{}]);
        await client.query(`INSERT INTO memory_versions(memory_id,version,snapshot,changed_by,reason) VALUES($1,1,$2,$3,'import')`,[memoryId,memory.rows[0],job.requested_by]);
        await client.query(`UPDATE import_items SET status='completed',memory_id=$3,error=NULL WHERE job_id=$1 AND position=$2`,[job.id,position,memoryId]);
      }
    }catch(error){
      await client.query('ROLLBACK TO SAVEPOINT import_record');memoryId=undefined;
      await client.query(`UPDATE import_items SET status='failed',error=$3 WHERE job_id=$1 AND position=$2`,[job.id,position,(error instanceof Error?error.message:'Import failed').slice(0,500)]);
    }
    signal.throwIfAborted();
    await client.query(`UPDATE ingestion_jobs SET locked_at=now(),progress=(SELECT jsonb_build_object('total',count(*),'completed',count(*) FILTER(WHERE status='completed'),'failed',count(*) FILTER(WHERE status='failed'),'skipped',count(*) FILTER(WHERE status='skipped')) FROM import_items WHERE job_id=$1),updated_at=now() WHERE id=$1`,[job.id]);
    await client.query('COMMIT');return memoryId;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
