import { describe, expect, it, vi } from 'vitest';
import { JobRepository } from '../src/jobs/repository.js';
import { OperationsService } from '../src/maintenance/service.js';
import { providerScope, reserveProviderCall, recordProviderCall } from '../src/providers/metrics.js';

describe('retention, retry and Provider accounting boundaries', () => {
  it('locks the job before checking the replay payload and rejects an expired payload', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT job_type') ? [{ job_type: 'import_v2' }] : [] }));
    const release = vi.fn();
    const database = {
      query: vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT sm.role') ? [{ role: 'contributor' }] : [{ id: 'job', space_id: 'space', requested_by: 'user', job_type: 'import_v2' }] })),
      pool: { connect: async () => ({ query, release }) }
    };
    await expect(new JobRepository(database as never).retry('user', 'job')).rejects.toThrow('payload expired');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN', 'SELECT job_type FROM ingestion_jobs WHERE id=$1 FOR UPDATE',
      'SELECT 1 FROM import_items WHERE job_id=$1 LIMIT 1', 'ROLLBACK'
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('only cleans bounded terminal jobs that still have payloads under a lock', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT id') ? [{ id: 'expired-job' }] : [] }));
    const release = vi.fn(), plain = vi.fn().mockResolvedValue({ rows: [], rowCount: 4 });
    const service = new OperationsService({ query: plain, pool: { connect: async () => ({ query, release }) } } as never);
    await expect(service.cleanup(180)).resolves.toMatchObject({ auditDeleted: 4 });
    const selection = query.mock.calls[1][0];
    expect(selection).toContain("status IN ('completed','cancelled','failed')");
    expect(selection).toContain('EXISTS(SELECT 1 FROM import_items');
    expect(selection).toContain('LIMIT 100 FOR UPDATE SKIP LOCKED');
    expect(query).toHaveBeenCalledWith('DELETE FROM import_items WHERE job_id=ANY($1::uuid[])', [['expired-job']]);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a call on its reserved date even if completion happens on a later day', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ max_provider_calls_daily: 10 }] : sql.includes('INSERT INTO provider_usage') ? [{ calls: 1, day: '2026-01-01' }] : [] }));
    const plain = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query: plain, pool: { connect: async () => ({ query, release() {} }) } };
    await providerScope.run({ database: database as never, spaceId: 'space' }, async () => {
      const day = await reserveProviderCall();
      expect(day).toBe('2026-01-01');
      await recordProviderCall(true, 1200, day);
    });
    expect(plain).toHaveBeenCalledWith(expect.stringContaining('day=$4::date'), ['space', 1, 1200, '2026-01-01']);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
