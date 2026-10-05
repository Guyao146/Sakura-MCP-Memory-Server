import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('memory database schema', () => {
  it('keeps application layers root-owned and whitelists only build inputs', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
    const ignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
    expect(dockerfile).not.toContain('chown -R');
    expect(dockerfile).toContain('install -d -o mcp -g mcp -m 0700 /app/data');
    expect(dockerfile).toContain('--uid 10001 --gid mcp');
    expect(ignore.split(/\r?\n/)).toContain('**');
    for (const input of ['package.json', 'package-lock.json', 'tsconfig.json', 'src/**', 'migrations/**',
      'scripts/container-entrypoint.sh', 'scripts/healthcheck.mjs']) expect(ignore.split(/\r?\n/)).toContain(`!${input}`);
    expect(ignore).not.toContain('!tools');
  });

  it('disables buffering for the exact export route in the Nginx example', async () => {
    const nginx = await readFile(new URL('../nginx-mcp.conf.example', import.meta.url), 'utf8');
    const route = nginx.match(/location = \/api\/admin\/exports\s*\{([^}]+)\}/)?.[1];
    expect(route).toContain('proxy_buffering off;');
    expect(route).toContain('proxy_read_timeout 120s;');
    expect(route).toContain('proxy_pass http://127.0.0.1:3001;');
  });

  it('defines every multi-tenant memory platform table', async () => {
    const sql = await readFile(new URL('../migrations/001_memory_platform.sql', import.meta.url), 'utf8');
    for (const table of [
      'users', 'spaces', 'space_members', 'space_invitations', 'agent_credentials', 'agent_space_grants',
      'provider_configs', 'space_provider_settings', 'memories', 'memory_embeddings', 'memory_versions',
      'memory_sources', 'memory_relations', 'memory_conflicts', 'memory_feedback', 'ingestion_jobs', 'audit_logs'
    ]) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
  });

  it('does not store invitation or Agent secrets in plaintext columns', async () => {
    const sql = await readFile(new URL('../migrations/001_memory_platform.sql', import.meta.url), 'utf8');
    expect(sql).toContain('token_hash text UNIQUE NOT NULL');
    expect(sql).toContain('secret_hash text UNIQUE NOT NULL');
    expect(sql).not.toMatch(/\b(secret|token)\s+text\b/);
  });

  it('defines locked installation state and encrypted system settings', async () => {
    const sql = await readFile(new URL('../migrations/002_installation.sql', import.meta.url), 'utf8');
    for (const table of ['system_settings', 'installation_state', 'system_admin_allowlist']) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain('encrypted boolean NOT NULL DEFAULT false');
    expect(sql).toContain('completed boolean NOT NULL DEFAULT false');
  });

  it('defines expiring OIDC attempts and hashed Web sessions', async () => {
    const sql = await readFile(new URL('../migrations/003_web_sessions.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE oidc_login_attempts');
    expect(sql).toContain('CREATE TABLE web_sessions');
    expect(sql).toContain('state_hash text PRIMARY KEY');
    expect(sql).toContain('token_hash text UNIQUE NOT NULL');
  });

  it('stores local login credentials hashed with lockout tracking', async () => {
    const sql = await readFile(new URL('../migrations/013_local_login.sql', import.meta.url), 'utf8');
    expect(sql).toContain('CREATE TABLE local_credentials');
    expect(sql).toContain('password_hash text NOT NULL');
    expect(sql).toContain('failed_attempts int NOT NULL DEFAULT 0');
    expect(sql).toContain('locked_until timestamptz NOT NULL DEFAULT now()');
    expect(sql).toContain("CHECK (auth_source IN ('authentik', 'local'))");
    expect(sql).toContain('ADD COLUMN auth_source text');
  });

  it('allows failed semantic jobs without fake vectors', async () => {
    const sql = await readFile(new URL('../migrations/004_semantic_memory.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ADD COLUMN provider_type provider_type');
    expect(sql).toContain('ALTER COLUMN embedding DROP NOT NULL');
    expect(sql).toContain("status IN ('pending', 'failed')");
  });

  it('prevents duplicate open conflicts and self relations', async () => {
    const sql = await readFile(new URL('../migrations/005_memory_governance.sql', import.meta.url), 'utf8');
    expect(sql).toContain('memory_relation_not_self');
    expect(sql).toContain('memory_conflict_not_self');
    expect(sql).toContain('one_open_conflict_per_pair');
  });

  it('exposes portable MCP memory resources without file URIs', async () => {
    const source = await readFile(new URL('../src/tools.ts', import.meta.url), 'utf8');
    expect(source).toContain("'memory://spaces'");
    expect(source).toContain("'memory://spaces/{spaceId}'");
    expect(source).toContain("'memory://memories/{memoryId}'");
    expect(source).not.toContain("'file://");
  });

  it('gives the app a signal-forwarding init and enough shutdown grace', async () => {
    const [compose, dockerfile, entrypoint] = await Promise.all([
      readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
      readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
      readFile(new URL('../scripts/container-entrypoint.sh', import.meta.url), 'utf8')
    ]);
    expect(compose).toContain('init: true');
    expect(compose).toContain('stop_signal: SIGTERM');
    expect(compose).toContain('stop_grace_period: 30s');
    expect(dockerfile).toContain('STOPSIGNAL SIGTERM');
    expect(entrypoint).toContain('exec node /app/dist/index.js');
  });

  it('keeps data mount ownership aligned with the unprivileged image user', async () => {
    const [compose, dockerfile] = await Promise.all([
      readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8'),
      readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
    ]);
    expect(dockerfile).toContain('--uid 10001 --gid mcp');
    expect(dockerfile).toContain('--gid 10001 mcp');
    expect(dockerfile).toContain('USER mcp');
    expect(compose).toContain('prepare-data:');
    expect(compose).toContain('find /data -type d -exec chown 10001:10001 {} + -exec chmod 700 {} +');
    expect(compose).toContain('find /data -type f -exec chown 10001:10001 {} + -exec chmod 600 {} +');
    expect(compose).toMatch(/prepare-data:\s+condition: service_completed_successfully/);
  });

  it('invalidates embeddings transactionally for content, summary, and tag changes', async () => {
    const sql = await readFile(new URL('../migrations/012_embedding_consistency.sql', import.meta.url), 'utf8');
    expect(sql).toContain('embedding_revision bigint NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN request_id uuid');
    expect(sql).toContain('(NEW.content,NEW.summary,NEW.tags) IS DISTINCT FROM (OLD.content,OLD.summary,OLD.tags)');
    expect(sql).toContain('BEFORE UPDATE ON memories');
    expect(sql).toContain('AFTER UPDATE ON memories');
    expect(sql).toContain('DELETE FROM memory_embeddings WHERE memory_id=NEW.id');
  });

  it('defines a recoverable PostgreSQL background queue', async () => {
    const sql = await readFile(new URL('../migrations/006_background_jobs.sql', import.meta.url), 'utf8');
    expect(sql).toContain('locked_by text');
    expect(sql).toContain('cancel_requested boolean');
    expect(sql).toContain('ingestion_jobs_queue_idx');
  });

  it('supports Compose startup without a host .env file', async () => {
    const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
    expect(compose).toContain('bootstrap-secrets:');
    expect(compose).toContain('POSTGRES_PASSWORD_FILE: /run/sakura-secrets/postgres-password');
    expect(compose).toContain('runtime-secrets:/run/sakura-secrets:ro');
    expect(compose).toMatch(/ghcr\.io\/guyao146\/sakura-mcp-server:\d+\.\d+\.\d+/);
    expect(compose).toContain('127.0.0.1:${MCP_HOST_PORT:-3001}:3000');
    expect(compose).toContain('AUTH: ${AUTH:-}');
    expect(compose).toContain('auth: ${auth:-}');
    expect(compose).not.toContain('SETUP_TOKEN');
    expect(compose).not.toContain('POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?');
    expect(compose).not.toMatch(/(?<!\$)\$(?:value|1)\b/);
  });

  it('proxies every token-free setup resource with the public host', async () => {
    const nginx = await readFile(new URL('../nginx-mcp.conf.example', import.meta.url), 'utf8');
    expect(nginx).toContain('proxy_set_header Host $host;');
    expect(nginx).not.toContain('X-Setup-Token');
    expect(nginx).toContain('location = / {');
    expect(nginx).toContain('location = /assets/setup.js');
    expect(nginx).toContain('location ^~ /api/setup/');
    expect(nginx).toContain('location ^~ /api/me/');
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(nginx).not.toContain('$proxy_add_x_forwarded_for');
    expect(nginx).toContain('proxy_pass http://127.0.0.1:3001;');
    expect(nginx).toMatch(/location = \/ \{[\s\S]*?proxy_read_timeout 120s;[\s\S]*?proxy_buffering off;/);
    expect(nginx).toContain('location = /.well-known/oauth-protected-resource {');
  });

  it('keeps management APIs unavailable until installation completes', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.use('/api/admin/*', async (context, next)");
    expect(source).toContain("error: 'setup_required'");
  });

  it('serves MCP on the root domain while retaining the legacy path', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.all('/', async context => isRootMcpRequest");
    expect(source).toContain("app.all('/mcp', handleMcp)");
    expect(source).toContain('resource: config.publicBaseUrl');
    expect(source).toContain('resource: `${config.publicBaseUrl}/mcp`');
  });

  it('exposes system-admin Authentik recovery endpoints', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.get('/api/admin/authentik'");
    expect(source).toContain("app.put('/api/admin/authentik'");
    expect(source).toContain('await setup.testAuthentik(body.authentik)');
    expect(source).toContain('await settings.saveAuthentik(body.authentik, body.administratorEmail)');
    expect(source).toContain('restartRequired: !baseConfig.authEnabled');
    expect(source).toContain("'Authentik 配置已保存。请将 AUTH 恢复为 true 并重启应用。'");
  });

  it('exposes system-admin Sakura provider endpoints', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.get('/api/admin/sakura'");
    expect(source).toContain("app.put('/api/admin/sakura'");
    expect(source).toContain('await setup.testSakura(body.sakura)');
    expect(source).toContain('await settings.saveSakura(body.sakura)');
    // The login start route accepts an explicit provider, and the modes response
    // tells the login page which providers are actually configured.
    expect(source).toContain("app.post('/api/setup/discover-sakura'");
    expect(source).toContain("app.post('/api/setup/test-sakura'");
    expect(source).toContain("browserLoginConfigured(config, requested as OidcProvider)");
    expect(source).toContain("sakura: browserLoginConfigured(config, 'sakura')");
  });

  it('supports a dedicated embedding provider endpoint', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("z.enum(['openai_compatible', 'ollama', 'embedding'])");
    expect(source).toContain("await settings.saveProvider('embedding'");
  });

  it('indexes security audit actions and request correlation', async () => {
    const sql = await readFile(new URL('../migrations/007_audit_security.sql', import.meta.url), 'utf8');
    expect(sql).toContain('auth_source text');
    expect(sql).toContain('request_id uuid');
    expect(sql).toContain('audit_logs_action_created_idx');
  });

  it('separates silent login probes from real login attempts in the schema', async () => {
    const sql = await readFile(new URL('../migrations/009_login_probe.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ALTER TABLE oidc_login_attempts');
    expect(sql).toContain("purpose text NOT NULL DEFAULT 'login'");
    expect(sql).toContain("CHECK (purpose IN ('login', 'probe'))");
  });

  it('claims OIDC transactions by purpose so a probe cannot become a session', async () => {
    const source = await readFile(new URL('../src/web/session.ts', import.meta.url), 'utf8');
    // The purpose belongs in the WHERE clause: a code minted for a probe must be
    // unredeemable by the login path even if later refactors drop a branch.
    expect(source).toContain('WHERE state_hash=$1 AND ($2::text IS NULL OR purpose=$2) AND expires_at>now()');
    expect(source).toContain('AND browser_binding_hash=$3');
    expect(source).toContain("consumeAttempt(state, 'login', cookieHeader)");
    expect(source).toContain("consumeAttempt(state, 'probe', cookieHeader)");
    // The transaction also records which provider started it, so the callback
    // exchanges the code against that provider's token endpoint.
    expect(source).toContain('RETURNING code_verifier,nonce,return_to,purpose,provider');
    // The probe must ask the provider to stay silent rather than render its login
    // form. Only a provider that answers `prompt=none` with a standard error is
    // ever probed, so the parameter is gated on that capability.
    expect(source).toContain("if (purpose === 'probe' && SILENT_PROBE_PROVIDERS.includes(provider)) url.searchParams.set('prompt', 'none')");
  });

  it('records the provider of each login transaction and session', async () => {
    const sql = await readFile(new URL('../migrations/014_sakura_oidc_provider.sql', import.meta.url), 'utf8');
    expect(sql).toContain("ADD COLUMN provider text NOT NULL DEFAULT 'authentik'");
    expect(sql).toContain("CHECK (provider IN ('authentik', 'sakura'))");
    expect(sql).toContain("CHECK (auth_source IN ('authentik', 'local', 'sakura'))");
    expect(sql).toContain('web_sessions_auth_source_check');
  });

  it('probes at most once per visit and never redirects in a loop', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(source).toContain("context.req.query('probed') !== '1'");
    expect(source).toContain("webSessions.begin(returnTo, 'probe', primary)");
    expect(source).toContain('WebSessionService.isProbeMiss(failure)');
    // Only a provider that answers a silent probe is ever probed: SakuraID would
    // render its own login page instead of answering, trapping the visitor.
    expect(source).toContain('SILENT_PROBE_PROVIDERS.includes(primary)');
    // A failed probe still lands on the login page instead of surfacing an error.
    expect(source).toContain("'/auth/login?probed=1&reason=probe_failed'");
  });
});