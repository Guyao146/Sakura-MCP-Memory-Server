import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig, Scope } from './config.js';
import type { Database } from './database.js';

export interface Principal {
  id: string;
  source: 'api_key' | 'authentik' | 'local';
  scopes: Scope[];
  expiresAt: number;
  email?: string;
  displayName?: string;
  agentId?: string;
}

const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AuthService {
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private readonly config: AppConfig, private readonly database?: Database) {
    if (config.authentik) this.jwks = createRemoteJWKSet(new URL(config.authentik.jwksUri));
  }

  async authenticate(header: string | undefined): Promise<Principal> {
    if (!this.config.authEnabled) return {
      id: 'local-admin', source: 'local', scopes: [
        'memory:read', 'memory:write', 'memory:update', 'memory:delete', 'memory:export',
        'space:create', 'space:manage', 'member:manage', 'agent:manage', 'admin:system'
      ], expiresAt: Math.floor(Date.now() / 1000) + 300, displayName: 'Local Administrator'
    };
    if (!header?.startsWith('Bearer ')) throw new Error('Missing Bearer credential.');
    const credential = header.slice(7).trim();
    const apiKey = this.config.apiKeys.find(key => equal(key.secret, credential));
    if (apiKey) return { id: apiKey.id, source: 'api_key', scopes: apiKey.scopes, expiresAt: Math.floor(Date.now() / 1000) + 300 };
    if (this.database && credential.startsWith('sk_sakura_')) {
      const secretHash = createHash('sha256').update(credential).digest('hex');
      const result = await this.database.query<{
        agent_id: string; oidc_subject: string; email: string | null; display_name: string; scopes: Scope[]; expires_at: string | null;
      }>(
        `SELECT ac.id AS agent_id,u.oidc_subject,u.email,u.display_name,ac.scopes,ac.expires_at
         FROM agent_credentials ac JOIN users u ON u.id=ac.owner_id
         WHERE ac.secret_hash=$1 AND ac.revoked_at IS NULL AND (ac.expires_at IS NULL OR ac.expires_at>now())`, [secretHash]);
      const agent = result.rows[0];
      if (agent) {
        await this.database.query(`UPDATE agent_credentials SET last_used_at=now() WHERE id=$1
          AND (last_used_at IS NULL OR last_used_at < now()-interval '5 minutes')`, [agent.agent_id]);
        return {
          id: agent.oidc_subject, source: 'api_key', scopes: agent.scopes, agentId: agent.agent_id,
          expiresAt: agent.expires_at ? Math.floor(new Date(agent.expires_at).getTime() / 1000) : Math.floor(Date.now() / 1000) + 300,
          email: agent.email ?? undefined, displayName: agent.display_name
        };
      }
    }
    if (!this.config.authentik || !this.jwks) throw new Error('Invalid credential.');
    const { payload } = await jwtVerify(credential, this.jwks, { issuer: this.config.authentik.issuer, audience: this.config.authentik.audience });
    const subject = payload.sub;
    if (!subject || !payload.exp) throw new Error('Authentik token is missing sub or exp.');
    const rawScopes = payload[this.config.authentik.scopeClaim];
    const scopes = Array.isArray(rawScopes) ? rawScopes : typeof rawScopes === 'string' ? rawScopes.split(' ') : [];
    return {
      id: subject,
      source: 'authentik',
      scopes: scopes as Scope[],
      expiresAt: payload.exp,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      displayName: typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined
    };
  }
}

export function requireScopes(principal: Principal, scopes: Scope[]): void {
  const missing = scopes.filter(scope => !principal.scopes.includes(scope));
  if (missing.length) throw new Error(`Missing required scope: ${missing.join(', ')}.`);
}
