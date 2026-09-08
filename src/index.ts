import { serve } from '@hono/node-server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Context, Next } from 'hono';
import pino from 'pino';
import * as z from 'zod/v4';
import { AuditLogger } from './audit.js';
import { AgentRepository } from './agents/repository.js';
import { AuthService } from './auth.js';
import { loadConfig } from './config.js';
import { Database } from './database.js';
import { MemoryRepository } from './memory/repository.js';
import { SpaceRepository } from './spaces/repository.js';
import { SemanticMemoryService } from './semantic/service.js';
import { MemoryGovernanceService } from './governance/service.js';
import { MemoryTransferService } from './transfer/service.js';
import { JobRepository } from './jobs/repository.js';
import { BackgroundWorker } from './jobs/worker.js';
import { createServer } from './tools.js';
import { setupPage, setupScript } from './setup/page.js';
import { authentikConfigSchema, authentikDiscoveryInputSchema, SetupService, setupInputSchema } from './setup/service.js';
import { SettingsRepository } from './settings/repository.js';
import { WebSessionService } from './web/session.js';
import type { WebIdentity } from './web/session.js';
import { adminPage } from './web/admin-page.js';
import { loginPage } from './web/login-page.js';
import { RateLimiter, securityHeaders } from './security/http.js';
import { APP_VERSION, UpdateChecker } from './version.js';
import { isRootMcpRequest, streamWithDeferredCleanup } from './mcp-routing.js';

const baseConfig = loadConfig();
const logger = pino({ level: baseConfig.logLevel });
const database = new Database(baseConfig.database.connectionString, baseConfig.database.maxConnections);
if (baseConfig.database.autoMigrate) {
  logger.info({ attempts: 30 }, 'Waiting for PostgreSQL and applying migrations');
  await database.migrateWithRetry(`${process.cwd()}/migrations`);
}
const audit = new AuditLogger(baseConfig.auditLogPath, database);
const settings = new SettingsRepository(database, baseConfig.setup.encryptionKey);
let config = await settings.apply(baseConfig);
let auth = new AuthService(config, database);
const setup = new SetupService(baseConfig.authEnabled, baseConfig.publicBaseUrl, database, settings);
const updateChecker = new UpdateChecker();
const webSessions = new WebSessionService(database, () => config);
const memories = new MemoryRepository(database);
const spaces = new SpaceRepository(database);
const agents = new AgentRepository(database, baseConfig.setup.encryptionKey);
const semantic = new SemanticMemoryService(database, () => config);
const governance = new MemoryGovernanceService(database);
const transfer = new MemoryTransferService(database, semantic, governance);
const jobs = new JobRepository(database);
const worker = new BackgroundWorker(database, semantic, baseConfig.worker.pollIntervalMs,
  baseConfig.worker.staleAfterSeconds, logger);
if (baseConfig.worker.enabled) worker.start();
const app = createMcpHonoApp({ host: baseConfig.host, allowedHosts: [new URL(baseConfig.publicBaseUrl).hostname] });
const limiter = new RateLimiter();

app.use('*', securityHeaders());
app.use('/mcp', limiter.middleware('mcp', baseConfig.security.mcpPerMinute, baseConfig.security.trustProxy));
app.use('/', limiter.middleware('mcp-root', baseConfig.security.mcpPerMinute, baseConfig.security.trustProxy));
app.use('/auth/*', limiter.middleware('auth', baseConfig.security.authPerMinute, baseConfig.security.trustProxy));
app.use('/api/setup/*', limiter.middleware('setup', baseConfig.security.setupPerMinute, baseConfig.security.trustProxy));
app.use('/api/admin/*', limiter.middleware('web', baseConfig.security.webPerMinute, baseConfig.security.trustProxy));
app.use('/api/admin/*', async (context, next) => {
  if (!(await settings.installation()).completed) {
    return context.json({ error: 'setup_required', error_description: 'Complete installation at /setup first.' }, 503);
  }
  await next();
});

app.onError((error, context) => {
  logger.error({ err: error, path: context.req.path }, 'Unhandled HTTP error');
  return context.json({ error: 'internal_error', error_description: 'Internal server error.' }, 500);
});

const setupGuard = async (context: Context, next: Next) => {
  const installation = await settings.installation();
  if (installation.completed) return context.json({ error: 'setup_locked', error_description: 'Sakura-MCP-Server is already installed.' }, 410);
  await next();
};

app.all('/', async context => isRootMcpRequest(context.req.method, context.req.raw.headers)
  ? handleMcp(context)
  : context.redirect((await settings.installation()).completed ? '/admin' : '/setup'));
app.get('/setup', context => context.html(setupPage));
app.get('/assets/setup.js', context => context.body(setupScript, 200, {
  'Content-Type': 'application/javascript; charset=UTF-8', 'Cache-Control': 'no-store'
}));
app.get('/api/setup/status', async context => context.json({ ...(await settings.installation()), authEnabled: baseConfig.authEnabled }));
app.use('/api/setup/*', setupGuard);
app.get('/api/setup/diagnostics', async context => context.json(await setup.diagnostics()));
app.post('/api/setup/discover-authentik', async context => {
  try {
    const body = authentikDiscoveryInputSchema.parse(await context.req.json());
    return context.json(await setup.discoverAuthentik(body));
  } catch (error) {
    return context.json({ error: 'authentik_discovery_failed',
      error_description: error instanceof Error ? error.message : 'Authentik discovery failed.' }, 400);
  }
});
app.post('/api/setup/test-authentik', async context => {
  try {
    if (!baseConfig.authEnabled) return context.json({ status: 'skipped', authEnabled: false });
    const body = setupInputSchema.pick({ authentik: true }).parse(await context.req.json());
    if (!body.authentik) throw new Error('Authentik configuration is required.');
    return context.json(await setup.testAuthentik(body.authentik));
  } catch (error) { return context.json({ error: 'validation_failed', error_description: error instanceof Error ? error.message : 'Validation failed.' }, 400); }
});
app.post('/api/setup/test-provider', async context => {
  try {
    const body = setupInputSchema.pick({ openaiCompatible: true, ollama: true, embedding: true }).parse(await context.req.json());
    return context.json(await setup.testProvider(body));
  } catch (error) { return context.json({ error: 'provider_test_failed', error_description: error instanceof Error ? error.message : 'Provider test failed.' }, 400); }
});
app.post('/api/setup/complete', async context => {
  try {
    const body = setupInputSchema.parse(await context.req.json());
    await setup.complete(body);
    config = await settings.apply(baseConfig);
    auth = new AuthService(config, database);
    await audit.record({ action: 'system.install', authSource: 'first_run_setup', result: 'success', metadata: { administratorEmail: body.administratorEmail } });
    return context.json({ completed: true });
  } catch (error) {
    await audit.record({ action: 'system.install', authSource: 'first_run_setup', result: 'error', metadata: { message: error instanceof Error ? error.message : 'Setup failed.' } });
    return context.json({ error: 'setup_failed', error_description: error instanceof Error ? error.message : 'Setup failed.' }, 400);
  }
});

app.get('/auth/login', async context => {
  if (!(await settings.installation()).completed) return context.redirect('/setup');
  if (!config.authEnabled) return context.redirect('/admin');
  // Probe once per visit. `probed=1` marks the round trip as done so a provider
  // error can never bounce the visitor between here and Authentik forever.
  if (context.req.query('probed') !== '1' && !context.req.query('reason')) {
    const returnTo = context.req.query('return_to') ?? '/admin';
    try { return context.redirect(await webSessions.begin(returnTo, 'probe')); }
    catch { return context.html(loginPage); }
  }
  return context.html(loginPage);
});
app.get('/auth/start', async context => {
  if (!(await settings.installation()).completed) return context.redirect('/setup');
  if (!config.authEnabled) return context.redirect('/admin');
  try {
    const url = await webSessions.begin(context.req.query('return_to') ?? '/admin');
    // "Sign in as someone else" must reach the account picker even though an SSO
    // session exists, so forward the intent to Authentik.
    const target = context.req.query('switch') === '1'
      ? (() => { const u = new URL(url); u.searchParams.set('prompt', 'select_account'); return u.toString(); })()
      : url;
    context.header('Set-Cookie', webSessions.clearProbeHintCookie());
    return context.redirect(target);
  }
  catch (error) { return context.json({ error: 'login_failed', error_description: error instanceof Error ? error.message : 'Login failed.' }, 500); }
});
app.get('/auth/callback', async context => {
  if (!config.authEnabled) return context.json({ error: 'auth_disabled', error_description: 'Authentication is disabled.' }, 404);
  const code = context.req.query('code'); const state = context.req.query('state');
  const failure = context.req.query('error');
  // A silent probe answers with an error rather than a code when Authentik has no
  // usable SSO session. Treat those as "not signed in" and fall through quietly.
  if (!code && failure) {
    return context.redirect(WebSessionService.isProbeMiss(failure)
      ? '/auth/login?probed=1'
      : '/auth/login?probed=1&reason=probe_failed');
  }
  if (!code || !state) return context.json({ error: 'invalid_callback', error_description: 'Missing code or state.' }, 400);
  // Probe transactions are claimed by purpose, so this never consumes a login.
  try {
    const probed = await webSessions.probeCallback(code, state);
    context.header('Set-Cookie', webSessions.probeHintCookie(probed.displayName));
    return context.redirect(`/auth/login?probed=1&return_to=${encodeURIComponent(probed.returnTo)}`);
  } catch { /* Not a probe; fall through to the ordinary login exchange. */ }
  try {
    const result = await webSessions.callback(code, state);
    context.header('Set-Cookie', webSessions.cookie(result.token));
    // A response can carry both the new session cookie and the old probe-cookie
    // deletion. Append the second Set-Cookie instead of replacing the session.
    context.header('Set-Cookie', webSessions.clearProbeHintCookie(), { append: true });
    const identity = await webSessions.authenticate(result.token);
    await audit.record({ actorUserId: identity.userId, authSource: 'authentik', action: 'auth.login', result: 'success' });
    return context.redirect(result.returnTo);
  } catch (error) {
    await audit.record({ authSource: 'authentik', action: 'auth.login', result: 'error', metadata: { message: error instanceof Error ? error.message : 'OIDC callback failed.' } });
    return context.json({ error: 'callback_failed', error_description: error instanceof Error ? error.message : 'OIDC callback failed.' }, 401);
  }
});

app.post('/auth/logout', async context => {
  if (!config.authEnabled) return context.json({ loggedOut: true, authEnabled: false, redirectTo: '/admin' });
  try {
    const token = WebSessionService.readCookie(context.req.header('cookie'));
    const identity = await webSessions.authenticate(token);
    if (!webSessions.verifyCsrf(identity, context.req.header('x-csrf-token'))) {
      return context.json({ error: 'csrf_failed', error_description: 'CSRF token is missing or invalid.' }, 403);
    }
    await webSessions.logout(token);
    await audit.record({ actorUserId: identity.userId, authSource: 'authentik', action: 'auth.logout', result: 'success' });
    context.header('Set-Cookie', webSessions.clearCookie());
    return context.json({ loggedOut: true, redirectTo: webSessions.endSessionUrl() ?? '/auth/login?reason=logged_out' });
  } catch (error) {
    return context.json({ error: 'unauthorized', error_description: error instanceof Error ? error.message : 'Unauthorized.' }, 401);
  }
});
app.get('/api/me', async context => {
  try {
    const identity = await adminIdentity(context);
    return context.json({ id: identity.userId, email: identity.email, displayName: identity.displayName,
      avatarUrl: identity.avatarUrl, isSystemAdmin: identity.isSystemAdmin, expiresAt: identity.expiresAt });
  } catch (error) { return context.json({ error: 'unauthorized', error_description: error instanceof Error ? error.message : 'Unauthorized.' }, 401); }
});
app.get('/admin', async context => {
  if (!(await settings.installation()).completed) return context.redirect('/setup');
  if (!config.authEnabled) return context.html(adminPage);
  try {
    await adminIdentity(context);
    return context.html(adminPage);
  } catch { return context.redirect('/auth/login?return_to=/admin'); }
});

const memoryTypeSchema = z.enum(['fact', 'preference', 'event', 'task', 'person', 'project', 'summary', 'document', 'idea', 'other']);
const memoryWriteSchema = z.object({
  space_id: z.string().uuid(), type: memoryTypeSchema.default('other'), content: z.string().min(1).max(1_000_000),
  summary: z.string().max(2000).default(''), tags: z.array(z.string().min(1).max(80)).max(50).default([])
});
const agentScopeSchema = z.array(z.enum([
  'memory:read', 'memory:write', 'memory:update', 'memory:delete', 'memory:export',
  'space:create', 'space:manage', 'member:manage', 'agent:manage'
])).min(1).max(9);

app.get('/api/admin/bootstrap', async context => adminApi(context, false, async identity => ({
  csrf: webSessions.csrf(identity),
  version: APP_VERSION, authEnabled: config.authEnabled,
  me: { id: identity.userId, email: identity.email, displayName: identity.displayName, isSystemAdmin: identity.isSystemAdmin },
  spaces: await spaces.list(identity.userId), agents: await agents.list(identity.userId)
})));
app.get('/api/admin/version', async context => adminApi(context, false, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  return updateChecker.check(context.req.query('force') === 'true');
}));
app.get('/api/admin/spaces', async context => adminApi(context, false, identity => spaces.list(identity.userId)));
app.post('/api/admin/spaces', async context => adminApi(context, true, async identity => {
  const body = z.object({ name: z.string().min(1).max(120), description: z.string().max(2000).default('') }).parse(await context.req.json());
  return spaces.create(identity.userId, body.name, body.description);
}));
app.get('/api/admin/spaces/:id/members', async context => adminApi(context, false, identity =>
  spaces.members(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.post('/api/admin/spaces/:id/invitations', async context => adminApi(context, true, async identity => {
  const body = z.object({ email: z.email(), role: z.enum(['admin', 'editor', 'contributor', 'viewer']).default('contributor'), expires_in_hours: z.number().int().min(1).max(168).default(48) }).parse(await context.req.json());
  return spaces.invite(identity.userId, z.string().uuid().parse(context.req.param('id')), body.email, body.role, body.expires_in_hours);
}));
app.get('/api/admin/spaces/:id/strategy', async context => adminApi(context, false, identity =>
  semantic.strategy(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.put('/api/admin/spaces/:id/strategy', async context => adminApi(context, true, async identity => {
  const body = z.object({
    providerType: z.enum(['openai_compatible', 'ollama']).optional(), chatModel: z.string().max(200).optional(),
    embeddingModel: z.string().max(200).optional(), autoExtractEnabled: z.boolean().default(false),
    autoMergeEnabled: z.boolean().default(false), conflictDetectionEnabled: z.boolean().default(true), privacyMode: z.boolean().default(false)
  }).parse(await context.req.json());
  return semantic.configureStrategy(identity.userId, z.string().uuid().parse(context.req.param('id')), body);
}));
app.get('/api/admin/memories', async context => adminApi(context, false, async identity => {
  const query = z.object({ space_id: z.string().uuid(), query: z.string().max(2000).default('') }).parse(context.req.query());
  return { memories: await semantic.hybridSearch(identity.userId, query.space_id, query.query, 100) };
}));
app.post('/api/admin/memories', async context => adminApi(context, true, async identity => {
  const body = memoryWriteSchema.parse(await context.req.json());
  return semantic.remember(identity.userId, { spaceId: body.space_id, type: body.type, content: body.content,
    summary: body.summary, tags: body.tags, source: { type: 'web_admin', agent: identity.subject } });
}));
app.patch('/api/admin/memories/:id', async context => adminApi(context, true, async identity => {
  const id = z.string().uuid().parse(context.req.param('id'));
  const body = memoryWriteSchema.omit({ space_id: true, type: true }).partial().parse(await context.req.json());
  return semantic.update(identity.userId, id, body, 'updated through Web management');
}));
app.delete('/api/admin/memories/:id', async context => adminApi(context, true, async identity => {
  const id = z.string().uuid().parse(context.req.param('id'));
  await memories.forget(identity.userId, id, false);
  return { deleted: true };
}));
app.get('/api/admin/conflicts', async context => adminApi(context, false, async identity => {
  const query = z.object({ space_id: z.string().uuid(), status: z.enum(['open','resolved','dismissed']).default('open') }).parse(context.req.query());
  return { conflicts: await governance.listConflicts(identity.userId, query.space_id, query.status) };
}));
app.post('/api/admin/conflicts/:id/resolve', async context => adminApi(context, true, async identity => {
  const body = z.object({ resolution: z.enum(['keep_a','keep_b','merge','dismiss']), content: z.string().min(1).max(1_000_000).optional(),
    summary: z.string().max(2000).optional(), tags: z.array(z.string().max(80)).max(50).optional() }).parse(await context.req.json());
  return governance.resolve(identity.userId, z.string().uuid().parse(context.req.param('id')), body.resolution,
    body.content ? { content: body.content, summary: body.summary, tags: body.tags } : undefined);
}));
app.post('/api/admin/imports', async context => adminApi(context, true, async identity => {
  const body = z.object({ space_id: z.string().uuid(), format: z.enum(['json','markdown']), content: z.string().min(1).max(5_000_000) }).parse(await context.req.json());
  return transfer.import(identity.userId, body.space_id, body.format, body.content, identity.subject);
}));
app.get('/api/admin/imports/:id', async context => adminApi(context, false, identity =>
  transfer.status(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.get('/api/admin/exports', async context => {
  let identity: WebIdentity | undefined;
  try {
    identity = await adminIdentity(context);
    const query = z.object({ space_id: z.string().uuid(), format: z.enum(['json','markdown']).default('json') }).parse(context.req.query());
    const exported = await transfer.export(identity.userId, query.space_id, query.format);
    await audit.record({ actorUserId: identity.userId, spaceId: query.space_id, authSource: webAuthSource(),
      action: 'web.GET./api/admin/exports', targetType: 'space_export', targetId: query.space_id, result: 'success', metadata: { format: query.format } });
    context.header('Content-Type', `${exported.mimeType}; charset=utf-8`);
    context.header('Content-Disposition', `attachment; filename="${exported.filename}"`);
    return context.body(exported.content);
  } catch (error) {
    await audit.record({ actorUserId: identity?.userId, authSource: identity ? webAuthSource() : undefined,
      action: 'web.GET./api/admin/exports', result: 'error', metadata: { message: error instanceof Error ? error.message : 'Export failed.' } });
    return context.json({ error: 'export_failed', error_description: error instanceof Error ? error.message : 'Export failed.' }, 400);
  }
});
app.get('/api/admin/jobs', async context => adminApi(context, false, async identity => {
  const query = z.object({ space_id: z.string().uuid(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(context.req.query());
  return { jobs: await jobs.list(identity.userId, query.space_id, query.limit) };
}));
app.post('/api/admin/jobs/rebuild-embeddings', async context => adminApi(context, true, async identity => {
  const body = z.object({ space_id: z.string().uuid() }).parse(await context.req.json());
  return jobs.enqueue(identity.userId, body.space_id, 'rebuild_embeddings');
}));
app.post('/api/admin/jobs/:id/cancel', async context => adminApi(context, true, identity =>
  jobs.cancel(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.post('/api/admin/jobs/:id/retry', async context => adminApi(context, true, identity =>
  jobs.retry(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.get('/api/admin/agents', async context => adminApi(context, false, identity => agents.list(identity.userId)));
app.post('/api/admin/agents', async context => adminApi(context, true, async identity => {
  const body = z.object({ name: z.string().min(1).max(120), scopes: agentScopeSchema, expires_at: z.iso.datetime().optional() }).parse(await context.req.json());
  return agents.create(identity.userId, body.name, body.scopes, body.expires_at);
}));
app.delete('/api/admin/agents/:id', async context => adminApi(context, true, async identity => {
  await agents.remove(identity.userId, z.string().uuid().parse(context.req.param('id')));
  return { deleted: true };
}));
app.post('/api/admin/agents/:id/reveal', async context => adminApi(context, true, identity =>
  agents.reveal(identity.userId, z.string().uuid().parse(context.req.param('id')))));
app.post('/api/admin/agents/:id/grants', async context => adminApi(context, true, async identity => {
  const body = z.object({ space_id: z.string().uuid(), scopes: agentScopeSchema }).parse(await context.req.json());
  return agents.grant(identity.userId, z.string().uuid().parse(context.req.param('id')), body.space_id, body.scopes);
}));
app.get('/api/admin/providers', async context => adminApi(context, false, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  return {
    openaiCompatible: config.openaiCompatible ? { configured: true, baseUrl: config.openaiCompatible.baseUrl,
      chatModel: config.openaiCompatible.chatModel, embeddingModel: config.openaiCompatible.embeddingModel, hasApiKey: Boolean(config.openaiCompatible.apiKey) } : { configured: false },
    ollama: config.ollama ? { configured: true, baseUrl: config.ollama.baseUrl,
      chatModel: config.ollama.chatModel, embeddingModel: config.ollama.embeddingModel } : { configured: false },
    embedding: config.embedding ? { configured: true, baseUrl: config.embedding.baseUrl,
      model: config.embedding.model, hasApiKey: Boolean(config.embedding.apiKey) } : { configured: false }
  };
}));
app.put('/api/admin/providers/:kind', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const kind = z.enum(['openai_compatible', 'ollama', 'embedding']).parse(context.req.param('kind'));
  if (kind === 'embedding') {
    const body = z.object({ baseUrl: z.url(), apiKey: z.string().max(1000).optional(), model: z.string().max(200).optional() }).parse(await context.req.json());
    if (!body.apiKey && config.embedding?.apiKey) body.apiKey = config.embedding.apiKey;
    if (body.model) await setup.testProvider({ embedding: { baseUrl: body.baseUrl.replace(/\/$/, ''), apiKey: body.apiKey, model: body.model } });
    await settings.saveProvider('embedding', { baseUrl: body.baseUrl.replace(/\/$/, ''), apiKey: body.apiKey, model: body.model });
    config = await settings.apply(baseConfig);
    auth = new AuthService(config, database);
    return { saved: true };
  }
  const body = z.object({ baseUrl: z.url(), apiKey: z.string().max(1000).optional(), chatModel: z.string().max(200).optional(), embeddingModel: z.string().max(200).optional() }).parse(await context.req.json());
  if (kind === 'openai_compatible' && !body.apiKey && config.openaiCompatible?.apiKey) body.apiKey = config.openaiCompatible.apiKey;
  await settings.saveProvider(kind, { baseUrl: body.baseUrl.replace(/\/$/, ''), apiKey: kind === 'openai_compatible' ? body.apiKey : undefined,
    chatModel: body.chatModel, embeddingModel: body.embeddingModel });
  config = await settings.apply(baseConfig);
  auth = new AuthService(config, database);
  return { saved: true };
}));
app.get('/api/admin/authentik', async context => adminApi(context, false, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const stored = await settings.get<NonNullable<typeof config.authentik>>('authentik');
  const installation = await settings.installation();
  return { authEnabled: config.authEnabled, configured: Boolean(stored ?? config.authentik),
    authentik: stored ?? config.authentik ?? null, administratorEmail: installation.administrator_email };
}));
app.put('/api/admin/authentik', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const body = z.object({ administratorEmail: z.email(), authentik: authentikConfigSchema }).parse(await context.req.json());
  const validation = await setup.testAuthentik(body.authentik);
  await settings.saveAuthentik(body.authentik, body.administratorEmail);
  config = await settings.apply(baseConfig);
  auth = new AuthService(config, database);
  return { saved: true, publicClient: validation.publicClient,
    restartRequired: !baseConfig.authEnabled, message: baseConfig.authEnabled
      ? 'Authentik 配置已保存并立即生效。' : 'Authentik 配置已保存。请将 AUTH 恢复为 true 并重启应用。' };
}));
app.get('/api/admin/audit', async context => adminApi(context, false, async identity => {
  const query = z.object({ space_id: z.string().uuid().optional(), action: z.string().max(200).optional(),
    result: z.enum(['success','error']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.coerce.number().int().positive().optional() }).parse(context.req.query());
  return audit.list(identity.userId, { spaceId: query.space_id, action: query.action, result: query.result,
    limit: query.limit, cursor: query.cursor, systemAdmin: identity.isSystemAdmin });
}));

app.get('/health', async context => {
  try {
    const [vector, installation, queue] = await Promise.all([
      database.query<{ version: string }>("SELECT extversion AS version FROM pg_extension WHERE extname='vector'"),
      settings.installation(),
      database.query<{ pending: string; processing: string; failed: string }>(
        `SELECT count(*) FILTER(WHERE status='pending')::text AS pending,
         count(*) FILTER(WHERE status='processing')::text AS processing,
         count(*) FILTER(WHERE status='failed')::text AS failed FROM ingestion_jobs`)
    ]);
    return context.json({ status: 'ok', service: 'Sakura-MCP-Server', version: APP_VERSION,
      database: 'ok', pgvector: vector.rows[0]?.version ?? 'missing', installed: installation.completed, authEnabled: config.authEnabled,
      worker: { enabled: baseConfig.worker.enabled, pending: Number(queue.rows[0].pending),
        processing: Number(queue.rows[0].processing), failed: Number(queue.rows[0].failed) } });
  } catch {
    return context.json({ status: 'degraded', service: 'Sakura-MCP-Server', version: APP_VERSION,
      database: 'unavailable', authEnabled: config.authEnabled }, 503);
  }
});
app.get('/.well-known/oauth-protected-resource', context => {
  if (!config.authentik) return context.json({ error: 'Authentik OAuth is not configured.' }, 404);
  return context.json({ resource: config.publicBaseUrl, authorization_servers: [config.authentik.issuer] });
});
app.get('/.well-known/oauth-protected-resource/mcp', context => {
  if (!config.authentik) return context.json({ error: 'Authentik OAuth is not configured.' }, 404);
  return context.json({ resource: `${config.publicBaseUrl}/mcp`, authorization_servers: [config.authentik.issuer] });
});
app.all('/mcp', handleMcp);

async function handleMcp(context: Context): Promise<Response> {
  if (!(await settings.installation()).completed) return context.json({ error: 'setup_required', error_description: 'Complete installation at /setup first.' }, 503);
  let principal;
  try { principal = await auth.authenticate(context.req.header('authorization')); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Unauthorized.';
    const metadataPath = context.req.path === '/' ? '/.well-known/oauth-protected-resource' : '/.well-known/oauth-protected-resource/mcp';
    return context.json({ error: 'unauthorized', error_description: message }, 401,
      { 'WWW-Authenticate': `Bearer resource_metadata="${config.publicBaseUrl}${metadataPath}"` });
  }
  const server = createServer(database, principal, audit, () => config);
  // Stateless transport prevents one authenticated client's session from being reused by another principal.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  let response: Response;
  try { response = await transport.handleRequest(context.req.raw, { parsedBody: context.get('parsedBody' as never) as unknown }); }
  catch (error) {
    logger.error({ err: error, principal: principal.id }, 'MCP transport request failed');
    await cleanup();
    return context.json({ error: 'MCP request failed.' }, 500);
  }
  return streamWithDeferredCleanup(response, cleanup);
}

serve({ fetch: app.fetch, hostname: baseConfig.host, port: baseConfig.port }, info => logger.info({ host: baseConfig.host, port: info.port }, 'Sakura MCP Server listening'));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'Sakura MCP Server shutting down');
    worker.stop();
    void database.close().finally(() => process.exit(0));
  });
}

async function adminIdentity(context: Context): Promise<WebIdentity> {
  return config.authEnabled
    ? webSessions.authenticate(WebSessionService.readCookie(context.req.header('cookie')))
    : webSessions.localIdentity();
}

async function adminApi(context: Context, write: boolean, handler: (identity: WebIdentity) => Promise<unknown>): Promise<Response> {
  let identity: WebIdentity | undefined;
  const action = `web.${context.req.method}.${context.req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')}`;
  try {
    identity = await adminIdentity(context);
    if (write && !webSessions.verifyCsrf(identity, context.req.header('x-csrf-token'))) {
      await audit.record({ actorUserId: identity.userId, authSource: webAuthSource(), action, result: 'error',
        metadata: { reason: 'csrf_failed' } });
      return context.json({ error: 'csrf_failed', error_description: 'CSRF token is missing or invalid.' }, 403);
    }
    const result = await handler(identity);
    const object = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    await audit.record({ actorUserId: identity.userId, authSource: webAuthSource(), action,
      spaceId: auditUuid(context.req.query('space_id')) ?? auditUuid(object.space_id) ?? auditUuid(object.spaceId),
      targetId: auditUuid(context.req.param('id')) ?? auditUuid(object.id), result: 'success' });
    return context.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    const unauthorized = /session is|session is missing/i.test(message);
    await audit.record({ actorUserId: identity?.userId, authSource: identity ? webAuthSource() : undefined, action, result: 'error', metadata: { message } });
    return context.json({ error: unauthorized ? 'unauthorized' : 'request_failed', error_description: message }, unauthorized ? 401 : 400);
  }
}

function auditUuid(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

function webAuthSource(): 'authentik' | 'local' { return config.authEnabled ? 'authentik' : 'local'; }
