import { describe, expect, it, vi } from 'vitest';
import { MemoryTransferService } from '../src/transfer/service.js';
import type { Database } from '../src/database.js';

const memory = (index: number) => ({
  id: `m${index}`, type: 'fact', content: `Memory ${index}`, summary: `Summary ${index}`, tags: ['t'],
  importance: 0.5, confidence: 0.5, sensitivity: 0, status: 'active', valid_from: null, valid_until: null,
  expires_at: null, created_at: `2024-01-${String(1 + index).padStart(2, '0')}`, updated_at: null, sources: []
});

/** A database that serves export queries from an in-memory fixture. */
function fakeDatabase(memories: ReturnType<typeof memory>[]) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    if (sql.includes('SELECT sm.role')) return { rows: [{ role: 'owner' }] };
    if (sql.includes('FROM spaces WHERE')) return { rows: [{ name: 'Export Space', description: 'demo' }] };
    if (sql.includes('FROM memories m LEFT JOIN memory_sources')) {
      const cursorCreatedAt = args[1] as string | null;
      const cursorId = args[2] as string | null;
      const start = memories.findIndex(item =>
        !cursorCreatedAt || (item.created_at > cursorCreatedAt || (item.created_at === cursorCreatedAt && item.id > cursorId!)));
      return { rows: memories.slice(start, start + (args[3] as number)) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { database: { query } as unknown as Database, calls };
}

describe('paginated export', () => {
  it('reads the whole space in bounded keyset pages and keeps the JSON shape', async () => {
    const memories = Array.from({ length: 7 }, (_, index) => memory(index));
    const { database, calls } = fakeDatabase(memories);
    const transfer = new MemoryTransferService(database, {} as never, {} as never);
    const exported = await transfer.export('user', 'space', 'json', { batchSize: 3 });
    expect(exported.rowCount).toBe(7);
    expect(exported.truncated).toBe(false);
    const parsed = JSON.parse(exported.content);
    expect(parsed.schema).toBe('sakura-memory-export/v1');
    expect(parsed.space).toEqual({ name: 'Export Space', description: 'demo' });
    expect(parsed.memories.map((item: { id: string }) => item.id)).toEqual(memories.map(item => item.id));
    // Every batch query is page-sized and keyset-paginated.
    const batches = calls.filter(call => call.sql.includes('LEFT JOIN memory_sources'));
    expect(batches).toHaveLength(3);
    for (const [index, batch] of batches.entries()) {
      expect(batch.sql).toContain('ORDER BY m.created_at,m.id LIMIT $4');
      expect(batch.args[3]).toBe(3);
      // Batch N restarts after the last row of batch N-1 (keyset cursor).
      if (index === 0) expect(batch.args[1]).toBeNull();
      else expect(batch.args[1]).toBe(memories[index * 3 - 1].created_at);
    }
  });

  it('hard-caps the export and reports truncation for both formats', async () => {
    const memories = Array.from({ length: 20 }, (_, index) => memory(index));
    const json = await new MemoryTransferService(fakeDatabase(memories).database, {} as never, {} as never)
      .export('user', 'space', 'json', { batchSize: 6, maxRows: 9 });
    expect(json.rowCount).toBe(9);
    expect(json.truncated).toBe(true);
    const parsed = JSON.parse(json.content);
    expect(parsed.memories).toHaveLength(9);
    expect(parsed.truncated).toBe(true);
    expect(parsed.maxRows).toBe(9);
    const markdown = await new MemoryTransferService(fakeDatabase(memories).database, {} as never, {} as never)
      .export('user', 'space', 'markdown', { batchSize: 6, maxRows: 4 });
    expect(markdown.rowCount).toBe(4);
    expect(markdown.truncated).toBe(true);
    expect(markdown.content.match(/^## /gm)).toHaveLength(4);
  });

  it('preserves microsecond precision in export cursors across pages', async () => {
    const calls:unknown[][]=[];
    const query=vi.fn(async(sql:string,args:unknown[])=>{
      if(sql.includes('SELECT sm.role'))return {rows:[{role:'owner'}]};
      if(sql.includes('FROM spaces WHERE'))return {rows:[{name:'test',description:''}]};
      calls.push(args);expect(sql).toContain('m.created_at::text AS created_at');
      return {rows:calls.length===1?[{...memory(1),created_at:'2026-01-01 00:00:00.123456+00'}]:[]};
    });
    const result=await new MemoryTransferService({query} as never,{} as never,{} as never).export('u','s','json',{batchSize:1});
    expect(result.rowCount).toBe(1);expect(calls[1][1]).toBe('2026-01-01 00:00:00.123456+00');
  });

  it('rejects oversized buffered exports instead of building an unbounded response',async()=>{
    const memories=Array.from({length:18},(_,i)=>({...memory(i),content:'x'.repeat(1000000)}));
    await expect(new MemoryTransferService(fakeDatabase(memories).database,{} as never,{} as never).export('u','s','json')).rejects.toThrow('16 MiB');
  });

  it('produces an empty export for an empty space', async () => {
    const { database } = fakeDatabase([]);
    const transfer = new MemoryTransferService(database, {} as never, {} as never);
    const exported = await transfer.export('user', 'space', 'json');
    expect(exported.rowCount).toBe(0);
    expect(JSON.parse(exported.content).memories).toEqual([]);
  });
});