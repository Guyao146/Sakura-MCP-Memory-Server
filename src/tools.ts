import { ImportQueue } from './transfer/queue.js';
import { MemoryManagement,browseSchema } from './memory/management.js';
import { McpServer, ResourceTemplate, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Principal } from './auth.js';
import { requireScopes } from './auth.js';
import { AgentRepository } from './agents/repository.js';
import type { AuditLogger } from './audit.js';
import type { AppConfig, Scope } from './config.js';
import type { Database } from './database.js';
import { MemoryRepository } from './memory/repository.js';
import { requireAgentSpaceScope } from './memory/permissions.js';
import { SpaceRepository } from './spaces/repository.js';
import { SemanticMemoryService } from './semantic/service.js';
import { MemoryGovernanceService } from './governance/service.js';
import { MemoryTransferService } from './transfer/service.js';
import { JobRepository } from './jobs/repository.js';
import { APP_VERSION } from './version.js';
import { operationSignal, trackOperation } from './operations.js';

const memoryType = z.enum(['fact', 'preference', 'event', 'task', 'person', 'project', 'summary', 'document', 'idea', 'other']);
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});
const failure = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

export function createServer(database: Database, principal: Principal, audit: AuditLogger, getConfig: () => AppConfig,
  requestIdentity?: ReturnType<MemoryRepository['ensureUser']>): McpServer {
  const server = new McpServer({ name: 'Sakura-MCP-Memory-Server', version: APP_VERSION });
  const repository = new MemoryRepository(database);
  const semantic = new SemanticMemoryService(database, getConfig);
  const governance = new MemoryGovernanceService(database);
  const transfer = new MemoryTransferService(database, semantic, governance);
  const jobs = new JobRepository(database);
  const agents = new AgentRepository(database, getConfig().setup.encryptionKey);
  const spaces = new SpaceRepository(database);
  const identity = requestIdentity ?? trackOperation(() => repository.ensureUser(principal.id, {
    email: principal.email, displayName: principal.displayName, allowAdminByEmail: principal.source === 'authentik'
  }));
  const requireHuman = () => {
    if (principal.source === 'api_key') throw new Error('This operation requires an interactive user.');
  };
  const guarded = <T>(name: string, scopes: Scope[], handler: (args: T, userId: string, personalSpaceId: string) => Promise<unknown>) => (args: T, ctx: ServerContext) => trackOperation(async () => {
    let actorUserId: string | undefined;
    try {
      operationSignal()?.throwIfAborted();
      requireScopes(principal, scopes);
      const { userId, personalSpaceId } = await identity;
      actorUserId = userId;
      operationSignal()?.throwIfAborted();
      const result = await handler(args, userId, personalSpaceId);
      await audit.write(principal, `mcp.${name}`, 'success', { arguments: args as unknown }, userId);
      return text(result);
    } catch (error) {
      if (operationSignal()?.aborted) return failure('Request cancelled.');
      const message = error instanceof Error ? error.message : 'Unexpected error.';
      await audit.write(principal, `mcp.${name}`, 'error', { arguments: args as unknown, errorType: error instanceof Error ? error.name : 'Error' }, actorUserId);
      return failure(message);
    }
  }, undefined, ctx.mcpReq.signal);

  server.registerTool('memory_remember', {
    description: 'Store a durable memory in the caller personal space or an authorized shared space.',
    inputSchema: {
      space_id: z.string().uuid().optional(), type: memoryType.default('other'), content: z.string().min(1).max(1_000_000),
      summary: z.string().max(2000).optional(), tags: z.array(z.string().min(1).max(80)).max(50).optional(),
      importance: z.number().min(0).max(1).optional(), confidence: z.number().min(0).max(1).optional(),
      sensitivity: z.number().int().min(0).max(3).optional(), valid_from: z.iso.datetime().optional(),
      valid_until: z.iso.datetime().optional(), expires_at: z.iso.datetime().optional(),
      source_type: z.string().min(1).max(80).optional(), source_uri: z.string().max(2000).optional(),
      source_excerpt: z.string().max(10000).optional()
    }
  }, guarded('memory_remember', ['memory:write'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:write');
    return semantic.remember(userId, {
    spaceId, type: args.type, content: args.content, summary: args.summary, tags: args.tags,
    importance: args.importance, confidence: args.confidence, sensitivity: args.sensitivity, validFrom: args.valid_from,
    validUntil: args.valid_until, expiresAt: args.expires_at,
    source: args.source_type ? { type: args.source_type, uri: args.source_uri, agent: principal.id, excerpt: args.source_excerpt } : undefined
  });
  }));

  server.registerTool('memory_search', {
    description: 'Search memories with full-text search and filters. An omitted space_id searches the personal space.',
    inputSchema: { space_id: z.string().uuid().optional(), query: z.string().max(2000).default(''), limit: z.number().int().min(1).max(100).default(20), types: z.array(memoryType).max(10).optional(), tags: z.array(z.string().max(80)).max(50).optional() }
  }, guarded('memory_search', ['memory:read'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return semantic.hybridSearch(userId, spaceId, args.query, args.limit, args.types, args.tags);
  }));

  server.registerTool('memory_recall', {
    description: 'Recall the most relevant durable memories for the supplied context.',
    inputSchema: { context: z.string().min(1).max(20000), space_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).default(10) }
  }, guarded('memory_recall', ['memory:read'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return semantic.hybridSearch(userId, spaceId, args.context, args.limit);
  }));

  server.registerTool('memory_get', {
    description: 'Get one memory by opaque ID after checking current user space membership.', inputSchema: { memory_id: z.string().uuid() }
  }, guarded('memory_get', ['memory:read'], async (args, userId) => {
    const spaceId = await repository.spaceForMemory(userId, args.memory_id);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return repository.get(userId, args.memory_id);
  }));

  server.registerTool('memory_update', {
    description: 'Update a memory and preserve the previous state in version history.',
    inputSchema: { memory_id: z.string().uuid(), content: z.string().min(1).max(1_000_000).optional(), summary: z.string().max(2000).optional(), tags: z.array(z.string().max(80)).max(50).optional(), importance: z.number().min(0).max(1).optional(), confidence: z.number().min(0).max(1).optional(), status: z.enum(['active', 'pending_confirmation', 'superseded', 'archived']).optional(), reason: z.string().min(1).max(500).default('updated through MCP') }
  }, guarded('memory_update', ['memory:update'], async (args, userId) => {
    const spaceId = await repository.spaceForMemory(userId, args.memory_id);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:update');
    return semantic.update(userId, args.memory_id, {
      content: args.content, summary: args.summary, tags: args.tags, importance: args.importance, confidence: args.confidence, status: args.status
    }, args.reason);
  }));

  server.registerTool('memory_forget', {
    description: 'Soft-delete a memory. Permanent deletion additionally requires an admin role in the target space.',
    inputSchema: { memory_id: z.string().uuid(), permanent: z.boolean().default(false) }
  }, guarded('memory_forget', ['memory:delete'], async (args, userId) => {
    const spaceId = await repository.spaceForMemory(userId, args.memory_id);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:delete');
    await repository.forget(userId, args.memory_id, args.permanent);
    return { forgotten: true, permanent: args.permanent };
  }));

  server.registerTool('memory_extract', {
    description: 'Extract durable candidate memories from text using the Chat Provider configured for the target space. Does not store them.',
    inputSchema: { space_id: z.string().uuid().optional(), text: z.string().min(1).max(200_000) }
  }, guarded('memory_extract', ['memory:write'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:write');
    return { candidates: await semantic.extract(userId, spaceId, args.text) };
  }));

  server.registerTool('memory_extract_and_remember', {
    description: 'Extract durable memories from text and store up to 50 validated candidates in an authorized space.',
    inputSchema: { space_id: z.string().uuid().optional(), text: z.string().min(1).max(200_000) }
  }, guarded('memory_extract_and_remember', ['memory:write'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:write');
    return { memories: await semantic.extractAndRemember(userId, spaceId, args.text, principal.id) };
  }));

  server.registerTool('memory_conflicts', {
    description: 'List open, resolved or dismissed memory conflicts in an authorized space.',
    inputSchema: { space_id: z.string().uuid().optional(), status: z.enum(['open','resolved','dismissed']).default('open') }
  }, guarded('memory_conflicts', ['memory:read'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return { conflicts: await governance.listConflicts(userId, spaceId, args.status) };
  }));

  server.registerTool('memory_resolve_conflict', {
    description: 'Resolve a memory conflict by keeping A/B, merging into A, or dismissing it.',
    inputSchema: { conflict_id: z.string().uuid(), resolution: z.enum(['keep_a','keep_b','merge','dismiss']),
      merged_content: z.string().min(1).max(1_000_000).optional(), merged_summary: z.string().max(2000).optional(),
      merged_tags: z.array(z.string().max(80)).max(50).optional() }
  }, guarded('memory_resolve_conflict', ['memory:update'], async (args, userId) => {
    if (principal.agentId) throw new Error('Conflict resolution requires an interactive Authentik user.');
    return governance.resolve(userId, args.conflict_id, args.resolution,
      args.merged_content ? { content: args.merged_content, summary: args.merged_summary, tags: args.merged_tags } : undefined);
  }));

  server.registerTool('memory_link', {
    description: 'Create or update a typed relation between two memories in the same space.',
    inputSchema: { from_memory_id: z.string().uuid(), to_memory_id: z.string().uuid(), relation_type: z.string().min(1).max(100), confidence: z.number().min(0).max(1).default(1) }
  }, guarded('memory_link', ['memory:update'], async (args, userId) => {
    const spaceId = await repository.spaceForMemory(userId, args.from_memory_id);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:update');
    return governance.link(userId, args.from_memory_id, args.to_memory_id, args.relation_type, args.confidence);
  }));

  server.registerTool('memory_feedback', {
    description: 'Record whether a recalled memory was helpful and optionally submit a correction.',
    inputSchema: { memory_id: z.string().uuid(), helpful: z.boolean().optional(), correction: z.string().max(10_000).optional() }
  }, guarded('memory_feedback', ['memory:read'], async (args, userId) => {
    const spaceId = await repository.spaceForMemory(userId, args.memory_id);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return governance.feedback(userId, args.memory_id, args.helpful, args.correction);
  }));

  server.registerTool('memory_import', {
    description: 'Import up to 500 memories from JSON or Markdown. Returns a tracked ingestion job summary.',
    inputSchema: { space_id: z.string().uuid().optional(), format: z.enum(['json','markdown']), content: z.string().min(1).max(5_000_000) }
  }, guarded('memory_import', ['memory:write'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:write');
    return transfer.import(userId, spaceId, args.format, args.content, principal.id);
  }));

  server.registerTool('memory_import_queue', {
    description:'Preview or enqueue a durable import. Explicit human credentials required; completed items are never replayed.',
    inputSchema:{space_id:z.uuid(),format:z.enum(['json','markdown']),content:z.string().min(1).max(5000000),preview:z.boolean().default(true),duplicates:z.enum(['skip','keep']).default('skip')}
  },guarded('memory_import_queue',['memory:write'],async(args,userId)=>{
    requireHuman();
    const queue=new ImportQueue(database);
    if(args.preview)return queue.preview(userId,args.space_id,args.format,args.content);
    if(!getConfig().worker.enabled)throw new Error('Worker is disabled.');
    return queue.enqueue(userId,args.space_id,args.format,args.content,args.duplicates);
  }));
  server.registerTool('memory_browse',{
    description:'Browse memories with pagination and filters, including archived records and trash.',
    inputSchema:browseSchema.shape
  },guarded('memory_browse',['memory:read'],async(args,userId)=>{
    await requireAgentSpaceScope(database,principal.agentId,args.space_id,'memory:read');
    return new MemoryManagement(database).browse(userId,args);
  }));
  server.registerTool('memory_history',{
    description:'Read version metadata for one memory, without restoring it.',inputSchema:{memory_id:z.uuid(),page:z.number().int().min(1).max(100000).default(1)}
  },guarded('memory_history',['memory:read'],async(args,userId)=>{
    const service=new MemoryManagement(database),memory=await service.detail(userId,args.memory_id);
    await requireAgentSpaceScope(database,principal.agentId,memory.space_id,'memory:read');
    return service.history(userId,args.memory_id,args.page);
  }));

  server.registerTool('memory_import_status', {
    description: 'Read a memory import job and per-record error summary.', inputSchema: { job_id: z.string().uuid() }
  }, guarded('memory_import_status', ['memory:read'], async (args, userId) => transfer.status(userId, args.job_id, principal.agentId)));

  server.registerTool('memory_export', {
    description: 'Export an authorized memory space as portable JSON or Markdown.',
    inputSchema: { space_id: z.string().uuid().optional(), format: z.enum(['json','markdown']).default('json') }
  }, guarded('memory_export', ['memory:export'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:export');
    return transfer.export(userId, spaceId, args.format);
  }));

  server.registerTool('embedding_rebuild_start', {
    description: 'Queue a persistent background job to rebuild all active embeddings in a space.',
    inputSchema: { space_id: z.string().uuid().optional() }
  }, guarded('embedding_rebuild_start', ['space:manage'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'space:manage');
    return jobs.enqueue(userId, spaceId, 'rebuild_embeddings');
  }));

  server.registerTool('background_job_list', {
    description: 'List recent background jobs in an authorized space.',
    inputSchema: { space_id: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(50) }
  }, guarded('background_job_list', ['memory:read'], async (args, userId, personalSpaceId) => {
    const spaceId = args.space_id ?? personalSpaceId;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return { jobs: await jobs.list(userId, spaceId, args.limit) };
  }));

  server.registerTool('background_job_status', {
    description: 'Read a background job status and progress.', inputSchema: { job_id: z.string().uuid() }
  }, guarded('background_job_status', ['memory:read'], async (args, userId) => jobs.get(userId, args.job_id, principal.agentId)));

  server.registerTool('background_job_cancel', {
    description: 'Request cancellation of a pending or processing background job.', inputSchema: { job_id: z.string().uuid() }
  }, guarded('background_job_cancel', ['space:manage'], async (args, userId) => jobs.cancel(userId, args.job_id, principal.agentId)));

  server.registerTool('background_job_retry', {
    description: 'Retry a failed or cancelled background job from the beginning.', inputSchema: { job_id: z.string().uuid() }
  }, guarded('background_job_retry', ['space:manage'], async (args, userId) => jobs.retry(userId, args.job_id, principal.agentId)));

  server.registerTool('audit_list', {
    description: 'List audit events visible to the current user, space administrator, or system administrator.',
    inputSchema: { space_id: z.string().uuid().optional(), action: z.string().max(200).optional(),
      result: z.enum(['success','error']).optional(), limit: z.number().int().min(1).max(200).default(100),
      cursor: z.number().int().positive().optional() }
  }, guarded('audit_list', ['memory:read'], async (args, userId) => {
    if (args.space_id) await requireAgentSpaceScope(database, principal.agentId, args.space_id, 'memory:read');
    const systemAdmin = principal.source === 'local' || (principal.source === 'authentik'
      && Boolean((await database.query<{ is_system_admin: boolean }>('SELECT is_system_admin FROM users WHERE id=$1', [userId])).rows[0]?.is_system_admin));
    return audit.list(userId, { spaceId: args.space_id, action: args.action, result: args.result,
      limit: args.limit, cursor: args.cursor, systemAdmin, agentId: principal.agentId });
  }));

  server.registerTool('space_list', {
    description: 'List personal and shared memory spaces visible to the current user.', inputSchema: {}
  }, guarded('space_list', ['memory:read'], (_args, userId) => spaces.list(userId, principal.agentId)));

  server.registerTool('space_create', {
    description: 'Create a shared memory space. The current user becomes its owner.',
    inputSchema: { name: z.string().min(1).max(120), description: z.string().max(2000).default('') }
  }, guarded('space_create', ['space:create'], async (args, userId) => { requireHuman(); return spaces.create(userId, args.name, args.description); }));

  server.registerTool('space_list_members', {
    description: 'List members and roles in a visible memory space.', inputSchema: { space_id: z.string().uuid() }
  }, guarded('space_list_members', ['memory:read'], async (args, userId) => {
    await requireAgentSpaceScope(database, principal.agentId, args.space_id, 'memory:read');
    return spaces.members(userId, args.space_id);
  }));

  server.registerTool('space_invite_member', {
    description: 'Invite an Authentik user email to a shared space. The one-time token must be delivered privately.',
    inputSchema: {
      space_id: z.string().uuid(), email: z.email(),
      role: z.enum(['admin', 'editor', 'contributor', 'viewer']).default('contributor'),
      expires_in_hours: z.number().int().min(1).max(168).default(48)
    }
  }, guarded('space_invite_member', ['member:manage'], async (args, userId) => { requireHuman(); return spaces.invite(userId, args.space_id, args.email, args.role, args.expires_in_hours); }));

  server.registerTool('space_accept_invitation', {
    description: 'Accept a shared-space invitation for the current Authentik email. Tokens are single-use and expire.',
    inputSchema: { token: z.string().min(32).max(200) }
  }, guarded('space_accept_invitation', ['memory:read'], async (args, userId) => { requireHuman(); return spaces.accept(userId, principal.email, args.token); }));

  const agentScopes = z.array(z.enum([
    'memory:read', 'memory:write', 'memory:update', 'memory:delete', 'memory:export',
    'space:create', 'space:manage', 'member:manage', 'agent:manage'
  ])).min(1).max(9);

  server.registerTool('agent_create', {
    description: 'Create an Agent API key. The plaintext token is returned here and can be shown again in the management console.',
    inputSchema: { name: z.string().min(1).max(120), scopes: agentScopes, expires_at: z.iso.datetime().optional() }
  }, guarded('agent_create', ['agent:manage'], async (args, userId) => {
    requireHuman();
    return agents.create(userId, args.name, args.scopes, args.expires_at);
  }));

  server.registerTool('agent_list', {
    description: 'List the current user Agent credentials and space grants without secret values.', inputSchema: {}
  }, guarded('agent_list', ['agent:manage'], async (_args, userId) => { requireHuman(); return agents.list(userId); }));

  server.registerTool('agent_delete', {
    description: 'Permanently delete an Agent API key. The key stops working immediately and cannot be restored.',
    inputSchema: { agent_id: z.string().uuid() }
  }, guarded('agent_delete', ['agent:manage'], async (args, userId) => { requireHuman(); await agents.remove(userId, args.agent_id); return { deleted: true }; }));

  server.registerTool('agent_grant_space', {
    description: 'Grant an owned Agent selected scopes in a memory space visible to the current user.',
    inputSchema: { agent_id: z.string().uuid(), space_id: z.string().uuid(), scopes: agentScopes }
  }, guarded('agent_grant_space', ['agent:manage'], async (args, userId) => { requireHuman(); return agents.grant(userId, args.agent_id, args.space_id, args.scopes); }));

  server.registerTool('agent_revoke_space', {
    description: 'Remove all access an owned Agent has to a memory space.',
    inputSchema: { agent_id: z.string().uuid(), space_id: z.string().uuid() }
  }, guarded('agent_revoke_space', ['agent:manage'], async (args, userId) => { requireHuman(); await agents.revokeGrant(userId, args.agent_id, args.space_id); return { revoked: true }; }));

  server.registerResource('memory-spaces', 'memory://spaces', {
    title: 'Accessible memory spaces', description: 'Personal and shared spaces visible to this user or Agent.', mimeType: 'application/json'
  }, (uri, ctx) => trackOperation(async () => {
    operationSignal()?.throwIfAborted();
    requireScopes(principal, ['memory:read']);
    const { userId } = await identity;
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await spaces.list(userId, principal.agentId), null, 2) }] };
  }, undefined, ctx.mcpReq.signal));

  server.registerResource('memory-space', new ResourceTemplate('memory://spaces/{spaceId}', {
    list: ctx => trackOperation(async () => {
      operationSignal()?.throwIfAborted();
      requireScopes(principal, ['memory:read']);
      const { userId } = await identity;
      return { resources: (await spaces.list(userId, principal.agentId)).map(space => ({
        uri: `memory://spaces/${space.id}`, name: space.name as string, title: space.name as string,
        description: space.description as string, mimeType: 'application/json'
      })) };
    }, undefined, ctx.mcpReq.signal)
  }), { title: 'Memory space', description: 'Space metadata and recent active memories.', mimeType: 'application/json' },
  (uri, variables, ctx) => trackOperation(async () => {
    operationSignal()?.throwIfAborted();
    requireScopes(principal, ['memory:read']);
    const spaceId = z.string().uuid().parse(variables.spaceId);
    const { userId } = await identity;
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    const visible = (await spaces.list(userId, principal.agentId)).find(space => space.id === spaceId);
    if (!visible) throw new Error('Memory space not found or access denied.');
    const recent = await repository.search(userId, spaceId, '', 100);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ space: visible, memories: recent }, null, 2) }] };
  }, undefined, ctx.mcpReq.signal));

  server.registerResource('memory-record', new ResourceTemplate('memory://memories/{memoryId}', { list: undefined }), {
    title: 'Memory record', description: 'A single authorized memory with its structured metadata.', mimeType: 'application/json'
  }, (uri, variables, ctx) => trackOperation(async () => {
    operationSignal()?.throwIfAborted();
    requireScopes(principal, ['memory:read']);
    const memoryId = z.string().uuid().parse(variables.memoryId);
    const { userId } = await identity;
    const spaceId = await repository.spaceForMemory(userId, memoryId);
    await requireAgentSpaceScope(database, principal.agentId, spaceId, 'memory:read');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await repository.get(userId, memoryId), null, 2) }] };
  }, undefined, ctx.mcpReq.signal));
  return server;
}