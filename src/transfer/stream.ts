import { Readable } from 'node:stream';
import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { exportBatches } from './service.js';
import { operationSignal } from '../operations.js';

export async function streamingExport(database:Database,userId:string,spaceId:string,format:'json'|'markdown') {
  await requireSpaceRole(database,userId,spaceId,'viewer');
  const space=await database.query('SELECT name,description FROM spaces WHERE id=$1 AND deleted_at IS NULL',[spaceId]);
  if(!space.rows[0])throw new Error('Space not found.');
  const signal=operationSignal();
  const name=String(space.rows[0].name).replace(/[^\p{L}\p{N}._-]/gu,'-');
  async function* chunks() {
    let count=0,bytes=0,truncated=false;
    yield format==='json'?`{"schema":"sakura-memory-export/v1","space":${JSON.stringify(space.rows[0])},"memories":[`:`# ${space.rows[0].name}\n\n${space.rows[0].description}\n`;
    for await(const rows of exportBatches(database,spaceId,16)) {
      signal?.throwIfAborted();
      await requireSpaceRole(database,userId,spaceId,'viewer');
      for(const row of rows) {
        const chunk=format==='json'?(count?',':'')+JSON.stringify(row):`\n## ${row.summary||row.type}\n\n- Type: ${row.type}\n- Tags: ${(row.tags as string[]).join(', ')}\n\n${row.content}\n`;
        const size=Buffer.byteLength(chunk);
        if(count>=50000||bytes+size>256*1024*1024){truncated=true;break;}
        count++;bytes+=size;yield chunk;
      }
      if(truncated)break;
    }
    yield format==='json'?`],"truncated":${truncated},"rowCount":${count}}`:`\n<!-- rowCount: ${count}; truncated: ${truncated} -->\n`;
  }
  return {filename:`${name||'memories'}.${format==='json'?'json':'md'}`,mimeType:format==='json'?'application/json':'text/markdown',
    stream:Readable.toWeb(Readable.from(chunks(),{objectMode:false,highWaterMark:65536})) as ReadableStream<Uint8Array>};
}
