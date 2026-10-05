import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { importMemorySchema, parseJson, parseMarkdown } from './service.js';
import type { BackgroundJob } from '../jobs/repository.js';
import type { SemanticMemoryService } from '../semantic/service.js';
import { processImportItem } from './queue-item.js';

export class ImportQueue {
  constructor(private readonly database: Database) {}
  private records(format:'json'|'markdown',content:string) {
    if(Buffer.byteLength(content)>5_000_000) throw new Error('Import exceeds 5 MB.');
    const records=format==='json'?parseJson(content):parseMarkdown(content);
    if(!records.length||records.length>500) throw new Error('An import must contain 1–500 records.');
    return records;
  }
  async preview(userId:string,spaceId:string,format:'json'|'markdown',content:string) {
    await requireSpaceRole(this.database,userId,spaceId,'contributor');
    const records=this.records(format,content);
    const seen=new Set<string>();
    const items=[];
    for(let index=0;index<records.length;index++) {
      const parsed=importMemorySchema.safeParse(records[index]);
      if(!parsed.success){items.push({index,valid:false,error:parsed.error.issues.map(x=>x.path.join('.')+': '+x.message).join('; ').slice(0,500)});continue;}
      const duplicate=seen.has(parsed.data.content)||(await this.database.query(`SELECT 1 FROM memories WHERE space_id=$1 AND deleted_at IS NULL AND content=$2 LIMIT 1`,[spaceId,parsed.data.content])).rows.length>0;
      seen.add(parsed.data.content);items.push({index,valid:true,duplicate,summary:parsed.data.summary??parsed.data.content.slice(0,100)});
    }
    return {total:records.length,items};
  }
  async enqueue(userId:string,spaceId:string,format:'json'|'markdown',content:string,duplicates:'skip'|'keep') {
    await requireSpaceRole(this.database,userId,spaceId,'contributor');
    const records=this.records(format,content);
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const job=await client.query(`INSERT INTO ingestion_jobs(space_id,requested_by,source_type,job_type,payload,status,progress)
        VALUES($1,$2,$3,'import_v2',$4,'pending',$5) RETURNING id,status`,[spaceId,userId,`import_${format}`,{duplicates},{total:records.length,completed:0,failed:0,skipped:0}]);
      for(let index=0;index<records.length;index++) await client.query(`INSERT INTO import_items(job_id,position,record) VALUES($1,$2,$3)`,[job.rows[0].id,index,JSON.stringify(records[index])]);
      await client.query('COMMIT');return {jobId:job.rows[0].id,status:'pending',total:records.length};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async details(userId:string,id:string) {
    const job=await this.database.query('SELECT space_id FROM ingestion_jobs WHERE id=$1',[id]);
    if(!job.rows[0])throw new Error('Job not found.');
    await requireSpaceRole(this.database,userId,job.rows[0].space_id,'viewer');
    const rows=await this.database.query('SELECT position,status,memory_id,error FROM import_items WHERE job_id=$1 ORDER BY position',[id]);
    return {items:rows.rows};
  }
  async execute(job:BackgroundJob,workerId:string,signal:AbortSignal,semantic:SemanticMemoryService) {
    const positions=await this.database.query<{position:number}>(`SELECT position FROM import_items WHERE job_id=$1 AND status IN ('pending','failed') ORDER BY position`,[job.id]);
    for(const {position} of positions.rows) {
      signal.throwIfAborted();
      const memoryId=await processImportItem(this.database,job,workerId,position,signal);
      if(memoryId) await semantic.embedImportedMemory(job.requested_by,memoryId,signal).catch(error=>{if(signal.aborted)throw error;});
    }
    const result=await this.database.query<{total:string;completed:string;failed:string;skipped:string}>(`SELECT count(*)::text AS total,
      count(*) FILTER(WHERE status='completed')::text AS completed,count(*) FILTER(WHERE status='failed')::text AS failed,
      count(*) FILTER(WHERE status='skipped')::text AS skipped FROM import_items WHERE job_id=$1`,[job.id]);
    job.progress=Object.fromEntries(Object.entries(result.rows[0]).map(([k,v])=>[k,Number(v)]));
    if(Number(result.rows[0].failed)) throw new Error('Some import records failed; inspect item errors before retrying.');
  }
}
