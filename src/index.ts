import { managementScript } from './web/management-script.js';
import { registerManagementRoutes } from './web/management-routes.js';
import { streamingExport } from './transfer/stream.js';
import { serve } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Context, Next } from 'hono';
import pino from 'pino';
import * as z from 'zod/v4';
import { AuditLogger } from './audit.js';
import { AgentRepository } from './agents/repository.js';
import { AuthService } from './auth.js';
import type { Principal } from './auth.js';
import { ClientSessionRepository } from './clients/repository.js';
import { isWriteTool, readMcpFacts } from './clients/facts.js';
import type { ClientIdentity } from './clients/types.js';
import { loadConfig } from './config.js';
import type { OidcProvider } from './config.js';
import { Database } from './database.js';
import { MemoryRepository } from './memory/repository.js';
import { SpaceRepository } from './spaces/repository.js';
import { SemanticMemoryService } from './semantic/service.js';
import { MemoryGovernanceService } from './governance/service.js';
import { MemoryTransferService } from './transfer/service.js';
import { JobRepository } from './jobs/repository.js';
import { BackgroundWorker } from './jobs/worker.js';
import { createServer } from './tools.js';
import { setupScript } from './setup/page.js';
import { safeAdminPage as adminPage, safeLoginPage as loginPage, safeLocalLoginPage as localLoginPage, safeSetupPage as setupPage } from './security/pages.js';
import { authentikConfigSchema, authentikDiscoveryInputSchema, sakuraConfigSchema, sakuraDiscoveryInputSchema, SetupService, setupInputSchema } from './setup/service.js';
import { SettingsRepository } from './settings/repository.js';
import { WebSessionService, primaryOidcProvider, browserLoginConfigured, SILENT_PROBE_PROVIDERS } from './web/session.js';
import type { WebIdentity, WebAuthSource } from './web/session.js';
import { LocalLoginService } from './web/local-login.js';
import { attachmentHeader } from './security/http.js';
import { createHttpApp } from './security/app.js';
import { APP_VERSION, UpdateChecker } from './version.js';
import { isRootMcpRequest, readMcpBody, streamWithDeferredCleanup } from './mcp-routing.js';
import { RequestLifecycle, createShutdown } from './lifecycle.js';
import { operationContext, operationSignal, trackOperation } from './operations.js';

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
const localLogins = new LocalLoginService(database);
// An administrator declared through the environment is provisioned on every
// boot, so rotating the password only requires restarting with a new value.
if (config.localLogin.enabled && config.localLogin.adminUsername && config.localLogin.adminPassword) {
  try {
    logger.info({ username: config.localLogin.adminUsername }, 'Provisioning local administrator account');
    await localLogins.upsert(config.localLogin.adminUsername, config.localLogin.adminPassword, {
      displayName: 'Administrator', isSystemAdmin: true
    });
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'Local administrator provisioning failed');
  }
}
const updateChecker = new UpdateChecker();
const webSessions = new WebSessionService(database, () => config);
const memories = new MemoryRepository(database);
const spaces = new SpaceRepository(database);
const agents = new AgentRepository(database, baseConfig.setup.encryptionKey);
const clientSessions = new ClientSessionRepository(database);
const semantic = new SemanticMemoryService(database, () => config);
const governance = new MemoryGovernanceService(database);
const transfer = new MemoryTransferService(database, semantic, governance);
const jobs = new JobRepository(database);
const worker = new BackgroundWorker(database, semantic, baseConfig.worker.pollIntervalMs,
  baseConfig.worker.staleAfterSeconds, logger);
if (baseConfig.worker.enabled) worker.start();
const app = createHttpApp(baseConfig);
app.use('/api/admin/*', async (context, next) => {
  if (!(await settings.installation()).completed) {
    return context.json({ error: 'setup_required', error_description: 'Complete installation at /setup first.' }, 503);
  }
  await next();
});

registerManagementRoutes(app,database,adminApi,()=>config.worker.enabled);
app.onError((error, context) => {
  logger.error({ err: error, path: context.req.path }, 'Unhandled HTTP error');
  return context.json({ error: 'internal_error', error_description: 'Internal server error.' }, 500);
});

const setupGuard = async (context: Context, next: Next) => {
  const installation = await settings.installation();
  if (installation.completed) return context.json({ error: 'setup_locked', error_description: 'Sakura-MCP-Memory-Server is already installed.' }, 410);
  await next();
};

app.all('/', async context => isRootMcpRequest(context.req.method, context.req.raw.headers)
  ? handleMcp(context)
  : context.redirect((await settings.installation()).completed ? '/admin' : '/setup'));
app.get('/assets/management.js',context=>context.body(managementScript,200,{'Content-Type':'application/javascript; charset=UTF-8'}));
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
app.post('/api/setup/discover-sakura', async context => {
  try {
    const body = sakuraDiscoveryInputSchema.parse(await context.req.json());
    return context.json(await setup.discoverSakura(body));
  } catch (error) {
    return context.json({ error: 'sakura_discovery_failed',
      error_description: error instanceof Error ? error.message : 'Sakura discovery failed.' }, 400);
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
app.post('/api/setup/test-sakura', async context => {
  try {
    if (!baseConfig.authEnabled) return context.json({ status: 'skipped', authEnabled: false });
    const body = setupInputSchema.pick({ sakura: true }).parse(await context.req.json());
    if (!body.sakura) throw new Error('Sakura configuration is required.');
    return context.json(await setup.testSakura(body.sakura));
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
    if (baseConfig.authEnabled && body.localAdmin && baseConfig.localLogin.explicit === false) {
      throw new Error('LOCAL_LOGIN=false 已禁用本地登录，请先启用后再创建本地管理员。');
    }
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
  const primary = primaryOidcProvider(config);
  // No external OIDC provider: the local username/password page is the only way in.
  if (!primary) {
    if (config.localLogin.enabled) return context.html(localLoginPage);
    return context.json({ error: 'auth_misconfigured', error_description: 'No login method is configured. Set AUTHENTIK_*, SAKURA_* or enable LOCAL_LOGIN.' }, 500);
  }
  // Probe once per visit. `probed=1` marks the round trip as done so a provider
  // error can never bounce the visitor between here and the provider forever.
  // Only a provider that answers `prompt=none` with a standard error can be
  // probed; SakuraID would render its own login page instead of answering, so
  // it is reached through a plain link on the login page.
  if (context.req.query('probed') !== '1' && !context.req.query('reason') && !config.localLogin.enabled
    && !browserLoginConfigured(config, 'sakura') && SILENT_PROBE_PROVIDERS.includes(primary)) {
    const returnTo = context.req.query('return_to') ?? '/admin';
    try {
      const attempt = await webSessions.begin(returnTo, 'probe', primary);
      context.header('Set-Cookie', attempt.cookie);
      return context.redirect(attempt.url);
    }
    catch { return context.html(loginPage); }
  }
  return context.html(loginPage);
});
app.get('/auth/start', async context => {
  if (!(await settings.installation()).completed) return context.redirect('/setup');
  if (!config.authEnabled) return context.redirect('/admin');
  const requested = context.req.query('provider');
  const primary = primaryOidcProvider(config);
  if (requested !== undefined && (requested !== 'authentik' && requested !== 'sakura'
    || !browserLoginConfigured(config, requested as OidcProvider))) {
    return context.json({ error: 'provider_unavailable', error_description: '所选登录方式未配置或不可用。' }, 400);
  }
  const provider = requested as OidcProvider | undefined ?? primary;
  if (!provider) return context.json({ error: 'provider_unavailable' }, 400);
  try {
    const { url, cookie } = await webSessions.begin(context.req.query('return_to') ?? '/admin', 'login', provider);
    context.header('Set-Cookie', cookie);
    // "Sign in as someone else" must reach the account picker even though an SSO
    // session exists, so forward the intent to the provider; only Authentik
    // promises to honour an account-selection prompt.
    const target = context.req.query('switch') === '1' && provider === 'authentik'
      ? (() => { const u = new URL(url); u.searchParams.set('prompt', 'select_account'); return u.toString(); })()
      : url;
    context.header('Set-Cookie', webSessions.clearProbeHintCookie(), { append: true });
    return context.redirect(target);
  }
  catch (error) { return context.json({ error: 'login_failed', error_description: error instanceof Error ? error.message : 'Login failed.' }, 500); }
});
app.get('/auth/local-login', async context => {
  if (!(await settings.installation()).completed) return context.redirect('/setup');
  if (!config.authEnabled) return context.redirect('/admin');
  if (!config.localLogin.enabled) return context.json({ error: 'not_found', error_description: '本地登录未启用。' }, 404);
  return context.html(localLoginPage);
});

/** Public metadata only: which login methods this installation accepts. */
app.get('/auth/modes', async context => context.json({
  // `oidc`/`provider` describe the login page's primary path: the first
  // configured provider. `authentik`/`sakura` tell the page which individual
  // providers are available, so it can offer every configured method.
  oidc: primaryOidcProvider(config) !== undefined,
  provider: primaryOidcProvider(config) ?? null,
  authentik: browserLoginConfigured(config, 'authentik'),
  sakura: browserLoginConfigured(config, 'sakura'),
  local: config.localLogin.enabled
}));

const localLoginInputSchema = z.object({
  username: z.string().min(3).max(60), password: z.string().min(1).max(200), return_to: z.string().max(500).optional()
});

app.post('/auth/local', async context => {
  if (!config.authEnabled || !config.localLogin.enabled) {
    return context.json({ error: 'not_found', error_description: '本地登录未启用。' }, 404);
  }
  try {
    if (!(await settings.installation()).completed) throw new Error('安装尚未完成，请先访问 /setup。');
    const body = localLoginInputSchema.parse(await context.req.json());
    const account = await localLogins.login(body.username, body.password);
    const session = await webSessions.issueSession(account.userId, body.return_to ?? '/admin', 'local', account.credentialVersion);
    await audit.record({ actorUserId: account.userId, authSource: 'local', action: 'auth.login', result: 'success',
      metadata: { username: account.username } });
    context.header('Set-Cookie', webSessions.cookie(session.token));
    return context.json({ redirectTo: session.returnTo });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed.';
    await audit.record({ authSource: 'local', action: 'auth.login', result: 'error', metadata: { message } });
    // Never distinguish an unknown username from a wrong password; only lockout
    // notices surface, because the legitimate owner needs to know when to wait.
    return context.json({ error: 'login_failed', error_description: message.includes('锁定') ? message : '用户名或密码不正确。' }, 400);
  }
});

app.get('/auth/callback', async context => {
  if (!config.authEnabled) return context.json({ error: 'auth_disabled', error_description: 'Authentication is disabled.' }, 404);
  const code = context.req.query('code'); const state = context.req.query('state');
  const failure = context.req.query('error');
  // A silent probe answers with an error rather than a code when Authentik has no
  // usable SSO session. Treat those as "not signed in" and fall through quietly.
  if (!code && failure) {
    try {
      if (!state) throw new Error('Missing state.');
      const purpose = await webSessions.failedCallback(state, context.req.header('cookie'));
      context.header('Set-Cookie', webSessions.clearLoginCookie(state));
      return context.redirect(purpose === 'probe' && WebSessionService.isProbeMiss(failure)
        ? '/auth/login?probed=1'
        : '/auth/login?probed=1&reason=probe_failed');
    } catch { return context.json({ error: 'invalid_callback' }, 400); }
  }
  if (!code || !state) return context.json({ error: 'invalid_callback', error_description: 'Missing code or state.' }, 400);
  // Probe transactions are claimed by purpose, so this never consumes a login.
  try {
    const probed = await webSessions.probeCallback(code, state, context.req.header('cookie'));
    context.header('Set-Cookie', webSessions.clearLoginCookie(state));
    context.header('Set-Cookie', webSessions.probeHintCookie(probed.displayName), { append: true });
    return context.redirect(`/auth/login?probed=1&return_to=${encodeURIComponent(probed.returnTo)}`);
  } catch { /* Not a probe; fall through to the ordinary login exchange. */ }
  try {
    const result = await webSessions.callback(code, state, context.req.header('cookie'));
    context.header('Set-Cookie', webSessions.cookie(result.token));
    context.header('Set-Cookie', webSessions.clearLoginCookie(state), { append: true });
    // A response can carry both the new session cookie and the old probe-cookie
    // deletion. Append the second Set-Cookie instead of replacing the session.
    context.header('Set-Cookie', webSessions.clearProbeHintCookie(), { append: true });
    const identity = await webSessions.authenticate(result.token);
    await audit.record({ actorUserId: identity.userId, authSource: result.authSource, action: 'auth.login', result: 'success' });
    return context.redirect(result.returnTo);
  } catch (error) {
    await audit.record({ action: 'auth.login', result: 'error', metadata: { message: error instanceof Error ? error.message : 'OIDC callback failed.' } });
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
    await audit.record({ actorUserId: identity.userId, authSource: identity.authSource, action: 'auth.logout', result: 'success' });
    context.header('Set-Cookie', webSessions.clearCookie());
    return context.json({ loggedOut: true, redirectTo: webSessions.endSessionUrl('/auth/login', identity.authSource) ?? '/auth/login?reason=logged_out' });
  } catch (error) {
    return context.json({ error: 'unauthorized', error_description: error instanceof Error ? error.message : 'Unauthorized.' }, 401);
  }
});
app.get('/api/me', async context => {
  try {
    const identity = await adminIdentity(context);
    return context.json({ id: identity.userId, email: identity.email, displayName: identity.displayName,
      avatarUrl: identity.avatarUrl, isSystemAdmin: identity.isSystemAdmin, expiresAt: identity.expiresAt,
      authSource: identity.authSource, localLogin: config.localLogin.enabled });
  } catch (error) { return context.json({ error: 'unauthorized', error_description: error instanceof Error ? error.message : 'Unauthorized.' }, 401); }
});
app.post('/api/me/password', async context => adminApi(context, true, async identity => {
  if (!config.authEnabled || !config.localLogin.enabled || identity.authSource !== 'local') throw new Error('请使用本地账号登录后修改密码。');
  const body = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200)
  }).parse(await context.req.json());
  await localLogins.changePassword(identity.userId, body.currentPassword, body.newPassword);
  context.header('Set-Cookie', webSessions.clearCookie());
  return { changed: true, redirectTo: '/auth/local-login' };
}));
app.get('/api/me/sessions', async context => adminApi(context, false, async identity => {
  if (!config.authEnabled) throw new Error('AUTH=false 下没有登录会话。');
  return { sessions: await webSessions.listSessions(identity) };
}));
app.post('/api/me/sessions/revoke-others', async context => adminApi(context, true, async identity => {
  if (!config.authEnabled) throw new Error('AUTH=false 下没有登录会话。');
  await webSessions.revokeOtherSessions(identity);
  return { revoked: true };
}));
app.delete('/api/me/sessions/:id', async context => adminApi(context, true, async identity => {
  if (!config.authEnabled) throw new Error('AUTH=false 下没有登录会话。');
  const id = z.string().uuid().parse(context.req.param('id'));
  await webSessions.revokeSession(identity, id);
  const current = id === identity.sessionId;
  if (current) context.header('Set-Cookie', webSessions.clearCookie());
  return { revoked: true, redirectTo: current ? '/auth/login' : undefined };
}));
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
  version: APP_VERSION, authEnabled: config.authEnabled, localLogin: config.localLogin.enabled,
  me: { id: identity.userId, email: identity.email, displayName: identity.displayName, isSystemAdmin: identity.isSystemAdmin, authSource: identity.authSource },
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
    const exported = await streamingExport(database,identity.userId, query.space_id, query.format);
    await audit.record({ actorUserId: identity.userId, spaceId: query.space_id, authSource: webAuthSource(identity),
      action: 'web.GET./api/admin/exports', targetType: 'space_export', targetId: query.space_id, result: 'success', metadata: { format: query.format } });
    context.header('Content-Type', `${exported.mimeType}; charset=utf-8`);
    context.header('Content-Disposition', attachmentHeader(exported.filename));
    context.header('X-Export-Limits','50000 rows; 256 MiB; inspect truncated in download');
    return context.body(exported.stream);
  } catch (error) {
    await audit.record({ actorUserId: identity?.userId, authSource: identity ? webAuthSource(identity) : undefined,
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
app.get('/api/admin/clients', async context => adminApi(context, false, identity =>
  clientSessions.list(identity.userId, { systemAdmin: identity.isSystemAdmin })));
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
app.get('/api/admin/sakura', async context => adminApi(context, false, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const stored = await settings.get<NonNullable<typeof config.sakura>>('sakura');
  return { authEnabled: config.authEnabled, configured: Boolean(stored ?? config.sakura), sakura: stored ?? config.sakura ?? null };
}));
app.put('/api/admin/sakura', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const body = z.object({ sakura: sakuraConfigSchema }).parse(await context.req.json());
  const validation = await setup.testSakura(body.sakura);
  await settings.saveSakura(body.sakura);
  config = await settings.apply(baseConfig);
  return { saved: true, publicClient: validation.publicClient, restartRequired: !baseConfig.authEnabled,
    message: baseConfig.authEnabled ? 'Sakura 配置已保存并立即生效。' : 'Sakura 配置已保存。请将 AUTH 恢复为 true 并重启应用。' };
}));
app.get('/api/admin/local-users', async context => adminApi(context, false, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  return { users: await localLogins.list() };
}));
app.post('/api/admin/local-users', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const body = z.object({
    username: z.string().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/,
      '用户名只能包含字母、数字、点、下划线和连字符，长度为 3 到 60 个字符。'),
    password: z.string().min(8).max(200),
    displayName: z.string().min(1).max(120).optional(),
    email: z.email().optional(),
    isSystemAdmin: z.boolean().optional()
  }).parse(await context.req.json());
  const account = await localLogins.upsert(body.username, body.password, {
    displayName: body.displayName, email: body.email, isSystemAdmin: body.isSystemAdmin ?? false
  }, true);
  return { saved: true, userId: account.userId };
}));
app.put('/api/admin/local-users/:username', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const body = z.object({ password: z.string().min(8).max(200) }).parse(await context.req.json());
  await localLogins.setPassword(context.req.param('username'), body.password);
  return { saved: true };
}));
app.patch('/api/admin/local-users/:username', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  const body = z.object({ displayName: z.string().min(1).max(120).optional(),
    email: z.email().nullable().optional(), isSystemAdmin: z.boolean().optional() }).parse(await context.req.json());
  await localLogins.updateProfile(context.req.param('username'), body);
  return { saved: true };
}));
app.post('/api/admin/local-users/:username/unlock', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  await localLogins.unlock(context.req.param('username'));
  return { saved: true };
}));
app.delete('/api/admin/local-users/:username', async context => adminApi(context, true, async identity => {
  if (!identity.isSystemAdmin) throw new Error('System administrator permission is required.');
  await localLogins.remove(context.req.param('username'));
  return { saved: true };
}));
app.get('/api/admin/audit', async context => adminApi(context, false, async identity => {
  const query = z.object({ space_id: z.string().uuid().optional(), action: z.string().max(200).optional(),
    result: z.enum(['success','error']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.coerce.number().int().positive().optional() }).parse(context.req.query());
  return audit.list(identity.userId, { spaceId: query.space_id, action: query.action, result: query.result,
    limit: query.limit, cursor: query.cursor, systemAdmin: identity.isSystemAdmin });
}));

// Health probes hit a public endpoint every few seconds; cache the database
// round trips briefly so a busy checker cannot turn into a constant full scan
// of the ever-growing job table.
let healthCache: { at: number; pgvector: string; installed: boolean; pending: number; processing: number; failed: number } | undefined;
const HEALTH_CACHE_MS = 5_000;

app.get('/health', async context => {
  try {
    const now = Date.now();
    let cached = healthCache && now - healthCache.at < HEALTH_CACHE_MS ? healthCache : undefined;
    if (!cached) {
      const [vector, installation, queue] = await Promise.all([
        database.query<{ version: string }>("SELECT extversion AS version FROM pg_extension WHERE extname='vector'"),
        settings.installation(),
        database.query<{ pending: string; processing: string; failed: string }>(
          `SELECT count(*) FILTER(WHERE status='pending')::text AS pending,
           count(*) FILTER(WHERE status='processing')::text AS processing,
           count(*) FILTER(WHERE status='failed')::text AS failed FROM ingestion_jobs`)
      ]);
      cached = healthCache = { at: now, pgvector: vector.rows[0]?.version ?? 'missing', installed: installation.completed,
        pending: Number(queue.rows[0].pending), processing: Number(queue.rows[0].processing), failed: Number(queue.rows[0].failed) };
    }
    return context.json({ status: 'ok', service: 'Sakura-MCP-Memory-Server', version: APP_VERSION,
      database: 'ok', pgvector: cached.pgvector, installed: cached.installed, authEnabled: config.authEnabled,
      worker: { enabled: baseConfig.worker.enabled, pending: cached.pending,
        processing: cached.processing, failed: cached.failed } });
  } catch {
    return context.json({ status: 'degraded', service: 'Sakura-MCP-Memory-Server', version: APP_VERSION,
      database: 'unavailable', authEnabled: config.authEnabled }, 503);
  }
});
app.get('/.well-known/oauth-protected-resource', context => {
  // Sakura is a browser IdP only; its access tokens do not carry MCP scopes.
  const issuers = config.authEnabled && config.authentik ? [config.authentik.issuer] : [];
  if (!issuers.length) return context.json({ error: 'OAuth is not configured.' }, 404);
  return context.json({ resource: config.publicBaseUrl, authorization_servers: issuers });
});
app.get('/.well-known/oauth-protected-resource/mcp', context => {
  const issuers = config.authEnabled && config.authentik ? [config.authentik.issuer] : [];
  if (!issuers.length) return context.json({ error: 'OAuth is not configured.' }, 404);
  return context.json({ resource: `${config.publicBaseUrl}/mcp`, authorization_servers: issuers });
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
  const parsedBody = await readMcpBody(context);
  if (parsedBody instanceof Response) return parsedBody;
  const identity = trackOperation(() => memories.ensureUser(principal.id, {
    email: principal.email, displayName: principal.displayName, allowAdminByEmail: principal.source === 'authentik'
  }));
  // Session tracking is best-effort telemetry: never let it fail a real request.
  const tracker = await identity.then(({ userId }) => beginClientTracking(context, principal, userId, parsedBody)).catch(error => {
    logger.warn({ err: error }, 'Client session tracking failed');
    return undefined;
  });
  const server = createServer(database, principal, audit, () => config, identity);
  // Stateless transport prevents one authenticated client's session from being reused by another principal.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let failed = false;
  const requestContext = operationContext.getStore();
  let closing: Promise<void> | undefined;
  const cleanup = () => closing ??= trackOperation(async () => {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
    if (tracker) await tracker.finish({ failed }).catch(() => undefined);
  }, requestContext);
  let response: Response;
  try {
    operationSignal()?.throwIfAborted();
    await server.connect(transport);
    response = await transport.handleRequest(context.req.raw, { parsedBody });
  } catch (error) {
    failed = !operationSignal()?.aborted;
    if (failed) logger.error({ err: error, principal: principal.id }, 'MCP transport request failed');
    await cleanup();
    return context.json({ error: 'MCP request failed.' }, 500);
  }
  return streamWithDeferredCleanup(response, cleanup, operationSignal());
}

/**
 * Opens a client-session record for one MCP exchange. Returns a handle that must
 * be finished when the response stream closes, which is how an in-flight tool
 * call stops being reported as "uploading".
 */
async function beginClientTracking(context: Context, principal: Principal, userId: string, parsedBody: unknown) {
  const facts = readMcpFacts(parsedBody);
  const identity: ClientIdentity = {
    userId,
    agentId: principal.agentId,
    authSource: principal.source,
    // A client that never sends clientInfo still deserves a row; label it by transport.
    clientName: facts.clientName ?? (principal.agentId ? 'Agent (未报告名称)' : '未知客户端'),
    clientVersion: facts.clientVersion,
    protocolVersion: facts.protocolVersion,
    remoteAddress: clientAddressFor(context)
  };
  if (context.req.method === 'DELETE') {
    await clientSessions.disconnect(identity);
    return { finish: async () => undefined };
  }
  const activity = facts.isToolCall && facts.toolName ? facts.toolName : facts.method;
  const counted = facts.isToolCall;
  await clientSessions.touch(identity, {
    activity, delta: counted ? 1 : 0, isWrite: isWriteTool(facts.toolName)
  });
  return {
    finish: async (options: { failed?: boolean } = {}) => {
      if (counted) await clientSessions.release(identity, options);
      else if (options.failed) await clientSessions.touch(identity, { activity, failed: true });
    }
  };
}

/** Best-effort remote address for display, honouring the trust-proxy setting. */
function clientAddressFor(context: Context): string | undefined {
  if (config.security.trustProxy) {
    const forwarded = context.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  return context.req.header('x-real-ip')?.slice(0, 64);
}

const requests = new RequestLifecycle();
const httpServer = serve({ fetch: (request, env) => requests.handle(request, req => app.fetch(req, env)),
  hostname: baseConfig.host, port: baseConfig.port },
info => logger.info({ host: baseConfig.host, port: info.port }, 'Sakura MCP Memory Server listening'));
const shutdown = createShutdown(httpServer, requests, worker, database);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Sakura MCP Memory Server shutting down');
    void shutdown().then(clean => {
      if (!clean) logger.error('Sakura MCP Memory Server shutdown timed out or cleanup failed');
      process.exit(clean ? 0 : 1);
    }, error => {
      logger.error({ err: error }, 'Sakura MCP Memory Server shutdown failed');
      process.exit(1);
    });
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
      await audit.record({ actorUserId: identity.userId, authSource: webAuthSource(identity), action, result: 'error',
        metadata: { reason: 'csrf_failed' } });
      return context.json({ error: 'csrf_failed', error_description: 'CSRF token is missing or invalid.' }, 403);
    }
    const result = await handler(identity);
    const object = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    await audit.record({ actorUserId: identity.userId, authSource: webAuthSource(identity), action,
      spaceId: auditUuid(context.req.query('space_id')) ?? auditUuid(object.space_id) ?? auditUuid(object.spaceId),
      targetId: auditUuid(context.req.param('id')) ?? auditUuid(object.id), result: 'success' });
    return context.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    const unauthorized = /session is|session is missing/i.test(message);
    await audit.record({ actorUserId: identity?.userId, authSource: identity ? webAuthSource(identity) : undefined, action, result: 'error', metadata: { message } });
    return context.json({ error: unauthorized ? 'unauthorized' : 'request_failed', error_description: message }, unauthorized ? 401 : 400);
  }
}

function auditUuid(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
}

function webAuthSource(identity: WebIdentity): WebAuthSource { return identity.authSource; }
