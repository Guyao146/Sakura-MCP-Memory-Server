import 'dotenv/config';
import { z } from 'zod';

const optionalUrl = z.string().url().optional().or(z.literal(''));

const environmentSchema = z.object({
  PUBLIC_BASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AUTH: z.enum(['true', 'false']).optional().or(z.literal('')),
  auth: z.enum(['true', 'false']).optional().or(z.literal('')),
  MCP_API_KEYS: z.string().default(''),
  AUTHENTIK_ISSUER: optionalUrl,
  AUTHENTIK_AUDIENCE: z.string().optional().or(z.literal('')),
  AUTHENTIK_JWKS_URI: optionalUrl,
  AUTHENTIK_SCOPE_CLAIM: z.string().default('scope'),
  AUTHENTIK_CLIENT_ID: z.string().optional(),
  AUTHENTIK_AUTHORIZATION_URL: optionalUrl,
  AUTHENTIK_TOKEN_URL: optionalUrl,
  SAKURA_CLIENT_ID: z.string().optional(),
  SAKURA_AUTHORIZATION_URL: optionalUrl,
  SAKURA_TOKEN_URL: optionalUrl,
  SAKURA_END_SESSION_URL: optionalUrl,
  SAKURA_ISSUER: optionalUrl,
  SAKURA_AUDIENCE: z.string().optional().or(z.literal('')),
  SAKURA_JWKS_URI: optionalUrl,
  SAKURA_SCOPE_CLAIM: z.string().default('groups'),
  LOCAL_LOGIN: z.enum(['true', 'false']).optional().or(z.literal('')),
  LOCAL_ADMIN_USERNAME: z.string().optional().or(z.literal('')),
  LOCAL_ADMIN_PASSWORD: z.string().optional().or(z.literal('')),
  DATABASE_URL: z.string().min(1),
  POSTGRES_HOST: z.string().default('postgres'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(20),
  AUTO_MIGRATE: z.enum(['true', 'false']).default('true'),
  CONFIG_ENCRYPTION_KEY: z.string().min(43),
  OPENAI_COMPATIBLE_BASE_URL: optionalUrl,
  OPENAI_COMPATIBLE_API_KEY: z.string().optional().or(z.literal('')),
  OPENAI_COMPATIBLE_CHAT_MODEL: z.string().optional().or(z.literal('')),
  OPENAI_COMPATIBLE_EMBEDDING_MODEL: z.string().optional().or(z.literal('')),
  OLLAMA_BASE_URL: optionalUrl,
  OLLAMA_CHAT_MODEL: z.string().optional().or(z.literal('')),
  OLLAMA_EMBEDDING_MODEL: z.string().optional().or(z.literal('')),
  EMBEDDING_BASE_URL: optionalUrl,
  EMBEDDING_API_KEY: z.string().optional().or(z.literal('')),
  EMBEDDING_MODEL: z.string().optional().or(z.literal('')),
  WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60000).default(2000),
  WORKER_STALE_AFTER_SECONDS: z.coerce.number().int().min(30).max(86400).default(900),
  MAX_REQUEST_BODY_BYTES: z.coerce.number().int().min(1024).max(64 * 1024 * 1024).default(6 * 1024 * 1024),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  RATE_LIMIT_MCP_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(120),
  RATE_LIMIT_WEB_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(300),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  RATE_LIMIT_SETUP_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  AUDIT_LOG_PATH: z.string().default('./data/audit.jsonl')
});

export type Scope =
  | 'memory:read' | 'memory:write' | 'memory:update' | 'memory:delete' | 'memory:export'
  | 'space:create' | 'space:manage' | 'member:manage' | 'agent:manage' | 'admin:system';

export interface ApiKeyRecord { id: string; secret: string; scopes: Scope[]; }

/**
 * A single external OpenID Connect provider used for browser login.
 *
 * `authentik` and `sakura` share this configuration shape, but have distinct
 * identity namespaces, administrator rules, discovery and logout behaviour.
 * `clientId`, `authorizationUrl` and `tokenUrl` are required for browser login
 * and can be supplied through environment variables or the setup/admin UI.
 * Authentik's issuer/audience/JWKS triple alone enables MCP Bearer validation;
 * Sakura is browser-login only.
 */
export interface OidcProviderConfig {
  issuer: string; audience: string; jwksUri: string; scopeClaim: string;
  clientId?: string; authorizationUrl?: string; tokenUrl?: string; userinfoUrl?: string; endSessionUrl?: string;
  groupsClaim?: string; adminGroups?: string[];
}

/** Named OIDC providers recognized by the login flows, in preference order. */
export const OIDC_PROVIDERS = ['sakura', 'authentik'] as const;
export type OidcProvider = typeof OIDC_PROVIDERS[number];

export interface AppConfig {
  publicBaseUrl: string; host: string; port: number; logLevel: string; authEnabled: boolean; apiKeys: ApiKeyRecord[];
  authentik?: OidcProviderConfig;
  sakura?: OidcProviderConfig;
  localLogin: { enabled: boolean; explicit?: boolean; adminUsername?: string; adminPassword?: string };
  database: { connectionString: string; host: string; maxConnections: number; autoMigrate: boolean };
  setup: { encryptionKey: string };
  openaiCompatible?: { baseUrl: string; apiKey?: string; chatModel?: string; embeddingModel?: string };
  ollama?: { baseUrl: string; chatModel?: string; embeddingModel?: string };
  embedding?: { baseUrl: string; apiKey?: string; model?: string };
  worker: { enabled: boolean; pollIntervalMs: number; staleAfterSeconds: number };
  security: { maxBodyBytes: number; trustProxy: boolean; mcpPerMinute: number; webPerMinute: number; authPerMinute: number; setupPerMinute: number };
  auditLogPath: string;
}

const split = (value: string): string[] => value.split(',').map(item => item.trim()).filter(Boolean);

function parseApiKeys(value: string): ApiKeyRecord[] {
  return split(value).map(entry => {
    const first = entry.indexOf(':');
    const second = entry.indexOf(':', first + 1);
    const id = first > 0 ? entry.slice(0, first) : '';
    const secret = second > first ? entry.slice(first + 1, second) : '';
    const scopesValue = second > first ? entry.slice(second + 1) : '';
    if (!id || !secret || !scopesValue) throw new Error('MCP_API_KEYS entries must use id:secret:scope|scope format.');
    return { id, secret, scopes: scopesValue.split('|').filter(Boolean) as Scope[] };
  });
}

export function loadConfig(env = process.env): AppConfig {
  const value = environmentSchema.parse(env);
  const authEnabled = value.AUTH !== 'false' && value.auth !== 'false';
  const authentikValues = [value.AUTHENTIK_ISSUER, value.AUTHENTIK_AUDIENCE, value.AUTHENTIK_JWKS_URI];
  const sakuraValues = [value.SAKURA_ISSUER, value.SAKURA_AUDIENCE, value.SAKURA_JWKS_URI];
  const incomplete = (triple: Array<string | undefined>) => triple.some(Boolean) && !triple.every(Boolean);
  if (authEnabled) {
    if (incomplete(authentikValues)) throw new Error('AUTHENTIK_ISSUER, AUTHENTIK_AUDIENCE and AUTHENTIK_JWKS_URI must be configured together.');
    if (incomplete(sakuraValues)) throw new Error('SAKURA_ISSUER, SAKURA_AUDIENCE and SAKURA_JWKS_URI must be configured together.');
  }
  const authentikConfigured = Boolean(value.AUTHENTIK_ISSUER && value.AUTHENTIK_AUDIENCE && value.AUTHENTIK_JWKS_URI);
  const sakuraConfigured = Boolean(value.SAKURA_ISSUER && value.SAKURA_AUDIENCE && value.SAKURA_JWKS_URI);
  // Local accounts are the default way to log in without an external OIDC
  // provider; an explicit LOCAL_LOGIN chooses the opposite for mixed setups.
  const localExplicit = value.LOCAL_LOGIN === 'true' ? true : value.LOCAL_LOGIN === 'false' ? false : undefined;
  const adminUsername = value.LOCAL_ADMIN_USERNAME || undefined;
  const adminPassword = value.LOCAL_ADMIN_PASSWORD || undefined;
  return {
    publicBaseUrl: value.PUBLIC_BASE_URL.replace(/\/$/, ''), host: value.HOST, port: value.PORT, logLevel: value.LOG_LEVEL,
    authEnabled,
    apiKeys: parseApiKeys(value.MCP_API_KEYS),
    authentik: authEnabled && authentikConfigured ? { issuer: value.AUTHENTIK_ISSUER!, audience: value.AUTHENTIK_AUDIENCE!, jwksUri: value.AUTHENTIK_JWKS_URI!, scopeClaim: value.AUTHENTIK_SCOPE_CLAIM,
      clientId: value.AUTHENTIK_CLIENT_ID || undefined, authorizationUrl: value.AUTHENTIK_AUTHORIZATION_URL || undefined,
      tokenUrl: value.AUTHENTIK_TOKEN_URL || undefined } : undefined,
    sakura: authEnabled && sakuraConfigured ? { issuer: value.SAKURA_ISSUER!, audience: value.SAKURA_AUDIENCE!, jwksUri: value.SAKURA_JWKS_URI!, scopeClaim: value.SAKURA_SCOPE_CLAIM,
      clientId: value.SAKURA_CLIENT_ID || undefined, authorizationUrl: value.SAKURA_AUTHORIZATION_URL || undefined,
      tokenUrl: value.SAKURA_TOKEN_URL || undefined, endSessionUrl: value.SAKURA_END_SESSION_URL || undefined } : undefined,
    localLogin: {
      enabled: authEnabled && (localExplicit ?? (!(authentikConfigured || sakuraConfigured) || Boolean(adminUsername))),
      ...(localExplicit === undefined ? {} : { explicit: localExplicit }),
      adminUsername, adminPassword
    },
    database: { connectionString: value.DATABASE_URL, host: value.POSTGRES_HOST, maxConnections: value.DATABASE_MAX_CONNECTIONS, autoMigrate: value.AUTO_MIGRATE === 'true' },
    setup: { encryptionKey: value.CONFIG_ENCRYPTION_KEY },
    openaiCompatible: value.OPENAI_COMPATIBLE_BASE_URL ? { baseUrl: value.OPENAI_COMPATIBLE_BASE_URL.replace(/\/$/, ''), apiKey: value.OPENAI_COMPATIBLE_API_KEY || undefined, chatModel: value.OPENAI_COMPATIBLE_CHAT_MODEL || undefined, embeddingModel: value.OPENAI_COMPATIBLE_EMBEDDING_MODEL || undefined } : undefined,
    ollama: value.OLLAMA_BASE_URL ? { baseUrl: value.OLLAMA_BASE_URL.replace(/\/$/, ''), chatModel: value.OLLAMA_CHAT_MODEL || undefined, embeddingModel: value.OLLAMA_EMBEDDING_MODEL || undefined } : undefined,
    embedding: value.EMBEDDING_BASE_URL ? { baseUrl: value.EMBEDDING_BASE_URL.replace(/\/$/, ''), apiKey: value.EMBEDDING_API_KEY || undefined, model: value.EMBEDDING_MODEL || undefined } : undefined,
    worker: { enabled: value.WORKER_ENABLED === 'true', pollIntervalMs: value.WORKER_POLL_INTERVAL_MS, staleAfterSeconds: value.WORKER_STALE_AFTER_SECONDS },
    security: { maxBodyBytes: value.MAX_REQUEST_BODY_BYTES, trustProxy: value.TRUST_PROXY === 'true', mcpPerMinute: value.RATE_LIMIT_MCP_PER_MINUTE,
      webPerMinute: value.RATE_LIMIT_WEB_PER_MINUTE, authPerMinute: value.RATE_LIMIT_AUTH_PER_MINUTE,
      setupPerMinute: value.RATE_LIMIT_SETUP_PER_MINUTE },
    auditLogPath: value.AUDIT_LOG_PATH
  };
}