import { z } from 'zod';
import type { Database } from '../database.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { SettingsRepository } from '../settings/repository.js';

export const authentikConfigSchema = z.object({
  issuer: z.url(), audience: z.string().min(1).max(500), jwksUri: z.url(), scopeClaim: z.string().min(1).max(100).default('scope'),
  clientId: z.string().min(1).max(500), authorizationUrl: z.url(), tokenUrl: z.url(), userinfoUrl: z.url().optional(),
  endSessionUrl: z.url().optional(), groupsClaim: z.string().min(1).max(100).default('groups'),
  adminGroups: z.array(z.string().min(1).max(200)).max(20).optional()
});

export const localAdminInputSchema = z.object({
  username: z.string().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/,
    '用户名只能包含字母、数字、点、下划线和连字符，长度为 3 到 60 个字符。'),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120).optional(),
  email: z.email().optional()
});
export type LocalAdminInput = z.infer<typeof localAdminInputSchema>;

export const setupInputSchema = z.object({
  administratorEmail: z.email().optional(),
  authentik: authentikConfigSchema.optional(),
  localAdmin: localAdminInputSchema.optional(),
  openaiCompatible: z.object({ baseUrl: z.url(), apiKey: z.string().max(1000).optional(), chatModel: z.string().max(200).optional(), embeddingModel: z.string().max(200).optional() }).optional(),
  ollama: z.object({ baseUrl: z.url(), chatModel: z.string().max(200).optional(), embeddingModel: z.string().max(200).optional() }).optional(),
  embedding: z.object({ baseUrl: z.url(), apiKey: z.string().max(1000).optional(), model: z.string().max(200).optional() }).optional()
});
export type SetupInput = z.infer<typeof setupInputSchema>;

export const authentikDiscoveryInputSchema = z.object({
  baseUrl: z.url(),
  applicationSlug: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    'Authentik application slug may only contain letters, numbers, underscores, and hyphens.')
});

const authentikDiscoverySchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
  end_session_endpoint: z.url().optional()
});

export class SetupService {
  constructor(private readonly authEnabled: boolean, private readonly publicBaseUrl: string,
    private readonly database: Database, private readonly settings: SettingsRepository) {}

  async diagnostics() {
    const version = await this.database.query<{ version: string }>('SELECT version()');
    const vector = await this.database.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname='vector'");
    const migrations = await this.database.query<{ name: string; applied_at: string }>('SELECT name,applied_at FROM schema_migrations ORDER BY name');
    return { database: 'ok', authEnabled: this.authEnabled, postgresVersion: version.rows[0].version,
      pgvectorVersion: vector.rows[0]?.extversion ?? null, migrations: migrations.rows };
  }

  async discoverAuthentik(input: z.infer<typeof authentikDiscoveryInputSchema>) {
    if (!this.authEnabled) throw new Error('Authentik discovery is unavailable when AUTH=false.');
    const parsed = authentikDiscoveryInputSchema.parse(input);
    const base = new URL(parsed.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('Authentik address must be an HTTPS origin without credentials, path, query, or fragment.');
    }
    const discoveryUrl = new URL(`/application/o/${encodeURIComponent(parsed.applicationSlug)}/.well-known/openid-configuration`, base);
    const response = await fetch(discoveryUrl, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Authentik discovery request failed (${response.status}).`);
    const raw = await readBoundedText(response, 1_000_000);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); }
    catch { throw new Error('Authentik discovery response is not valid JSON.'); }
    const metadata = authentikDiscoverySchema.parse(decoded);
    for (const value of [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint,
      metadata.jwks_uri, metadata.userinfo_endpoint, metadata.end_session_endpoint].filter(Boolean) as string[]) {
      const endpoint = new URL(value);
      if (endpoint.protocol !== 'https:' || endpoint.origin !== base.origin) {
        throw new Error('Authentik discovery returned an insecure or cross-origin endpoint.');
      }
    }
    return {
      discoveryUrl: discoveryUrl.toString(), issuer: metadata.issuer, jwksUri: metadata.jwks_uri,
      authorizationUrl: metadata.authorization_endpoint, tokenUrl: metadata.token_endpoint,
      userinfoUrl: metadata.userinfo_endpoint, endSessionUrl: metadata.end_session_endpoint
    };
  }

  async testAuthentik(authentik: NonNullable<SetupInput['authentik']>) {
    const issuer = authentik.issuer.replace(/\/$/, '');
    const metadataUrl = `${issuer}/.well-known/openid-configuration`;
    const [metadataResponse, jwksResponse] = await Promise.all([
      fetch(metadataUrl, { signal: AbortSignal.timeout(10_000) }),
      fetch(authentik.jwksUri, { signal: AbortSignal.timeout(10_000) })
    ]);
    if (!metadataResponse.ok) throw new Error(`Authentik metadata request failed (${metadataResponse.status}).`);
    if (!jwksResponse.ok) throw new Error(`Authentik JWKS request failed (${jwksResponse.status}).`);
    const metadata = await metadataResponse.json() as { issuer?: string; authorization_endpoint?: string; token_endpoint?: string };
    const jwks = await jwksResponse.json() as { keys?: unknown[] };
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) throw new Error('Authentik metadata is missing OAuth endpoints.');
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error('Authentik JWKS contains no signing keys.');
    if (metadata.issuer?.replace(/\/$/, '') !== issuer) throw new Error('Authentik metadata issuer does not match the configured Issuer.');
    const publicClient = await this.testPublicClient(authentik);
    return { issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint, signingKeys: jwks.keys.length, publicClient };
  }

  private async testPublicClient(authentik: NonNullable<SetupInput['authentik']>): Promise<boolean> {
    const response = await fetch(authentik.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: authentik.clientId,
        code: 'sakura-public-client-preflight-invalid-code',
        redirect_uri: `${this.publicBaseUrl}/auth/callback`,
        code_verifier: 'sakura_public_client_preflight_verifier_0123456789ABCDEFG'
      }),
      redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) throw new Error('Authentik Token Endpoint unexpectedly accepted an invalid authorization code.');
    const raw = await readBoundedText(response, 64 * 1024);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); }
    catch { throw new Error(`Authentik Public Client preflight returned HTTP ${response.status} without a valid OAuth error.`); }
    const object = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : {};
    const code = typeof object.error === 'string' ? object.error : '';
    const description = typeof object.error_description === 'string'
      ? object.error_description.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (code === 'invalid_grant') return true;
    if (code === 'invalid_client') {
      throw new Error(`Authentik Public Client 预检失败：invalid_client${description ? `：${description}` : ''}。请将 OAuth2/OIDC 提供方的客户端类型改为 Public，并确认 Client ID 正确。`);
    }
    throw new Error(`Authentik Public Client 预检失败（HTTP ${response.status}）${code ? `：${code}` : ''}${description ? `：${description}` : ''}。`);
  }

  async testProvider(input: Pick<SetupInput, 'openaiCompatible' | 'ollama' | 'embedding'>) {
    if (input.embedding) {
      if (!input.embedding.model) throw new Error('Embedding model is required to test the embedding endpoint.');
      const provider = new OpenAICompatibleProvider(input.embedding.baseUrl.replace(/\/$/, ''), input.embedding.apiKey, undefined, input.embedding.model);
      await provider.embed(['Sakura-MCP-Server installation test']);
      return { provider: 'embedding', status: 'ok', embeddingTested: true };
    }
    if (input.openaiCompatible) {
      const provider = new OpenAICompatibleProvider(input.openaiCompatible.baseUrl.replace(/\/$/, ''), input.openaiCompatible.apiKey, input.openaiCompatible.chatModel, input.openaiCompatible.embeddingModel);
      if (input.openaiCompatible.embeddingModel) await provider.embed(['Sakura-MCP-Server installation test']);
      return { provider: 'openai_compatible', status: 'ok', embeddingTested: Boolean(input.openaiCompatible.embeddingModel) };
    }
    if (input.ollama) {
      const provider = new OllamaProvider(input.ollama.baseUrl.replace(/\/$/, ''), input.ollama.chatModel, input.ollama.embeddingModel);
      if (input.ollama.embeddingModel) await provider.embed(['Sakura-MCP-Server installation test']);
      return { provider: 'ollama', status: 'ok', embeddingTested: Boolean(input.ollama.embeddingModel) };
    }
    throw new Error('A provider configuration is required.');
  }

  async complete(input: SetupInput) {
    if (this.authEnabled && !input.authentik && !input.localAdmin) {
      throw new Error('AUTH=true 时需要配置 Authentik，或创建一个本地管理员账号。');
    }
    if (this.authEnabled && input.authentik) await this.testAuthentik(input.authentik);
    await this.settings.complete(this.authEnabled ? input : {
      openaiCompatible: input.openaiCompatible, ollama: input.ollama, embedding: input.embedding
    });
  }
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('Authentik discovery response is too large.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Authentik discovery response is too large.');
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}