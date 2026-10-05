import { OllamaProvider } from '../src/providers/ollama.js';
import { SemanticMemoryService } from '../src/semantic/service.js';
import { loadConfig } from '../src/config.js';
import { describe,it,expect,vi } from 'vitest';
import { ImportQueue } from '../src/transfer/queue.js';
import { processImportItem } from '../src/transfer/queue-item.js';
import { MemoryManagement,browseSchema } from '../src/memory/management.js';
import { MemberManagement } from '../src/spaces/management.js';
import { providerScope,reserveProviderCall } from '../src/providers/metrics.js';
import type { BackgroundJob } from '../src/jobs/repository.js';
const job:BackgroundJob={id:'j',space_id:'s',requested_by:'u',job_type:'import_v2',payload:{duplicates:'keep'},status:'processing',progress:{},attempts:1,max_attempts:3,cancel_requested:false};

describe('management permissions and transactions',()=>{
  it('bounds and parameterizes paging while excluding other spaces',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT sm.role')?[{role:'viewer'}]:sql.includes('count(*)')?[{total:'1'}]:[{id:'m'}]}));
    const input=browseSchema.parse({space_id:'11111111-1111-4111-8111-111111111111',query:"' OR true --",page:2,limit:20});
    await new MemoryManagement({query} as never).browse('u',input);
    const call=query.mock.calls.find(([sql])=>sql.includes('ORDER BY'))!;
    expect(call[0]).not.toContain(input.query);expect(call[0]).toContain('space_id=$1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('OFFSET $7'),[input.space_id,input.query,'active',null,null,20,20]);
  });
  it('rejects cross-space mutations before opening a transaction',async()=>{
    const connect=vi.fn(),query=vi.fn().mockResolvedValue({rows:[]});
    await expect(new MemoryManagement({query,pool:{connect}} as never).change('u','s',['m'],'restore')).rejects.toThrow('access denied');
    expect(connect).not.toHaveBeenCalled();
  });
  it('never removes the last owner and rolls back',async()=>{
    const release=vi.fn(),query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT type')?[{type:'shared'}]:sql.includes('SELECT user_id,role')?[{user_id:'u',role:'owner'}]:[]}));
    await expect(new MemberManagement({pool:{connect:async()=>({query,release})}} as never).change('u','s','u','remove')).rejects.toThrow('last owner');
    expect(query).toHaveBeenCalledWith('ROLLBACK');expect(query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);expect(release).toHaveBeenCalledOnce();
  });
  it('previews invalid records and in-file duplicates without writes',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT sm.role')?[{role:'contributor'}]:[]}));
    const result=await new ImportQueue({query} as never).preview('u','s','json','[{"content":"a"},{"content":"a"},{"content":""}]');
    expect(result.items).toMatchObject([{valid:true,duplicate:false},{valid:true,duplicate:true},{valid:false}]);
    expect(query.mock.calls.every(([sql])=>sql.startsWith('SELECT'))).toBe(true);
  });
  it('rejects cancelled or lost import leases before touching memories',async()=>{
    const release=vi.fn(),query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM spaces')?[{id:'s'}]:[]}));
    await expect(processImportItem({pool:{connect:async()=>({query,release})}} as never,job,'w',0,new AbortController().signal)).rejects.toThrow('lease lost');
    expect(query.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO memories'))).toBe(false);expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
  it('skips committed import checkpoints without duplicating data',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT id FROM')?[{id:'x'}]:sql.includes('SELECT role')?[{role:'contributor'}]:sql.includes('SELECT record,status')?[{status:'completed'}]:[]}));
    await processImportItem({pool:{connect:async()=>({query,release(){}})}} as never,job,'w',0,new AbortController().signal);
    expect(query).toHaveBeenCalledWith('COMMIT');expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
  });
  it('allows a contributor to embed their own import without granting edit rights over other records',async()=>{
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT sm.role')?[{role:'contributor'}]:sql.includes('LEFT JOIN space_provider_settings')?[{provider_type:null,privacy_mode:false}]:[{memory_id:'m'}]}));
    const config=loadConfig({PUBLIC_BASE_URL:'http://localhost',DATABASE_URL:'postgresql://unused',CONFIG_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64url'),OLLAMA_BASE_URL:'http://unused',OLLAMA_EMBEDDING_MODEL:'demo'});
    const service=new SemanticMemoryService({query} as never,()=>config);
    const get=vi.spyOn(service.repository,'get').mockResolvedValue({id:'m',space_id:'s',created_by:'u',content:'import',summary:'',tags:[],embedding_revision:'0'} as never);
    const embed=vi.spyOn(OllamaProvider.prototype,'embed').mockResolvedValue([[1,0]]);
    try {
      await expect(service.embedImportedMemory('u','m',new AbortController().signal)).resolves.toEqual({memoryId:'m',status:'ready'});
      expect(embed).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO memory_embeddings'),expect.arrayContaining(['ready','[1,0]']));
      get.mockResolvedValue({id:'other',space_id:'s',created_by:'another-user'} as never);
      await expect(service.embedImportedMemory('u','other',new AbortController().signal)).rejects.toThrow('Only the importer');
      expect(embed).toHaveBeenCalledOnce();
    } finally {get.mockRestore();embed.mockRestore();}
  });

  it('rolls back Provider reservations beyond the daily budget',async()=>{
    const release=vi.fn(),query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT max_provider')?[{max_provider_calls_daily:1}]:sql.includes('INSERT INTO provider_usage')?[{calls:2}]:[]}));
    const database={pool:{connect:async()=>({query,release})}};
    await expect(providerScope.run({database:database as never,spaceId:'s'},()=>reserveProviderCall())).rejects.toThrow('quota exceeded');
    expect(query).toHaveBeenCalledWith('ROLLBACK');expect(query).not.toHaveBeenCalledWith('COMMIT');expect(release).toHaveBeenCalledOnce();
  });
});
