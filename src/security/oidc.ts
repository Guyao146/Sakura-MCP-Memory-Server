import { createHash } from 'node:crypto';
import type { OidcProvider } from '../config.js';

/** Preserve legacy Authentik IDs, but never let an external subject address a local account. */
export function oidcSubject(provider: OidcProvider, issuer: string, subject: string): string {
  if (provider === 'sakura') {
    const issuerHash = createHash('sha256').update(issuer).digest('hex');
    return `sakura:${issuerHash}:${subject}`;
  }
  if (subject === 'local-admin' || subject.startsWith('local:') || subject.startsWith('sakura:')) {
    throw new Error('OIDC subject uses a reserved account namespace.');
  }
  return subject;
}
