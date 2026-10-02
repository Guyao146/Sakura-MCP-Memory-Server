import { createHash, randomUUID } from 'node:crypto';
import { operationSignal } from '../operations.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import { MemoryRepository } from '../memory/repository.js';
import type { MemoryRecord, RememberInput } from '../memory/types.js';
import { createProvider, createEmbeddingProvider, type ProviderKind, type ResolvedProvider } from '../providers/factory.js';
import type { ExtractedMemory } from '../providers/types.js';
import { MemoryGovernanceService } from '../governance/service.js';

interface SpaceStrategy {
  provider_type: ProviderKind | null;
  chat_model: string | null;
  embedding_model: string | null;
  auto_extract_enabled: boolean;
  auto_merge_enabled: boolean;
  conflict_detection_enabled: boolean;
  privacy_mode: boolean;
}

export class SemanticMemoryService {
  readonly repository: MemoryRepository;
  constructor(private readonly database: Database, private readonly getConfig: () => AppConfig) {
    this.repository = new MemoryRepository(database);
  }

  async strategy(userId: string, spaceId: string): Promise<SpaceStrategy> {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const result = await this.database.query<SpaceStrategy>(
      `SELECT sps.provider_type,sps.chat_model,sps.embedding_model,s.auto_extract_enabled,s.auto_merge_enabled,
       s.conflict_detection_enabled,s.privacy_mode FROM spaces s
       LEFT JOIN space_provider_settings sps ON sps.space_id=s.id WHERE s.id=$1 AND s.deleted_at IS NULL`, [spaceId]);
    if (!result.rows[0]) throw new Error('Memory space not found.');
    return result.rows[0];
  }

  async configureStrategy(userId: string, spaceId: string, input: {
    providerType?: ProviderKind; chatModel?: string; embeddingModel?: string;
    autoExtractEnabled: boolean; autoMergeEnabled: boolean; conflictDetectionEnabled: boolean; privacyMode: boolean;
  }) {
    await requireSpaceRole(this.database, userId, spaceId, 'admin');
    if (input.privacyMode && input.providerType === 'openai_compatible') {
      throw new Error('Privacy mode only permits the local Ollama Provider.');
    }
    if (input.providerType) createProvider(this.getConfig(), input.providerType, { chatModel: input.chatModel, embeddingModel: input.embeddingModel });
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE spaces SET auto_extract_enabled=$2,auto_merge_enabled=$3,conflict_detection_enabled=$4,privacy_mode=$5,updated_at=now()
         WHERE id=$1`, [spaceId, input.autoExtractEnabled, input.autoMergeEnabled, input.conflictDetectionEnabled, input.privacyMode]);
      await client.query(
        `INSERT INTO space_provider_settings(space_id,provider_type,chat_model,embedding_model)
         VALUES($1,$2,$3,$4) ON CONFLICT(space_id) DO UPDATE SET provider_type=EXCLUDED.provider_type,
         chat_model=EXCLUDED.chat_model,embedding_model=EXCLUDED.embedding_model,updated_at=now()`,
        [spaceId, input.providerType ?? null, input.chatModel ?? null, input.embeddingModel ?? null]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return this.strategy(userId, spaceId);
  }

  async remember(userId: string, input: RememberInput): Promise<MemoryRecord & { embeddingStatus: string }> {
    operationSignal()?.throwIfAborted();
    const memory = await this.repository.remember(userId, input);
    const embeddingStatus = await this.embedMemory(userId, memory).catch(() => operationSignal()?.aborted ? 'pending' : 'failed');
    return { ...memory, embeddingStatus };
  }

  async update(userId: string, memoryId: string, patch: Parameters<MemoryRepository['update']>[2], reason: string) {
    operationSignal()?.throwIfAborted();
    const memory = await this.repository.update(userId, memoryId, patch, reason);
    const contentChanged = patch.content !== undefined || patch.summary !== undefined || patch.tags !== undefined;
    const embeddingStatus = contentChanged ? await this.embedMemory(userId, memory).catch(() => operationSignal()?.aborted ? 'pending' : 'failed') : await this.embeddingStatus(memory.id);
    return { ...memory, embeddingStatus };
  }

  async hybridSearch(userId: string, spaceId: string, query: string, limit: number, types?: string[], tags?: string[]) {
    await requireSpaceRole(this.database, userId, spaceId, 'viewer');
    const resolved = await this.resolve(userId, spaceId, 'embedding');
    if (!resolved || !query.trim()) return this.repository.search(userId, spaceId, query, limit, types, tags);
    let queryEmbedding: number[];
    try { queryEmbedding = (await resolved.provider.embed([query], resolved.embeddingModel))[0]; }
    catch { operationSignal()?.throwIfAborted(); return this.repository.search(userId, spaceId, query, limit, types, tags); }
    if (!queryEmbedding?.length || queryEmbedding.some(value => !Number.isFinite(value))) return this.repository.search(userId, spaceId, query, limit, types, tags);
    // Rank in PostgreSQL across the entire space, not only the most recent 1000 rows.
    const result = await this.database.query<MemoryRecord & { score: number }>(
      `SELECT m.*,
       (0.60 * CASE WHEN me.status='ready' AND me.dimensions=$6 AND me.model=$7
         THEN coalesce(1 - (me.embedding <=> $5::vector),0) ELSE 0 END
        + 0.25 * greatest(least(ts_rank_cd(m.search_vector,websearch_to_tsquery('simple',$2))*4,1),
          CASE WHEN strpos(lower(m.content),lower($2))>0 THEN 1 ELSE 0 END)
        + 0.10 * m.importance + 0.05 * m.confidence) AS score
       FROM memories m LEFT JOIN memory_embeddings me ON me.memory_id=m.id
       WHERE m.space_id=$1 AND m.status IN ('active','pending_confirmation') AND m.deleted_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at>now())
       AND ($3::text[] IS NULL OR m.type::text=ANY($3)) AND ($4::text[] IS NULL OR m.tags&&$4)
       ORDER BY score DESC,m.updated_at DESC,m.id LIMIT $8`,
      [spaceId, query, types?.length ? types : null, tags?.length ? tags : null,
        `[${queryEmbedding.join(',')}]`, queryEmbedding.length, resolved.embeddingModel, limit]);
    return result.rows;
  }

  async extract(userId: string, spaceId: string, text: string): Promise<ExtractedMemory[]> {
    await requireSpaceRole(this.database, userId, spaceId, 'contributor');
    const resolved = await this.resolve(userId, spaceId, 'chat');
    if (!resolved) throw new Error('This space has no Chat Provider configured.');
    return resolved.provider.extractMemories(text, resolved.chatModel);
  }

  async rebuildEmbedding(userId: string, memoryId: string, signal?: AbortSignal): Promise<{ memoryId: string; status: string }> {
    signal = operationSignal(signal);
    signal?.throwIfAborted();
    const memory = await this.repository.get(userId, memoryId);
    await requireSpaceRole(this.database, userId, memory.space_id, 'editor');
    const status = await this.embedMemory(userId, memory, signal).catch(() => { signal?.throwIfAborted(); return 'failed'; });
    return { memoryId, status };
  }

  async extractAndRemember(userId: string, spaceId: string, text: string, sourceAgent?: string) {
    const candidates = await this.extract(userId, spaceId, text);
    const strategy = await this.strategy(userId, spaceId);
    const governance = new MemoryGovernanceService(this.database);
    const stored = [];
    for (const candidate of candidates.slice(0, 50)) {
      operationSignal()?.throwIfAborted();
      const memory = await this.remember(userId, { spaceId, ...candidate,
        source: { type: 'automatic_extraction', agent: sourceAgent, excerpt: text.slice(0, 10_000) } });
      const governanceResult = !operationSignal()?.aborted && (strategy.auto_merge_enabled || strategy.conflict_detection_enabled)
        ? await governance.detectAfterWrite(userId, memory.id) : undefined;
      stored.push({ ...memory, governance: governanceResult });
    }
    return stored;
  }

  private async embedMemory(userId: string, memory: MemoryRecord, signal?: AbortSignal): Promise<string> {
    signal = operationSignal(signal);
    signal?.throwIfAborted();
    const resolved = await this.resolve(userId, memory.space_id, 'embedding');
    signal?.throwIfAborted();
    const content = `${memory.summary}\n${memory.content}\n${memory.tags.join(' ')}`.trim();
    const contentHash = createHash('sha256').update(content).digest('hex');
    const requestId = randomUUID();
    if (!resolved?.embeddingModel) {
      await this.storeEmbedding(memory, requestId, 'unconfigured', contentHash, 'failed', undefined, 'No Embedding Provider configured.');
      return 'failed';
    }
    if (!await this.storeEmbedding(memory, requestId, resolved.embeddingModel, contentHash, 'pending')) return 'superseded';
    try {
      const embedding = (await resolved.provider.embed([content], resolved.embeddingModel, signal))[0];
      signal?.throwIfAborted();
      if (!embedding?.length || embedding.some(value => !Number.isFinite(value))) throw new Error('Provider returned an invalid embedding.');
      const stored = await this.storeEmbedding(memory, requestId, resolved.embeddingModel, contentHash, 'ready', embedding);
      return stored ? 'ready' : 'superseded';
    } catch (error) {
      signal?.throwIfAborted();
      const stored = await this.storeEmbedding(memory, requestId, resolved.embeddingModel, contentHash, 'failed', undefined, error instanceof Error ? error.message : 'Embedding failed.');
      if (!stored) return 'superseded';
      throw error;
    }
  }

  private async storeEmbedding(memory: MemoryRecord, requestId: string, model: string, contentHash: string, status: 'pending'|'ready'|'failed', embedding?: number[], error?: string): Promise<boolean> {
    const vector = embedding ? `[${embedding.join(',')}]` : null;
    const result = await this.database.query(
      `WITH current_memory AS MATERIALIZED (
         SELECT id FROM memories WHERE id=$1 AND embedding_revision=$8 AND deleted_at IS NULL FOR UPDATE
       )
       INSERT INTO memory_embeddings(memory_id,model,dimensions,embedding,content_hash,status,error,request_id)
       SELECT id,$2,$3,$4::vector,$5,$6,$7,$9::uuid FROM current_memory WHERE true
       ON CONFLICT(memory_id) DO UPDATE SET model=EXCLUDED.model,
       dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding,content_hash=EXCLUDED.content_hash,
       status=EXCLUDED.status,error=EXCLUDED.error,request_id=EXCLUDED.request_id,updated_at=now()
       WHERE $6='pending' OR memory_embeddings.request_id=$9::uuid
       RETURNING memory_id`,
      [memory.id, model, embedding?.length ?? null, vector, contentHash, status, error ?? null, memory.embedding_revision, requestId]);
    return result.rows.length > 0;
  }

  private async embeddingStatus(memoryId: string): Promise<string> {
    const result = await this.database.query<{ status: string }>('SELECT status FROM memory_embeddings WHERE memory_id=$1', [memoryId]);
    return result.rows[0]?.status ?? 'missing';
  }

  private async resolve(userId: string, spaceId: string, capability: 'chat'|'embedding'): Promise<ResolvedProvider | undefined> {
    const strategy = await this.strategy(userId, spaceId);
    if (capability === 'embedding' && !strategy.provider_type && !strategy.privacy_mode) {
      const dedicated = createEmbeddingProvider(this.getConfig(), { embeddingModel: strategy.embedding_model ?? undefined });
      if (dedicated?.embeddingModel) return dedicated;
    }
    let kind = strategy.provider_type;
    if (!kind) {
      if (strategy.privacy_mode) kind = this.getConfig().ollama ? 'ollama' : null;
      else kind = this.getConfig().openaiCompatible ? 'openai_compatible' : this.getConfig().ollama ? 'ollama' : null;
    }
    if (!kind) return undefined;
    const resolved = createProvider(this.getConfig(), kind, { chatModel: strategy.chat_model ?? undefined, embeddingModel: strategy.embedding_model ?? undefined });
    if (capability === 'chat' && !resolved.chatModel) return undefined;
    if (capability === 'embedding' && !resolved.embeddingModel) return undefined;
    return resolved;
  }
}
