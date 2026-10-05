import { z } from 'zod/v4';
import type { Database } from '../database.js';
import { requireAgentSpaceScope, requireSpaceRole } from '../memory/permissions.js';
import type { MemoryType } from '../memory/types.js';
import type { SemanticMemoryService } from '../semantic/service.js';
import type { MemoryGovernanceService } from '../governance/service.js';
import { operationSignal } from '../operations.js';

export const importMemorySchema = z.object({
  status: z.enum(['active','pending_confirmation','archived','superseded']).default('active'),
  sources: z.array(z.object({type:z.string().min(1).max(120),uri:z.string().max(2000).nullish().transform(x=>x??undefined),
    agent:z.string().max(500).nullish().transform(x=>x??undefined),excerpt:z.string().max(10000).nullish().transform(x=>x??undefined),
    metadata:z.record(z.string(),z.unknown()).optional()})).max(100).optional(),
  type: z.enum(['fact','preference','event','task','person','project','summary','document','idea','other']).default('other'),
  content: z.string().min(1).max(1_000_000), summary: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(80)).max(50).optional(), importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(), sensitivity: z.number().int().min(0).max(3).optional(),
  validFrom: z.iso.datetime().optional(), validUntil: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional()
});

export class MemoryTransferService {
  constructor(private readonly database: Database, private readonly semantic: SemanticMemoryService,
    private readonly governance: MemoryGovernanceService) {}

  /**
   * Exports a space as portable JSON or Markdown. Rows are read in bounded,
   * keyset-paginated batches. The compatibility API returns one string, bounded
   * by both row count and bytes; large HTTP downloads should use exportStream.
   */
  async export(userId: string, spaceId: string, format: 'json'|'markdown', options?: { maxRows?: number; batchSize?: number }): Promise<{ filename: string; mimeType: string; content: string; rowCount: number; truncated: boolean }> {
    const signal = operationSignal();
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const space = await this.database.query<{ name: string; description: string }>('SELECT name,description FROM spaces WHERE id=$1 AND deleted_at IS NULL', [spaceId]);
    if (!space.rows[0]) throw new Error('Memory space not found.');
    const safeName = space.rows[0].name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '') || 'memory-space';
    const maxRows = options?.maxRows ?? 50_000;
    const maxBytes = 16 * 1024 * 1024;
    let bytes = 0;
    const account = (text: string) => {
      bytes += Buffer.byteLength(text, 'utf8');
      if (bytes > maxBytes) throw new Error('Export exceeds 16 MiB; use a filtered or streaming export.');
      return text;
    };
    const batchSize = options?.batchSize ?? 16;
    if(!Number.isInteger(maxRows)||maxRows<1||maxRows>50000||!Number.isInteger(batchSize)||batchSize<1||batchSize>500)throw new Error('Invalid export limits.');
    const batches = exportBatches(this.database, spaceId, batchSize);
    if (format === 'json') {
      // Compact, streaming-friendly JSON built one row at a time.
      const parts = [account(`{"schema":"sakura-memory-export/v1","exportedAt":${JSON.stringify(new Date().toISOString())},"space":${JSON.stringify(space.rows[0])},"memories":[`)];
      let first = true; let rowCount = 0; let truncated = false;
      for await (const rows of batches) {
        signal?.throwIfAborted();
        for (const row of rows) {
          if (rowCount >= maxRows) { truncated = true; break; }
          parts.push(account((first ? '' : ',') + JSON.stringify(row)));
          first = false;
          rowCount += 1;
        }
        if (truncated) break;
      }
      const suffix=']'+(truncated?`,"truncated":true,"maxRows":${maxRows}`:'')+'}';
      parts.push(account(suffix));
      return { filename: `${safeName}.json`, mimeType: 'application/json', content: parts.join(''), rowCount, truncated };
    }
    const sections: string[] = [];
    account(`# ${space.rows[0].name}\n\n${space.rows[0].description}\n\n`);
    let rowCount = 0; let truncated = false;
    for await (const rows of batches) {
      signal?.throwIfAborted();
      for (const memory of rows as Array<Record<string, unknown>>) {
        if (rowCount >= maxRows) { truncated = true; break; }
        const tags = (memory.tags as string[]).join(', ');
        const section=`## ${memory.summary || memory.type}\n\n- ID: ${memory.id}\n- Type: ${memory.type}\n- Tags: ${tags}\n- Importance: ${memory.importance}\n- Confidence: ${memory.confidence}\n\n${memory.content}`;
        account(section+'\n\n---\n\n'); sections.push(section);
        rowCount += 1;
      }
      if (truncated) break;
    }
    return { filename: `${safeName}.md`, mimeType: 'text/markdown',
      content: `# ${space.rows[0].name}\n\n${space.rows[0].description}\n\n${sections.join('\n\n---\n\n')}\n`, rowCount, truncated };
  }

  async import(userId: string, spaceId: string, format: 'json'|'markdown', content: string, sourceAgent?: string) {
    const signal = operationSignal();
    signal?.throwIfAborted();
    await requireSpaceRole(this.database, userId, spaceId, 'contributor');
    const records = format === 'json' ? parseJson(content) : parseMarkdown(content);
    if (records.length > 500) throw new Error('A single import is limited to 500 memories.');
    const job = await this.database.query<{ id: string }>(
      `INSERT INTO ingestion_jobs(space_id,requested_by,source_type,status,progress) VALUES($1,$2,$3,'processing',$4) RETURNING id`,
      [spaceId, userId, `import_${format}`, { total: records.length, completed: 0, failed: 0, errors: [] }]);
    const errors: Array<{ index: number; message: string }> = [];
    const warnings: Array<{ index: number; status: string; reason?: string }> = [];
    let completed = 0;
    for (let index = 0; index < records.length; index += 1) {
      if (signal?.aborted) break;
      const cancellation=await this.database.query<{cancel_requested:boolean}>('SELECT cancel_requested FROM ingestion_jobs WHERE id=$1',[job.rows[0].id]);
      if(cancellation.rows[0]?.cancel_requested) {
        await this.database.query("UPDATE ingestion_jobs SET status='cancelled',updated_at=now() WHERE id=$1",[job.rows[0].id]);
        return {jobId:job.rows[0].id,status:'cancelled',total:records.length,completed,failed:errors.length,errors,warnings};
      }
      try {
        const recordSize=Buffer.byteLength(JSON.stringify(records[index]));
        if(recordSize>2_000_000) throw new Error('Import record exceeds 2 MB.');
        const record = importMemorySchema.parse(records[index]);
        const memory = await this.semantic.remember(userId, { spaceId, type: record.type as MemoryType, content: record.content,
          summary: record.summary, tags: record.tags, status:record.status,sources:record.sources, importance: record.importance, confidence: record.confidence,
          sensitivity: record.sensitivity, validFrom: record.validFrom, validUntil: record.validUntil, expiresAt: record.expiresAt,
          source: { type: `import_${format}`, agent: sourceAgent } });
        completed += 1;
        signal?.throwIfAborted();
        const governance = await this.governance.detectAfterWrite(userId, memory.id);
        if (governance.status !== 'completed') warnings.push({ index, ...governance });
      } catch (error) {
        if (signal?.aborted) break;
        errors.push({ index, message: error instanceof Error ? error.message : 'Import failed.' });
      }
    }
    const status = signal?.aborted ? 'cancelled' : errors.length === records.length && records.length > 0 ? 'failed' : 'completed';
    const cancellation=await this.database.query<{cancel_requested:boolean}>('SELECT cancel_requested FROM ingestion_jobs WHERE id=$1',[job.rows[0].id]);
    const finalStatus=cancellation.rows[0]?.cancel_requested?'cancelled':status;
    const progress = { total: records.length, completed, failed: errors.length, errors: errors.slice(0, 100), warnings: warnings.slice(0, 100) };
    await this.database.query('UPDATE ingestion_jobs SET status=$2,progress=$3,error=$4,updated_at=now() WHERE id=$1',
      [job.rows[0].id, finalStatus, progress, errors.length ? `${errors.length} record(s) failed.` : null]);
    return { jobId: job.rows[0].id, status:finalStatus, ...progress };
  }

  async status(userId: string, jobId: string, agentId?: string) {
    const result = await this.database.query(
      `SELECT ij.id,ij.space_id,ij.source_type,ij.status,ij.progress,ij.error,ij.created_at,ij.updated_at
       FROM ingestion_jobs ij JOIN space_members sm ON sm.space_id=ij.space_id
       WHERE ij.id=$1 AND sm.user_id=$2`, [jobId, userId]);
    if (!result.rows[0]) throw new Error('Import job not found or access denied.');
    await requireAgentSpaceScope(this.database, agentId, result.rows[0].space_id, 'memory:read');
    return result.rows[0];
  }
}

/**
 * Keyset-paginates the memories of a space so the export never materializes
 * the whole space in one query. Ordering by (created_at, id) is stable because
 * memory ids are unique.
 */
export async function* exportBatches(database: Database, spaceId: string, batchSize: number): AsyncGenerator<Record<string, unknown>[]> {
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;
  for (;;) {
    const result = await database.query(
      `SELECT m.id,m.type,m.content,m.summary,m.tags,m.importance,m.confidence,m.sensitivity,m.status,
       m.valid_from,m.valid_until,m.expires_at,m.created_at::text AS created_at,m.updated_at,
       coalesce(json_agg(json_build_object('type',ms.source_type,'uri',ms.source_uri,'agent',ms.source_agent,'excerpt',ms.excerpt,'metadata',ms.metadata))
         FILTER(WHERE ms.id IS NOT NULL),'[]') AS sources
       FROM memories m LEFT JOIN memory_sources ms ON ms.memory_id=m.id
       WHERE m.space_id=$1 AND m.deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR (m.created_at,m.id)>($2,$3::uuid))
       GROUP BY m.id ORDER BY m.created_at,m.id LIMIT $4`,
      [spaceId, cursorCreatedAt, cursorId, batchSize]);
    if (!result.rows.length) return;
    yield result.rows;
    const last = result.rows[result.rows.length - 1] as { created_at: string; id: string };
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
    if (result.rows.length < batchSize) return;
  }
}

export function parseJson(content: string): unknown[] {
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { memories?: unknown[] }).memories)) {
    const truncated=(parsed as {truncated?:boolean}).truncated===true;
    if(truncated)throw new Error('Truncated JSON export cannot be imported as a complete data set.');
    return (parsed as { memories: unknown[] }).memories.map(item => normalizeExportRecord(item));
  }
  throw new Error('JSON import must be an array or a Sakura export object with memories.');
}

function normalizeExportRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  return { ...item,
    validFrom: typeof item.valid_from === 'string' ? item.valid_from : undefined,
    validUntil: typeof item.valid_until === 'string' ? item.valid_until : undefined,
    expiresAt: typeof item.expires_at === 'string' ? item.expires_at : undefined
  };
}

export function parseMarkdown(content: string): unknown[] {
  const parts = content.split(/^##\s+/m).slice(1);
  if (!parts.length && content.trim()) return [{ type: 'document', content: content.trim(), summary: 'Imported Markdown' }];
  return parts.map(part => {
    const [title, ...lines] = part.split('\n');
    const body = lines.join('\n').replace(/^\s*-\s+(ID|Type|Tags|Importance|Confidence):.*$/gm, '').replace(/^\s*---\s*$/gm, '').trim();
    const type = part.match(/^\s*-\s+Type:\s*(\w+)/m)?.[1] ?? 'document';
    const tags = part.match(/^\s*-\s+Tags:\s*(.*)$/m)?.[1].split(',').map(tag => tag.trim()).filter(Boolean);
    return { type, summary: title.trim(), content: body, tags };
  });
}