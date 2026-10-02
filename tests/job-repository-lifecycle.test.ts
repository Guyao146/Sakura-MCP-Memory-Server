import { describe, expect, it, vi } from 'vitest';
import { JobRepository, type BackgroundJob } from '../src/jobs/repository.js';
import type { Database } from '../src/database.js';

describe('job ownership and recovery queries', () => {
  it('fences every mutation by processing status and the current owner', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const jobs = new JobRepository({ query } as unknown as Database);
    const job = { id: 'job', attempts: 1, max_attempts: 3, progress: {} } as BackgroundJob;
    await expect(jobs.heartbeat('job', 'owner')).resolves.toBe('lost');
    await expect(jobs.progress('job', {}, 'owner')).resolves.toBe(true);
    await jobs.complete('job', {}, 'owner');
    await jobs.fail(job, 'error', {}, 'owner');
    await jobs.release(job, 'owner');
    for (const [sql, values] of query.mock.calls) {
      expect(sql).toMatch(/WHERE id=\$1 AND locked_by=\$\d+ AND status='processing'/);
      expect(values).toContain('owner');
    }
    expect(query.mock.calls[3][0]).toContain("WHEN cancel_requested THEN 'cancelled'");
    expect(query.mock.calls[4][0]).toContain('attempts=GREATEST(0,attempts-1)');
  });

  it('recovers stale cancellation and exhausted attempts and releases its client', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const jobs = new JobRepository({ pool: { connect: async () => ({ query, release }) } } as unknown as Database);
    await expect(jobs.claim('owner', 30)).resolves.toBeUndefined();
    const recovery = query.mock.calls[1][0];
    expect(recovery).toContain("WHEN cancel_requested THEN 'cancelled'");
    expect(recovery).toContain("WHEN attempts>=max_attempts THEN 'failed'");
    expect(recovery).toContain("job_type='rebuild_embeddings'");
    expect(query.mock.calls[2][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
