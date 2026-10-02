import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundWorker } from '../src/jobs/worker.js';
import { JobRepository, type BackgroundJob } from '../src/jobs/repository.js';
import type { Database } from '../src/database.js';
import type { SemanticMemoryService } from '../src/semantic/service.js';

const workers: BackgroundWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.stop()));
  vi.restoreAllMocks(); vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const job: BackgroundJob = { id: 'job', space_id: 'space', requested_by: 'user', job_type: 'rebuild_embeddings',
    payload: {}, status: 'processing', progress: {}, attempts: 1, max_attempts: 3, cancel_requested: false };
  const claim = vi.spyOn(JobRepository.prototype, 'claim').mockResolvedValue(job);
  const heartbeat = vi.spyOn(JobRepository.prototype, 'heartbeat').mockResolvedValue('active');
  const progress = vi.spyOn(JobRepository.prototype, 'progress').mockResolvedValue(false);
  const complete = vi.spyOn(JobRepository.prototype, 'complete').mockResolvedValue();
  const release = vi.spyOn(JobRepository.prototype, 'release').mockResolvedValue();
  const fail = vi.spyOn(JobRepository.prototype, 'fail').mockResolvedValue();
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ total: '2' }] })
    .mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] }).mockResolvedValue({ rows: [] });
  const rebuild = vi.fn().mockResolvedValue([{ memoryId: 'a', status: 'ready' }]);
  const log = { info: vi.fn(), error: vi.fn() };
  const worker = new BackgroundWorker({ query } as unknown as Database,
    { rebuildEmbeddings: rebuild } as unknown as SemanticMemoryService, 1000, 30, log);
  workers.push(worker);
  return { worker, job, claim, heartbeat, progress, complete, release, fail, query, rebuild, log };
}
function stall(rebuild: ReturnType<typeof vi.fn>) {
  const started = deferred<AbortSignal>();
  rebuild.mockImplementationOnce((_user, _space, _ids, signal: AbortSignal) => new Promise((_resolve, reject) => {
    started.resolve(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  return started.promise;
}

describe('background worker lifecycle', () => {
  it('shares one flight for 100 triggers and stop aborts, releases and drains it', async () => {
    vi.useFakeTimers();
    const f = fixture(); const started = stall(f.rebuild);
    const run = f.worker.runOnce(); const signal = await started;
    for (let i = 0; i < 100; i++) expect(f.worker.runOnce()).toBe(run);
    f.worker.start(); f.worker.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.claim).toHaveBeenCalledTimes(1);
    await Promise.all([f.worker.stop(), f.worker.stop(), run]);
    expect(signal.aborted).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    expect(f.rebuild).toHaveBeenCalledTimes(1);
    expect(f.log.error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    f.worker.start();
    await expect(f.worker.runOnce()).resolves.toBe(false);
  });

  it('releases a job claimed after stop without starting Provider work', async () => {
    const f = fixture(); const pending = deferred<BackgroundJob>();
    f.claim.mockReturnValueOnce(pending.promise);
    const run = f.worker.runOnce(); const stopping = f.worker.stop();
    pending.resolve(f.job);
    await Promise.all([run, stopping]);
    expect(f.rebuild).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('never overlaps heartbeat queries and waits for one already in flight', async () => {
    vi.useFakeTimers();
    const f = fixture(); const started = stall(f.rebuild);
    const run = f.worker.runOnce(); await started;
    const beat = deferred<'active'>(); f.heartbeat.mockReturnValueOnce(beat.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stopping = f.worker.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(false);
    beat.resolve('active'); await Promise.all([run, stopping]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not charge failure when cancellation is observed during progress', async () => {
    const f = fixture(); f.progress.mockResolvedValueOnce(true);
    await f.worker.runOnce();
    expect(f.rebuild).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.fail).not.toHaveBeenCalled();
  });

  it('pages IDs and caps retained errors while counting every failure', async () => {
    const f = fixture();
    f.query.mockReset().mockResolvedValueOnce({ rows: [{ total: '205' }] });
    for (const size of [100, 100, 5]) f.query.mockResolvedValueOnce({ rows: Array.from({ length: size }, (_, i) => ({ id: String(i) })) });
    f.query.mockResolvedValue({ rows: [] });
    f.rebuild.mockImplementation(async (_user: string, _space: string, ids: string[]) =>
      ids.map(id => ({ memoryId: id, status: 'failed', error: 'boom' })));
    await f.worker.runOnce();
    // One batched Provider round trip per page of 100 instead of one per memory.
    expect(f.rebuild.mock.calls.map(([, , ids]) => (ids as string[]).length)).toEqual([100, 100, 5]);
    expect(f.job.progress).toMatchObject({ completed: 0, failed: 205 });
    expect(f.job.progress.errors).toHaveLength(100);
    expect(f.query.mock.calls.slice(1).every(([sql]) => sql.includes('LIMIT 100'))).toBe(true);
    expect(f.complete).toHaveBeenCalledWith('job', f.job.progress, expect.stringContaining('worker-'));
  });

  it.each(['cancelled', 'lost'] as const)('aborts stalled I/O when heartbeat reports %s', async state => {
    vi.useFakeTimers();
    const f = fixture(); const started = stall(f.rebuild);
    const run = f.worker.runOnce(); const signal = await started;
    f.heartbeat.mockResolvedValue(state);
    await vi.advanceTimersByTimeAsync(5000); await run;
    expect(signal.aborted).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
