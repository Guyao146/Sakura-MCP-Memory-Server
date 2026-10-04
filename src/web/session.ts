import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OIDC_PROVIDERS, type AppConfig, type OidcProvider, type OidcProviderConfig } from '../config.js';
import type { Database } from '../database.js';
import { oidcSubject, verifiedOidcEmail } from '../security/oidc.js';
import { MemoryRepository } from '../memory/repository.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const base64url = (value: Buffer) => value.toString('base64url');

/** How a web session was created. Recorded per session so logout and audit entries reflect the real method. */
export type WebAuthSource = 'authentik' | 'local' | 'sakura';

/** The OIDC provider a login transaction targets, which is also its session source. */
export type LoginProvider = OidcProvider;

/** Display name and per-provider behaviour for each supported OIDC provider. */
export const PROVIDER_LABELS: Record<OidcProvider, string> = {
  authentik: 'Authentik',
  sakura: 'Sakura'
};

/**
 * Scopes requested per provider.
 *
 * SakuraID exposes group membership through the standard `groups` scope, so it
 * must be requested for the `groups` claim to appear in the ID Token. Authentik
 * emits `groups` through its own scope mapping whenever the administrator wants
 * the MCP server to see it.
 */
const REQUESTED_SCOPES: Record<OidcProvider, string> = {
  authentik: 'openid profile email',
  sakura: 'openid profile email groups'
};

/**
 * Providers able to answer a silent `prompt=none` probe.
 *
 * SakuraID's authorize endpoint redirects to its own login page when no session
 * exists instead of answering with `login_required`, so probing it would never
 * return usefully and could trap the visitor on the provider's login form.
 */
export const SILENT_PROBE_PROVIDERS: readonly OidcProvider[] = ['authentik'];

/** The first provider that is fully configured, or undefined when none is. */
export function primaryOidcProvider(config: AppConfig): OidcProvider | undefined {
  return OIDC_PROVIDERS.find(provider => browserLoginConfigured(config, provider));
}

export function browserLoginConfigured(config: AppConfig, provider: OidcProvider): boolean {
  const auth = providerConfig(config, provider);
  return config.authEnabled && Boolean(auth?.issuer && auth.jwksUri && auth.clientId && auth.authorizationUrl && auth.tokenUrl);
}

export function providerConfig(config: AppConfig, provider: OidcProvider): OidcProviderConfig | undefined {
  if (provider !== 'authentik' && provider !== 'sakura') return undefined;
  return config[provider];
}


export interface WebIdentity {
  sessionId: string; userId: string; subject: string; email: string | null; displayName: string;
  avatarUrl: string | null; isSystemAdmin: boolean; expiresAt: string; authSource: WebAuthSource;
}

/**
 * Why an OIDC transaction was started.
 *
 * - `login` exchanges the authorization code for a web session.
 * - `probe` is a silent `prompt=none` request used only to discover whether an
 *   Authentik SSO session already exists, so the login page can offer
 *   "continue as <name>". A probe still receives a usable authorization code, so
 *   the purpose is stored with the transaction and re-checked on redemption:
 *   {@link callback} refuses probe transactions and {@link probeCallback}
 *   refuses login transactions. A probe therefore cannot be turned into a
 *   session, which keeps signing out from silently signing the user back in.
 */
export type LoginPurpose = 'login' | 'probe';

interface LoginAttempt { code_verifier: string; nonce: string; return_to: string; purpose: LoginPurpose; provider: OidcProvider; }

/** Verified identity claims from a probe. Deliberately carries no session token. */
export interface ProbedIdentity { displayName: string; returnTo: string; }

/** Authentik reports "no SSO session" with this standard OIDC error code. */
const PROBE_NO_SESSION_ERRORS = new Set([
  'login_required', 'interaction_required', 'consent_required', 'account_selection_required'
]);

const PROBE_HINT_COOKIE = 'sakura_login_hint';
/** Long enough to survive the redirect back to the login page, short enough to not linger. */
const PROBE_HINT_MAX_AGE = 120;


export function safeReturnPath(value: string, baseUrl: string, fallback = '/admin'): string {
  if (!value.startsWith('/') || /[\\\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    const target = new URL(value, baseUrl);
    if (target.origin !== new URL(baseUrl).origin) return fallback;
    const path = target.pathname + target.search + target.hash;
    return path.startsWith('//') ? fallback : path;
  } catch { return fallback; }
}


export class WebSessionService {
  private localIdentityPromise?: Promise<WebIdentity>;
  constructor(private readonly database: Database, private readonly getConfig: () => AppConfig) {}

  async localIdentity(): Promise<WebIdentity> {
    if (this.getConfig().authEnabled) throw new Error('Local identity is only available when AUTH=false.');
    if (!this.localIdentityPromise) this.localIdentityPromise = this.createLocalIdentity().catch(error => {
      this.localIdentityPromise = undefined;
      throw error;
    });
    return this.localIdentityPromise;
  }

  async begin(returnTo = '/admin', purpose: LoginPurpose = 'login', provider: OidcProvider = 'authentik') {
    const auth = this.requireProviderConfig(provider);
    if (purpose === 'probe' && !SILENT_PROBE_PROVIDERS.includes(provider)) {
      throw new Error('This provider does not support silent login probes.');
    }
    const safeReturnTo = safeReturnPath(returnTo, this.getConfig().publicBaseUrl);
    const binding = base64url(randomBytes(32));
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(48));
    const nonce = base64url(randomBytes(24));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    await this.database.query(
      `INSERT INTO oidc_login_attempts(state_hash,code_verifier,nonce,return_to,purpose,browser_binding_hash,provider,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
      [hash(state), verifier, nonce, safeReturnTo, purpose, hash(binding), provider]);
    await this.database.query('DELETE FROM oidc_login_attempts WHERE expires_at<=now()');
    const url = new URL(auth.authorizationUrl!);
    url.searchParams.set('client_id', auth.clientId!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', `${this.getConfig().publicBaseUrl}/auth/callback`);
    url.searchParams.set('scope', REQUESTED_SCOPES[provider]);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // A probe must never show UI: Authentik answers with `login_required` instead
    // of rendering its own login form when no SSO session exists. Providers that
    // would render their own login page (SakuraID) are never probed, so `prompt`
    // only reaches a provider that answers it with an error.
    if (purpose === 'probe' && SILENT_PROBE_PROVIDERS.includes(provider)) url.searchParams.set('prompt', 'none');
    return { url: url.toString(), cookie: this.loginCookie(state, binding, 600) };
  }

  private loginCookie(state: string, value: string, maxAge: number): string {
    return `sakura_oidc_${hash(state)}=${value}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureFlag()}`;
  }

  clearLoginCookie(state: string): string { return this.loginCookie(state, '', 0); }

  async failedCallback(state: string, cookieHeader?: string): Promise<LoginPurpose> {
    return (await this.consumeAttempt(state, undefined, cookieHeader)).purpose;
  }

  /**
   * Runs the silent probe and returns the display name when Authentik reports an
   * existing SSO session. Returns undefined when there is no session, so the
   * caller falls back to the ordinary login flow.
   *
   * The verified ID Token is discarded: no user row is touched and no session is
   * created. The result is only used to render the login page.
   */
  async probeCallback(code: string, state: string, cookieHeader?: string): Promise<ProbedIdentity> {
    const attempt = await this.consumeAttempt(state, 'probe', cookieHeader);
    const payload = await this.verifyIdToken(code, attempt);
    const displayName = typeof payload.name === 'string' ? payload.name
      : typeof payload.preferred_username === 'string' ? payload.preferred_username
        : typeof payload.email === 'string' ? payload.email : String(payload.sub ?? '');
    if (!displayName) throw new Error('OIDC ID Token carried no usable display name.');
    return { displayName, returnTo: attempt.return_to };
  }

  /** True when Authentik's probe response means "no SSO session", not a real failure. */
  static isProbeMiss(error: string | undefined): boolean {
    return !!error && PROBE_NO_SESSION_ERRORS.has(error);
  }

  /**
   * Short-lived signed cookie carrying the probed display name to the login page.
   *
   * Signed with `CONFIG_ENCRYPTION_KEY` so the browser cannot forge a name, and
   * readable by the page script, which is why it is not HttpOnly. It contains no
   * token and grants no access: the visitor still has to complete a real login.
   */
  probeHintCookie(displayName: string): string {
    const value = Buffer.from(displayName.slice(0, 120), 'utf8').toString('base64url');
    const payload = `${value}.${this.signProbeHint(value)}`;
    return `${PROBE_HINT_COOKIE}=${payload}; Path=/auth; SameSite=Lax; Max-Age=${PROBE_HINT_MAX_AGE}${this.secureFlag()}`;
  }

  clearProbeHintCookie(): string {
    return `${PROBE_HINT_COOKIE}=; Path=/auth; SameSite=Lax; Max-Age=0${this.secureFlag()}`;
  }

  private signProbeHint(value: string): string {
    return createHmac('sha256', this.getConfig().setup.encryptionKey).update(`probe:${value}`).digest('base64url');
  }


  async callback(code: string, state: string, cookieHeader?: string): Promise<{ token: string; returnTo: string; authSource: WebAuthSource }> {
    const attempt = await this.consumeAttempt(state, 'login', cookieHeader);
    const payload = await this.verifyIdToken(code, attempt);
    const auth = this.requireProviderConfig(attempt.provider);
    if (!payload.sub) throw new Error('OIDC ID Token is missing subject.');
    // Only verified OIDC email may participate in allowlist authorization.
    const email = verifiedOidcEmail(payload);
    const displayName = typeof payload.name === 'string' ? payload.name : typeof payload.preferred_username === 'string' ? payload.preferred_username : payload.sub;
    const identity = await new MemoryRepository(this.database).ensureUser(oidcSubject(attempt.provider, auth.issuer, payload.sub), {
      email, displayName, allowAdminByEmail: email !== undefined,
      adminByGroup: adminByGroup(payload, auth, attempt.provider === 'sakura' ? [] : DEFAULT_ADMIN_GROUPS)
    });
    return this.issueSession(identity.userId, attempt.return_to, attempt.provider);
  }

  /**
   * Mints a web session for a user that has already authenticated by any
   * method. Both the OIDC callback and the local (username/password) login
   * funnel through here so session cookies, expiry and return-target handling
   * stay identical.
   */
  async issueSession(userId: string, returnTo: string, authSource: WebAuthSource, credentialVersion?: string): Promise<{ token: string; returnTo: string; authSource: WebAuthSource }> {
    const token = `sess_${base64url(randomBytes(32))}`;
    if (authSource === 'local') {
      if (!credentialVersion) throw new Error('Local credential version is required.');
      const result = await this.database.query(
        `INSERT INTO web_sessions(user_id,token_hash,auth_source,expires_at,local_credential_version)
         SELECT user_id,$2,$3,now()+interval '12 hours',credential_version FROM local_credentials
         WHERE user_id=$1 AND credential_version=$4 AND locked_until<=now() RETURNING id`,
        [userId, hash(token), authSource, credentialVersion]);
      if (!result.rows.length) throw new Error('Local credentials changed; sign in again.');
    } else {
      await this.database.query(
        `INSERT INTO web_sessions(user_id,token_hash,auth_source,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')`,
        [userId, hash(token), authSource]);
    }
    return { token, returnTo: safeReturnPath(returnTo, this.getConfig().publicBaseUrl), authSource };
  }

  /**
   * Atomically claims a pending OIDC transaction.
   *
   * The purpose is part of the WHERE clause rather than checked afterwards, so a
   * probe transaction can never be redeemed by the login path and vice versa. The
   * row is deleted on read, making every authorization code single-use.
   */
  private async consumeAttempt(state: string, purpose?: LoginPurpose, cookieHeader?: string): Promise<LoginAttempt> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('OIDC login state is invalid or expired.');
    const prefix = `sakura_oidc_${hash(state)}=`;
    const binding = cookieHeader?.split(';').map(item => item.trim()).find(item => item.startsWith(prefix))?.slice(prefix.length);
    if (!binding || !/^[A-Za-z0-9_-]{43}$/.test(binding)) throw new Error('OIDC browser binding is missing or invalid.');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<LoginAttempt>(
        `DELETE FROM oidc_login_attempts WHERE state_hash=$1 AND ($2::text IS NULL OR purpose=$2) AND expires_at>now()
         AND browser_binding_hash=$3
         RETURNING code_verifier,nonce,return_to,purpose,provider`, [hash(state), purpose ?? null, hash(binding)]);
      const attempt = result.rows[0];
      if (!attempt) throw new Error('OIDC login state is invalid or expired.');
      await client.query('COMMIT');
      return attempt;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  /** Exchanges the authorization code and returns the verified ID Token claims. */
  private async verifyIdToken(code: string, attempt: LoginAttempt): Promise<JWTPayload> {
    const auth = this.requireProviderConfig(attempt.provider);
    const label = PROVIDER_LABELS[attempt.provider];
    const tokenResponse = await fetch(auth.tokenUrl!, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: auth.clientId!, code,
        redirect_uri: `${this.getConfig().publicBaseUrl}/auth/callback`, code_verifier: attempt.code_verifier }),
      redirect: 'error', signal: AbortSignal.timeout(15_000)
    });
    if (!tokenResponse.ok) throw new Error(await describeTokenExchangeFailure(tokenResponse, label));
    const tokens = JSON.parse(await readBoundedResponse(tokenResponse, 1_000_000)) as { id_token?: string };
    if (!tokens.id_token) throw new Error(`${label} token response did not include id_token.`);
    const jwks = createRemoteJWKSet(new URL(auth.jwksUri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: auth.issuer, audience: auth.clientId, maxTokenAge: '10m', requiredClaims: ['sub', 'exp', 'iat'], algorithms: attempt.provider === 'sakura' ? ['RS256'] : undefined });
    if (payload.nonce !== attempt.nonce) throw new Error('OIDC nonce validation failed.');
    if ((payload.azp !== undefined && payload.azp !== auth.clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== auth.clientId)) {
      throw new Error('OIDC authorized party validation failed.');
    }
    return payload;
  }


  async authenticate(token: string | undefined): Promise<WebIdentity> {
    if (!token?.startsWith('sess_')) throw new Error('Web session is missing.');
    const result = await this.database.query<{
      session_id: string; user_id: string; oidc_subject: string; email: string | null; display_name: string;
      avatar_url: string | null; is_system_admin: boolean; expires_at: string; auth_source: WebAuthSource;
    }>(
      `SELECT ws.id AS session_id,u.id AS user_id,u.oidc_subject,u.email,u.display_name,u.avatar_url,u.is_system_admin,ws.expires_at,ws.auth_source
       FROM web_sessions ws JOIN users u ON u.id=ws.user_id
       WHERE ws.token_hash=$1 AND ws.revoked_at IS NULL AND ws.expires_at>now()
       AND (ws.auth_source<>'local' OR EXISTS (SELECT 1 FROM local_credentials lc
         WHERE lc.user_id=ws.user_id AND lc.credential_version=ws.local_credential_version))`, [hash(token)]);
    const row = result.rows[0];
    if (!row) throw new Error('Web session is invalid, expired, or revoked.');
    await this.database.query('UPDATE web_sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
    return { sessionId: row.session_id, userId: row.user_id, subject: row.oidc_subject, email: row.email,
      displayName: row.display_name, avatarUrl: row.avatar_url, isSystemAdmin: row.is_system_admin,
      expiresAt: row.expires_at, authSource: row.auth_source ?? 'authentik' };
  }

  /** Never expose token hashes or another user's sessions. */
  async listSessions(identity: WebIdentity) {
    const result = await this.database.query<{ id: string; auth_source: WebAuthSource; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      `SELECT ws.id,ws.auth_source,ws.created_at,ws.last_seen_at,ws.expires_at FROM web_sessions ws
       WHERE ws.user_id=$1 AND ws.revoked_at IS NULL AND ws.expires_at>now()
       AND (ws.auth_source<>'local' OR EXISTS (SELECT 1 FROM local_credentials lc
         WHERE lc.user_id=ws.user_id AND lc.credential_version=ws.local_credential_version))
       ORDER BY ws.created_at DESC,ws.id LIMIT 200`, [identity.userId]);
    return result.rows.map(row => ({ id: row.id, authSource: row.auth_source, createdAt: row.created_at,
      lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.id === identity.sessionId }));
  }

  async revokeSession(identity: WebIdentity, sessionId: string): Promise<void> {
    await this.database.query('UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL',
      [identity.userId, sessionId]);
  }

  async revokeOtherSessions(identity: WebIdentity): Promise<void> {
    await this.database.query('UPDATE web_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL',
      [identity.userId, identity.sessionId]);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.database.query('UPDATE web_sessions SET revoked_at=now() WHERE token_hash=$1', [hash(token)]);
  }

  /**
   * Returns the logout destination for the method that created the session.
   * Authentik supports RP-Initiated Logout and the legacy `<issuer>/end-session/`
   * fallback. Sakura's configured `/logout` only displays a confirmation page;
   * it does not consume RP logout parameters or return automatically. Local
   * sessions have no upstream logout destination.
   */
  endSessionUrl(returnTo = '/auth/login', authSource: WebAuthSource = 'authentik'): string | undefined {
    const auth = authSource === 'local' ? undefined : providerConfig(this.getConfig(), authSource);
    // A local session never created an SSO session, so there is nothing to end.
    if (!auth?.clientId) return undefined;
    const candidate = auth.endSessionUrl || (authSource === 'authentik' && auth.issuer ? `${auth.issuer.replace(/\/$/, '')}/end-session/` : '');
    if (!candidate) return undefined;
    const safeReturnTo = safeReturnPath(returnTo, this.getConfig().publicBaseUrl, '/auth/login');
    let url: URL;
    try { url = new URL(candidate); }
    catch { return undefined; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    if (authSource === 'sakura') return url.toString(); // Sakura requires confirmation; it ignores RP logout parameters.
    url.searchParams.set('client_id', auth.clientId);
    url.searchParams.set('post_logout_redirect_uri', `${this.getConfig().publicBaseUrl}${safeReturnTo}`);
    return url.toString();
  }

  csrf(identity: WebIdentity): string {
    return createHmac('sha256', this.getConfig().setup.encryptionKey)
      .update(`csrf:${identity.sessionId}:${identity.userId}`).digest('base64url');
  }

  verifyCsrf(identity: WebIdentity, candidate: string | undefined): boolean {
    if (!candidate) return false;
    const expected = Buffer.from(this.csrf(identity));
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  cookie(token: string, maxAge = 43_200): string {
    return `sakura_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureFlag()}`;
  }

  clearCookie(): string { return `sakura_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureFlag()}`; }

  private secureFlag(): string { return this.getConfig().publicBaseUrl.startsWith('https://') ? '; Secure' : ''; }


  static readCookie(header: string | undefined): string | undefined {
    return header?.split(';').map(item => item.trim()).find(item => item.startsWith('sakura_session='))?.slice('sakura_session='.length);
  }

  private async createLocalIdentity(): Promise<WebIdentity> {
    const identity = await new MemoryRepository(this.database).ensureUser('local-admin', { displayName: 'Local Administrator' });
    await this.database.query('UPDATE users SET is_system_admin=true WHERE id=$1', [identity.userId]);
    return {
      sessionId: '00000000-0000-4000-8000-000000000001', userId: identity.userId, subject: 'local-admin',
      email: null, displayName: 'Local Administrator', avatarUrl: null, isSystemAdmin: true,
      expiresAt: '9999-12-31T23:59:59.999Z', authSource: 'local'
    };
  }

  private requireProviderConfig(provider: OidcProvider): Required<OidcProviderConfig> {
    const auth = providerConfig(this.getConfig(), provider);
    if (!browserLoginConfigured(this.getConfig(), provider)) {
      throw new Error(`${PROVIDER_LABELS[provider]} browser login is not configured.`);
    }
    return auth as Required<OidcProviderConfig>;
  }
}

/**
 * Authentik's built-in superuser group. Authentik's default `profile` scope
 * mapping already returns `groups` as a list of group names, so recognising
 * this name makes Authentik administrators system administrators without any
 * extra configuration.
 */
export const DEFAULT_ADMIN_GROUPS = ['authentik Admins'];

/**
 * Resolves whether the ID Token places the user in an administrator group.
 *
 * - Explicitly configured `adminGroups` are authoritative: a miss returns false
 *   so that removing someone from the group revokes access on the next login.
 * - Without configuration the built-in superuser group only ever promotes,
 *   returning undefined on a miss so that manually granted administrators and
 *   the allowlist keep working.
 * - With explicit adminGroups, missing or malformed claims deny group access.
 *   Returns undefined for unusable claims only without explicit configuration.
 *
 * `defaultGroups` exists because only Authentik has a well-known built-in
 * superuser group; SakuraID administrators define their own group names, so a
 * SakuraID login never promotes by a guessed group name. Only a verified
 * Sakura email may reach the allowlist; current Sakura emits unverified email.
 */
export function adminByGroup(payload: JWTPayload, auth: OidcProviderConfig, defaultGroups: string[] = DEFAULT_ADMIN_GROUPS): boolean | undefined {
  const configured = auth.adminGroups?.map(group => group.trim().toLowerCase()).filter(Boolean) ?? [];
  const expected = configured.length ? configured : defaultGroups.map(group => group.toLowerCase());
  const raw = payload[auth.groupsClaim ?? 'groups'];
  const groups = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : undefined;
  if (!groups) return configured.length ? false : undefined;
  const actual = groups.filter((group): group is string => typeof group === 'string').map(group => group.trim().toLowerCase());
  const matched = actual.some(group => expected.includes(group));
  if (matched) return true;
  return configured.length ? false : undefined;
}

export async function describeTokenExchangeFailure(response: Response, label = 'Authentik'): Promise<string> {
  const prefix = `${label} 令牌交换失败（HTTP ${response.status}）`;
  let raw = '';
  try { raw = await readBoundedResponse(response, 64 * 1024); }
  catch { return `${prefix}。`; }
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { return `${prefix}${raw ? `：${safeErrorText(raw)}` : '。'}`; }
  const object = decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : {};
  const code = typeof object.error === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(object.error) ? object.error : '';
  const description = typeof object.error_description === 'string' ? safeErrorText(object.error_description) : '';
  const detail = [code, description].filter(Boolean).join('：');
  const guidance = code === 'invalid_client'
    ? `请确认 ${label} OAuth2/OIDC 提供方的客户端类型为 Public（公共客户端），并且 Client ID 与安装配置一致。`
    : code === 'invalid_grant'
      ? '请确认回调地址精确为当前域名的 /auth/callback，并重新发起登录以获取新的授权码。'
      : '';
  return `${prefix}${detail ? `：${detail}` : ''}。${guidance}`;
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('Response is too large.');
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
      if (size > limit) throw new Error('Response is too large.');
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
}

function safeErrorText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}