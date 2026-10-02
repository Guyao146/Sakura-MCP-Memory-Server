import { randomUUID } from 'node:crypto';
import type { Database } from '../database.js';
import type { SemanticMemoryService } from '../semantic/service.js';
import { JobRepository, type BackgroundJob } from './repository.js';

class JobInterrupted extends Error {}

export class BackgroundWorker {
  private readonly id = `worker-${randomUUID()}`;
  private readonly jobs: JobRepository;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private started = false;
  private inFlight?: Promise<boolean>;
  private controller?: AbortController;

  constructor(private readonly database: Database, private readonly semantic: SemanticMemoryService,
    private readonly pollIntervalMs: number, private readonly staleAfterSeconds: number,
    private readonly log: { info(value: unknown, message: string): void; error(value: unknown, message: string): void }) {
    this.jobs = new JobRepository(database);
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    const poll = async () => {
      this.timer = undefined;
      if (this.stopping) return;
      try { await this.runOnce(); }
      catch (error) { this.log.error({ err: error, workerId: this.id }, 'Background worker poll failed'); }
      if (!this.stopping) this.timer = setTimeout(poll, this.pollIntervalMs);
    };
    this.timer = setTimeout(poll, 50);
    this.log.info({ workerId: this.id }, 'Background worker started');
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort(new Error('Worker shutting down.'));
    await this.inFlight;
  }

  runOnce(): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.controller = controller;
    return this.inFlight = this.execute(controller).finally(() => {
      this.inFlight = undefined;
      this.controller = undefined;
    });
  }

  private async execute(controller: AbortController): Promise<boolean> {
    const job = await this.jobs.claim(this.id, this.staleAfterSeconds);
    if (!job) return false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatPending: Promise<void> | undefined;
    let finished = false;
    const heartbeat = async () => {
      try {
        if (await this.jobs.heartbeat(job.id, this.id) !== 'active') controller.abort(new Error('Job cancelled or lease lost.'));
      } catch (error) { controller.abort(error); }
      if (!finished && !controller.signal.aborted) scheduleHeartbeat();
    };
    const scheduleHeartbeat = () => {
      heartbeatTimer = setTimeout(() => { heartbeatPending = heartbeat(); }, Math.min(5000, this.staleAfterSeconds * 1000 / 3));
      heartbeatTimer.unref();
    };
    try {
      controller.signal.throwIfAborted();
      await heartbeat(); // Check cancellation before making any Provider call.
      controller.signal.throwIfAborted();
      if (job.job_type === 'rebuild_embeddings') await this.rebuild(job, controller.signal);
      else throw new Error(`Unsupported background job type: ${job.job_type}`);
      controller.signal.throwIfAborted();
      await this.jobs.complete(job.id, job.progress, this.id);
    } catch (error) {
      if (controller.signal.aborted || error instanceof JobInterrupted) await this.jobs.release(job, this.id);
      else {
        await this.jobs.fail(job, error instanceof Error ? error.message : 'Background job failed.', job.progress, this.id);
        this.log.error({ err: error, jobId: job.id }, 'Background job failed');
      }
    } finally {
      finished = true;
      clearTimeout(heartbeatTimer);
      await heartbeatPending;
    }
    return true;
  }

  private async rebuild(job: BackgroundJob, signal: AbortSignal): Promise<void> {
    const snapshot = new Date().toISOString();
    const count = await this.database.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM memories WHERE space_id=$1 AND status IN ('active','pending_confirmation')
       AND deleted_at IS NULL AND created_at<=$2`, [job.space_id, snapshot]);
    const errors: Array<{ memoryId: string; message: string }> = [];
    let completed = 0; let failed = 0; let cursor: string | null = null;
    job.progress = { total: Number(count.rows[0].total), completed, failed, errors };
    while (true) {
      signal.throwIfAborted();
      // Keyset pagination bounds retained IDs even for very large spaces.
      const ids: { rows: Array<{ id: string }> } = await this.database.query<{ id: string }>(
        `SELECT id FROM memories WHERE space_id=$1 AND status IN ('active','pending_confirmation')
         AND deleted_at IS NULL AND created_at<=$2 AND ($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT 100`,
        [job.space_id, snapshot, cursor]);
      if (!ids.rows.length) return;
      for (const row of ids.rows) {
        signal.throwIfAborted();
        try {
          const result = await this.semantic.rebuildEmbedding(job.requested_by, row.id, signal);
          signal.throwIfAborted();
          if (result.status === 'failed') throw new Error('Embedding failed; see memory_embeddings.error.');
          completed += 1;
        } catch (error) {
          signal.throwIfAborted();
          failed += 1;
          if (errors.length < 100) errors.push({ memoryId: row.id, message: error instanceof Error ? error.message : 'Embedding failed.' });
        }
        job.progress = { total: Number(count.rows[0].total), completed, failed, errors: [...errors] };
        if (await this.jobs.progress(job.id, job.progress, this.id)) throw new JobInterrupted('Job cancelled or lease lost.');
        cursor = row.id;
      }
    }
  }
}