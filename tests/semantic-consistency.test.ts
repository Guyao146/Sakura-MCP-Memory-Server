import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { SemanticMemoryService } from '../src/semantic/service.js';
import { MemoryGovernanceService } from '../src/governance/service.js';
import { MemoryTransferService } from '../src/transfer/service.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { loadConfig } from '../src/config.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const memory = { id: 'memory', space_id: 'space', content: 'old', summary: '', tags: [], embedding_revision: '0' };
const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
  CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'), OLLAMA_BASE_URL: 'http://unused', OLLAMA_EMBEDDING_MODEL: 'demo' });

describe('semantic consistency', () => {
  it.each([
    { outcome: 'success', revision: '0' }, { outcome: 'failure', revision: '0' },
    { outcome: 'success', revision: '1' }, { outcome: 'failure', revision: '1' }
  ])('rejects stale $outcome with revision $revision', async ({ outcome, revision }) => {
    let current = { ...memory };
    let saved: unknown[] = [];
    const responses: Array<(response: Response) => void> = [];
    const query = vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes('SELECT sm.role')) return { rows: [{ role: 'owner' }] };
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('embedding_revision=$8');
      expect(sql).toContain('memory_embeddings.request_id=$9::uuid');
      if (args[7] !== current.embedding_revision || (saved.length && args[5] !== 'pending' && saved[8] !== args[8])) return { rows: [] };
      saved = args; return { rows: [{ memory_id: 'memory' }] };
    });
    const service = new SemanticMemoryService({ query } as never, () => config);
    vi.spyOn(service.repository, 'get').mockImplementation(async () => ({ ...current }) as never);
    vi.spyOn(service, 'strategy').mockResolvedValue({ provider_type: 'ollama', embedding_model: 'demo' } as never);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => responses.push(resolve))));
    const old = service.rebuildEmbedding('user','memory');
    while (responses.length < 1) await setImmediate();
    current = { ...current, content: revision === '1' ? 'new' : 'old', embedding_revision: revision };
    const latest = service.rebuildEmbedding('user','memory');
    while (responses.length < 2) await setImmediate();
    responses[1](Response.json({ embeddings: [[0,1]] }));
    expect((await latest).status).toBe('ready');
    responses[0](outcome === 'success' ? Response.json({ embeddings: [[1,0]] }) : new Response('error', { status: 500 }));
    expect((await old).status).toBe('superseded');
    expect(saved[3]).toBe('[0,1]');
  });

  it('ranks across the whole space in SQL with a bounded result', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT sm.role') ? [{ role: 'owner' }] : [{ id: 'old-match', score: 1 }] }));
    const service = new SemanticMemoryService({ query } as never, () => config);
    vi.spyOn(service, 'strategy').mockResolvedValue({ provider_type: 'ollama', embedding_model: 'demo' } as never);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ embeddings: [[0,1]] })));
    expect(await service.hybridSearch('user','space','old match',5)).toEqual([{ id: 'old-match', score: 1 }]);
    const sql = query.mock.calls.at(-1)![0];
    expect(sql).toContain('me.embedding <=> $5::vector');
    expect(sql).toContain('me.model=$7');
    expect(sql).toContain('ORDER BY score DESC,m.updated_at DESC,m.id LIMIT $8');
    expect(sql).not.toContain('LIMIT 1000');
  });

  it('keeps contributor writes successful while reporting skipped governance', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ role: 'contributor' }] })) };
    const service = new SemanticMemoryService(db as never, () => config);
    vi.spyOn(MemoryRepository.prototype, 'get').mockResolvedValue(memory as never);
    vi.spyOn(service, 'extract').mockResolvedValue([{ content: 'demo' }] as never);
    vi.spyOn(service, 'strategy').mockResolvedValue({ conflict_detection_enabled: true } as never);
    vi.spyOn(service, 'remember').mockResolvedValue(memory as never);
    const result = await service.extractAndRemember('user','space','demo');
    expect(result).toHaveLength(1);
    expect(result[0].governance).toMatchObject({ status: 'skipped' });
  });

  it('counts imported data as completed when post-write governance fails', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT sm.role') ? [{ role: 'owner' }] : [{ id: 'job' }] }));
    const governance = new MemoryGovernanceService({ query } as never);
    vi.spyOn(MemoryRepository.prototype, 'get').mockRejectedValue(new Error('unavailable'));
    const transfer = new MemoryTransferService({ query } as never, { remember: async () => memory } as never, governance);
    const result = await transfer.import('user','space','json','[{"content":"demo"}]');
    expect(result).toMatchObject({ completed: 1, failed: 0, status: 'completed' });
    expect(result.warnings[0].status).toBe('deferred');
  });
});
