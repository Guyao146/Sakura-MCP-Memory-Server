import type { Database } from '../database.js';
import { requireAgentSpaceScope, requireSpaceRole } from '../memory/permissions.js';

export interface BackgroundJob {
  id: string; space_id: string; requested_by: string; job_type: string; payload: Record<string, unknown>;
  status: 'pending'|'processing'|'completed'|'failed'|'cancelled'; progress: Record<string, unknown>;
  attempts: number; max_attempts: number; cancel_requested: boolean;
}

export class JobRepository {
  constructor(private readonly database: Database) {}

  async enqueue(userId: string, spaceId: string, jobType: 'rebuild_embeddings', payload: Record<string, unknown> = {}) {
    await requireSpaceRole(this.database, userId, spaceId, 'admin');
    const result = await this.database.query(
      `INSERT INTO ingestion_jobs(space_id,requested_by,source_type,job_type,payload,status,progress)
       VALUES($1,$2,'background_worker',$3,$4,'pending',$5) RETURNING *`,
      [spaceId, userId, jobType, payload, { total: 0, completed: 0, failed: 0, errors: [] }]);
    return result.rows[0];
  }

  async list(userId: string, spaceId: string, limit = 50) {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const result = await this.database.query(
      `SELECT id,space_id,job_type,status,progress,error,attempts,max_attempts,available_at,locked_at,locked_by,
       cancel_requested,created_at,updated_at FROM ingestion_jobs WHERE space_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [spaceId, limit]);
    return result.rows;
  }

  async get(userId: string, jobId: string, agentId?: string, scope: 'memory:read'|'space:manage' = 'memory:read') {
    const result = await this.database.query<{ space_id: string } & Record<string, unknown>>(
      `SELECT ij.* FROM ingestion_jobs ij JOIN space_members sm ON sm.space_id=ij.space_id
       WHERE ij.id=$1 AND sm.user_id=$2`, [jobId, userId]);
    if (!result.rows[0]) throw new Error('Background job not found or access denied.');
    await requireAgentSpaceScope(this.database, agentId, result.rows[0].space_id, scope);
    return result.rows[0];
  }

  async cancel(userId: string, jobId: string, agentId?: string) {
    const job = await this.get(userId, jobId, agentId, 'space:manage');
    await requireSpaceRole(this.database, userId, job.space_id, 'admin');
    const result = await this.database.query(
      `UPDATE ingestion_jobs SET cancel_requested=true,
       status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,updated_at=now()
       WHERE id=$1 AND status IN ('pending','processing') RETURNING id,status,cancel_requested`, [jobId]);
    if (!result.rows[0]) throw new Error('Only pending or processing jobs can be cancelled.');
    return result.rows[0];
  }

  async retry(userId: string, jobId: string, agentId?: string) {
    const job = await this.get(userId, jobId, agentId, 'space:manage');
    await requireSpaceRole(this.database, userId, job.space_id, 'admin');
    const result = await this.database.query(
      `UPDATE ingestion_jobs SET status='pending',attempts=0,available_at=now(),locked_at=NULL,locked_by=NULL,
       cancel_requested=false,error=NULL,progress=jsonb_set(progress,'{errors}','[]'::jsonb),updated_at=now()
       WHERE id=$1 AND status IN ('failed','cancelled') RETURNING *`, [jobId]);
    if (!result.rows[0]) throw new Error('Only failed or cancelled jobs can be retried.');
    return result.rows[0];
  }

  async claim(workerId: string, staleAfterSeconds: number): Promise<BackgroundJob | undefined> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE ingestion_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled'
           WHEN attempts>=max_attempts THEN 'failed' ELSE 'pending' END,
         locked_at=NULL,locked_by=NULL,available_at=now(),updated_at=now()
         WHERE status='processing' AND job_type='rebuild_embeddings'
           AND locked_at < now()-($1||' seconds')::interval`, [staleAfterSeconds]);
      const result = await client.query<BackgroundJob>(
        `SELECT * FROM ingestion_jobs WHERE status='pending' AND available_at<=now() AND cancel_requested=false
         AND attempts<max_attempts AND job_type IN ('rebuild_embeddings') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const job = result.rows[0];
      if (!job) { await client.query('COMMIT'); return undefined; }
      const claimed = await client.query<BackgroundJob>(
        `UPDATE ingestion_jobs SET status='processing',attempts=attempts+1,locked_at=now(),locked_by=$2,updated_at=now()
         WHERE id=$1 RETURNING *`, [job.id, workerId]);
      await client.query('COMMIT');
      return claimed.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async heartbeat(jobId: string, workerId: string): Promise<'active'|'cancelled'|'lost'> {
    const result = await this.database.query<{ cancel_requested: boolean }>(
      `UPDATE ingestion_jobs SET locked_at=now(),updated_at=now()
       WHERE id=$1 AND locked_by=$2 AND status='processing' RETURNING cancel_requested`, [jobId, workerId]);
    return !result.rows[0] ? 'lost' : result.rows[0].cancel_requested ? 'cancelled' : 'active';
  }

  async progress(jobId: string, progress: Record<string, unknown>, workerId: string): Promise<boolean> {
    const result = await this.database.query<{ cancel_requested: boolean }>(
      `UPDATE ingestion_jobs SET progress=$2,locked_at=now(),updated_at=now()
       WHERE id=$1 AND locked_by=$3 AND status='processing' RETURNING cancel_requested`, [jobId, progress, workerId]);
    return result.rows[0]?.cancel_requested ?? true;
  }

  /** Release on shutdown without charging a retry; a concurrent cancel always wins. */
  async release(job: BackgroundJob, workerId: string): Promise<void> {
    await this.database.query(
      `UPDATE ingestion_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'pending' END,
       progress=$3,attempts=GREATEST(0,attempts-1),available_at=now(),locked_at=NULL,locked_by=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$2 AND status='processing'`, [job.id, workerId, job.progress]);
  }

  async complete(jobId: string, progress: Record<string, unknown>, workerId: string): Promise<void> {
    await this.database.query(
      `UPDATE ingestion_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
       progress=$2,locked_at=NULL,locked_by=NULL,updated_at=now()
       WHERE id=$1 AND locked_by=$3 AND status='processing'`, [jobId, progress, workerId]);
  }

  async fail(job: BackgroundJob, error: string, progress: Record<string, unknown>, workerId: string): Promise<void> {
    await this.database.query(
      `UPDATE ingestion_jobs SET status=CASE WHEN cancel_requested THEN 'cancelled'
         WHEN attempts<max_attempts THEN 'pending' ELSE 'failed' END,
       error=$2,progress=$3,available_at=now()+($4||' seconds')::interval,
       locked_at=NULL,locked_by=NULL,updated_at=now() WHERE id=$1 AND locked_by=$5 AND status='processing'`,
      [job.id, error, progress, Math.min(300, 2 ** job.attempts * 5), workerId]);
  }
}