import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticMemoryService } from '../src/semantic/service.js';
import { MemoryTransferService } from '../src/transfer/service.js';
import { MemoryRepository } from '../src/memory/repository.js';
import type { MemoryGovernanceService } from '../src/governance/service.js';
import type { MemoryRecord } from '../src/memory/types.js';
import type { Database } from '../src/database.js';
import { loadConfig } from '../src/config.js';
import { operationContext } from '../src/operations.js';

// Exercise cancellation independently of the quota database transaction.
vi.mock('../src/providers/metrics.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/providers/metrics.js')>();
  return {...actual,reserveProviderCall:vi.fn().mockResolvedValue(undefined),recordProviderCall:vi.fn().mockResolvedValue(undefined)};
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('semantic cancellation', () => {
  it('does not swallow worker cancellation or store a failed embedding', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT sm.role')) return { rows: [{ role: 'admin' }] };
      return { rows: [{ memory_id: 'memory' }] };
    });
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url'), OLLAMA_BASE_URL: 'http://unused', OLLAMA_EMBEDDING_MODEL: 'embed' });
    const semantic = new SemanticMemoryService({ query } as unknown as Database, () => config);
    vi.spyOn(MemoryRepository.prototype, 'get').mockResolvedValue({ id: 'memory', space_id: 'space', content: 'text', summary: '', tags: [] } as unknown as MemoryRecord);
    vi.spyOn(semantic, 'strategy').mockResolvedValue({ provider_type: 'ollama', embedding_model: 'embed', privacy_mode: true } as never);
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(new Error('cancelled')); throw controller.signal.reason; }));
    await expect(semantic.rebuildEmbedding('user', 'memory', controller.signal)).rejects.toThrow('cancelled');
    const writes = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO memory_embeddings'));
    expect(writes).toHaveLength(1); // pending only, never failed
  });

  it('stops import iteration and keeps already-stored progress without charging a failure', async () => {
    const controller = new AbortController();
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT sm.role') ? [{ role: 'admin' }] : [{ id: 'job' }] }));
    const remember = vi.fn(async () => { controller.abort(); return { id: 'memory' }; });
    const detect = vi.fn();
    const transfer = new MemoryTransferService({ query } as unknown as Database,
      { remember } as unknown as SemanticMemoryService, { detect } as unknown as MemoryGovernanceService);
    const result = await operationContext.run({ signal: controller.signal, pending: new Set() }, () =>
      transfer.import('user', 'space', 'json', JSON.stringify([{ content: 'first' }, { content: 'second' }])));
    expect(result).toMatchObject({ status: 'cancelled', completed: 1, failed: 0 });
    expect(remember).toHaveBeenCalledTimes(1);
    expect(detect).not.toHaveBeenCalled();
  });
});
