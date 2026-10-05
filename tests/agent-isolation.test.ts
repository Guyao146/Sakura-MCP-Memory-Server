import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { createServer } from '../src/tools.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { AuditLogger, summarizeArguments, sanitize } from '../src/audit.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());
describe('Agent space isolation', () => {
  it.each(['background_job_status','background_job_cancel','background_job_retry','memory_import_status'])('denies %s in an ungranted space through the actual tool callback', async name => {
    const handlers = new Map<string, Function>();
    const original = McpServer.prototype.registerTool;
    vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function(this: McpServer, tool, options, handler) {
      handlers.set(tool, handler); return original.call(this, tool, options, handler);
    });
    vi.spyOn(MemoryRepository.prototype, 'ensureUser').mockResolvedValue({ userId: 'owner', personalSpaceId: 'personal' });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('agent_space_grants')) return { rows: [] };
      if (sql.includes('SELECT sm.role')) return { rows: [{ role: 'owner' }] };
      return { rows: [{ id: 'job', space_id: 'ungranted' }] };
    });
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused', CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
    const server = createServer({ query } as never, { id: 'owner', agentId: 'agent', source: 'api_key', scopes: ['memory:read','space:manage'], expiresAt: Infinity },
      { write: async () => {} } as never, () => config);
    try {
      const result = await handlers.get(name)!({ job_id: 'job' }, { mcpReq: { signal: new AbortController().signal } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not granted');
      expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE ingestion_jobs'))).toBe(false);
    } finally { await server.close(); }
  });

  it.each(['memory_browse','memory_history'])('denies %s for a live Agent without space grants',async name=>{
    const handlers=new Map<string,Function>(),original=McpServer.prototype.registerTool;
    vi.spyOn(McpServer.prototype,'registerTool').mockImplementation(function(this:McpServer,tool,options,handler){handlers.set(tool,handler);return original.call(this,tool,options,handler);});
    vi.spyOn(MemoryRepository.prototype,'ensureUser').mockResolvedValue({userId:'owner',personalSpaceId:'personal'});
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('agent_space_grants')?[]:sql.includes('SELECT sm.role')?[{role:'owner'}]:[{id:'m',space_id:'private'}]}));
    const config=loadConfig({PUBLIC_BASE_URL:'http://localhost',DATABASE_URL:'postgresql://unused',CONFIG_ENCRYPTION_KEY:Buffer.alloc(32).toString('base64url')});
    const server=createServer({query} as never,{id:'owner',agentId:'agent',source:'api_key',scopes:['memory:read'],expiresAt:Infinity},{write:async()=>{}} as never,()=>config);
    try{const result=await handlers.get(name)!({memory_id:'m',space_id:'private',page:1},{mcpReq:{signal:new AbortController().signal}});expect(result.isError).toBe(true);expect(result.content[0].text).toContain('not granted');}finally{await server.close();}
  });

  it('filters unscoped audit queries by live Agent grants', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await new AuditLogger('', { query } as never).list('owner', { agentId: 'agent', limit: 100 });
    const [sql, args] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('asg.space_id=al.space_id');
    expect(sql).toContain("'memory:read'=ANY(asg.scopes)");
    expect(sql).toContain('ac.revoked_at IS NULL');
    expect(sql).toContain('member.user_id=$2');
    expect(sql).toContain('s.deleted_at IS NULL');
    expect(args[7]).toBe('agent');
  });

  it('never includes free-form tool arguments in the audit summary', () => {
    const summary = sanitize(summarizeArguments({ text: 'secret conversation', summary: 'private', query: 'search secret',
      reason: 'private reason', tags: ['private tag'], limit: 5, memory_id: '10000000-0000-4000-8000-000000000001' }));
    expect(JSON.stringify(summary)).not.toMatch(/secret conversation|private|search secret/);
    expect(summary).toMatchObject({ text: '[REDACTED]', limit: 5, query: { length: 13 } });
  });
});
