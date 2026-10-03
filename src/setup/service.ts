import { z } from 'zod';
import type { Database } from '../database.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible.js';
import type { SettingsRepository } from '../settings/repository.js';

const oidcUrl = z.url().refine(value => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
}, 'OIDC endpoints must use HTTP(S) without credentials or fragments.');

/**
 * One external OpenID Connect provider. Authentik and SakuraID (the
 * Sakura-Auth-Server in this ecosystem) share this configuration shape, with
 * provider-specific discovery, identity, authorization and logout behaviour.
 */
export const oidcProviderConfigSchema = z.object({
  issuer: oidcUrl, audience: z.string().min(1).max(500), jwksUri: oidcUrl, scopeClaim: z.string().min(1).max(100).default('scope'),
  clientId: z.string().min(1).max(500), authorizationUrl: oidcUrl, tokenUrl: oidcUrl, userinfoUrl: oidcUrl.optional(),
  endSessionUrl: oidcUrl.optional(), groupsClaim: z.string().min(1).max(100).default('groups'),
  adminGroups: z.array(z.string().trim().min(1).max(200)).max(20).optional()
});
export const authentikConfigSchema = oidcProviderConfigSchema;
export const sakuraConfigSchema = oidcProviderConfigSchema;
export type OidcProviderInput = z.infer<typeof oidcProviderConfigSchema>;

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
  sakura: sakuraConfigSchema.optional(),
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

export const sakuraDiscoveryInputSchema = z.object({
  baseUrl: z.url()
});

const authentikDiscoverySchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
  end_session_endpoint: z.url().optional()
});
const sakuraDiscoverySchema = authentikDiscoverySchema;

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

  /**
   * Discovers SakuraID (Sakura-Auth-Server) endpoints from its standard
   * OpenID Connect discovery document at the site root.
   *
   * Unlike Authentik there is no application slug to build the path, and the
   * service is frequently evaluated over plain HTTP on a LAN, so the same
   * origin as the configured address is what matters; an HTTPS address still
   * requires HTTPS endpoints, so a protocol downgrade cannot be injected.
   */
  async discoverSakura(input: z.infer<typeof sakuraDiscoveryInputSchema>) {
    if (!this.authEnabled) throw new Error('Sakura discovery is unavailable when AUTH=false.');
    const parsed = sakuraDiscoveryInputSchema.parse(input);
    const base = new URL(parsed.baseUrl);
    if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username || base.password
      || (base.pathname !== '/' && base.pathname !== '') || base.search || base.hash) {
      throw new Error('Sakura address must be an HTTP(S) origin without credentials, path, query, or fragment.');
    }
    const discoveryUrl = new URL('/.well-known/openid-configuration', base);
    const response = await fetch(discoveryUrl, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Sakura discovery request failed (${response.status}).`);
    const raw = await readBoundedText(response, 1_000_000);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); }
    catch { throw new Error('Sakura discovery response is not valid JSON.'); }
    const metadata = sakuraDiscoverySchema.parse(decoded);
    const endpoints = [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint,
      metadata.jwks_uri, metadata.userinfo_endpoint, metadata.end_session_endpoint].filter(Boolean) as string[];
    // The origin comparison includes the protocol, so an HTTPS address can never
    // be downgraded to an HTTP endpoint or redirected to another host.
    for (const value of endpoints) {
      const endpoint = new URL(value);
      if ((endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') || endpoint.origin !== base.origin) {
        throw new Error('Sakura discovery returned an insecure or cross-origin endpoint.');
      }
    }
    return {
      discoveryUrl: discoveryUrl.toString(), issuer: metadata.issuer, jwksUri: metadata.jwks_uri,
      authorizationUrl: metadata.authorization_endpoint, tokenUrl: metadata.token_endpoint,
      userinfoUrl: metadata.userinfo_endpoint, endSessionUrl: metadata.end_session_endpoint
    };
  }

  async testAuthentik(authentik: NonNullable<SetupInput['authentik']>) {
    return this.testOidcProvider(authentik, 'Authentik');
  }

  async testSakura(sakura: NonNullable<SetupInput['sakura']>) {
    return this.testOidcProvider(sakura, 'Sakura');
  }

  private async testOidcProvider(provider: OidcProviderInput, label: string) {
    provider = oidcProviderConfigSchema.parse(provider);
    if (label === 'Sakura') {
      const origin = new URL(provider.issuer).origin;
      for (const value of [provider.authorizationUrl, provider.tokenUrl, provider.jwksUri, provider.userinfoUrl, provider.endSessionUrl]) {
        if (value && new URL(value).origin !== origin) throw new Error('Sakura endpoints must remain on the issuer origin.');
      }
    }
    const issuer = provider.issuer.replace(/\/$/, '');
    const metadataUrl = `${issuer}/.well-known/openid-configuration`;
    const metadataResponse = await fetch(metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!metadataResponse.ok) throw new Error(`${label} metadata request failed (${metadataResponse.status}).`);
    const metadata = JSON.parse(await readBoundedText(metadataResponse, 1_000_000)) as {
      issuer?: string; authorization_endpoint?: string; token_endpoint?: string; jwks_uri?: string
    };
    if (metadata.issuer !== provider.issuer) throw new Error(`${label} metadata issuer does not match the configured Issuer.`);
    if (metadata.authorization_endpoint !== provider.authorizationUrl || metadata.token_endpoint !== provider.tokenUrl
      || (metadata.jwks_uri && metadata.jwks_uri !== provider.jwksUri)) {
      throw new Error(`${label} configured endpoints do not match discovery metadata.`);
    }
    const jwksResponse = await fetch(provider.jwksUri, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!jwksResponse.ok) throw new Error(`${label} JWKS request failed (${jwksResponse.status}).`);
    const jwks = JSON.parse(await readBoundedText(jwksResponse, 1_000_000)) as { keys?: unknown[] };
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error(`${label} JWKS contains no signing keys.`);
    const publicClient = await this.testPublicClient(provider, label);
    return { issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint, signingKeys: jwks.keys.length, publicClient };
  }

  private async testPublicClient(provider: OidcProviderInput, label: string): Promise<boolean> {
    const response = await fetch(provider.tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: provider.clientId,
        code: 'sakura-public-client-preflight-invalid-code',
        redirect_uri: `${this.publicBaseUrl}/auth/callback`,
        code_verifier: 'sakura_public_client_preflight_verifier_0123456789ABCDEFG'
      }),
      redirect: 'error', signal: AbortSignal.timeout(10_000)
    });
    if (response.ok) throw new Error(`${label} Token Endpoint unexpectedly accepted an invalid authorization code.`);
    const raw = await readBoundedText(response, 64 * 1024);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); }
    catch { throw new Error(`${label} Public Client preflight returned HTTP ${response.status} without a valid OAuth error.`); }
    const object = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : {};
    const code = typeof object.error === 'string' ? object.error : '';
    const description = typeof object.error_description === 'string'
      ? object.error_description.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (code === 'invalid_grant') return true;
    if (code === 'invalid_client') {
      throw new Error(`${label} Public Client 预检失败：invalid_client${description ? `：${description}` : ''}。请将 OAuth2/OIDC 提供方的客户端类型改为 Public，并确认 Client ID 正确。`);
    }
    throw new Error(`${label} Public Client 预检失败（HTTP ${response.status}）${code ? `：${code}` : ''}${description ? `：${description}` : ''}。`);
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
    if (this.authEnabled && !input.authentik && !input.sakura && !input.localAdmin) {
      throw new Error('AUTH=true 时需要配置 Authentik 或 Sakura 账号服务，或创建一个本地管理员账号。');
    }
    if (this.authEnabled && input.sakura && !input.localAdmin && !input.authentik && !input.sakura.adminGroups?.some(group => group.trim())) {
      throw new Error('仅使用 Sakura 安装时必须指定管理员用户组；当前 Sakura 邮箱未经验证，不能用邮箱授予管理员权限。');
    }
    if (this.authEnabled && input.authentik) await this.testAuthentik(input.authentik);
    if (this.authEnabled && input.sakura) await this.testSakura(input.sakura);
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