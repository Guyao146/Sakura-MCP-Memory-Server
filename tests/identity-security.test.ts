import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../src/memory/repository.js';
import { createServer } from '../src/tools.js';
import { loadConfig } from '../src/config.js';

const email = 'owner@example.com';
afterEach(() => vi.restoreAllMocks());

// SQL boundary double: exercise the real repository; PostgreSQL checks live in the integration suite.
function repositoryFixture() {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.startsWith('SELECT 1 FROM system_admin_allowlist')) return { rows: [{}], rowCount: 1 };
    return { rows: sql.includes('RETURNING id') ? [{ id: sql.includes('INSERT INTO users') ? 'user' : 'space' }] : [], rowCount: 0 };
  });
  return { query, repository: new MemoryRepository({ query: async () => ({ rows: [] }),
    pool: { connect: async () => ({ query, release() {} }) } } as never) };
}

describe('administrator email trust boundary', () => {
  it.each(['local:owner', 'external-owner'])('does not promote ordinary stored profile email for %s', async subject => {
    const f = repositoryFixture();
    await f.repository.ensureUser(subject, { email });
    expect(f.query.mock.calls.some(([sql]) => sql.includes('system_admin_allowlist'))).toBe(false);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE users SET is_system_admin'))).toBe(false);
  });

  it('allows explicitly trusted email to promote an administrator', async () => {
    const f = repositoryFixture();
    await f.repository.ensureUser('verified-owner', { email, allowAdminByEmail: true });
    expect(f.query).toHaveBeenCalledWith('UPDATE users SET is_system_admin=true WHERE id=$1', ['user']);
  });

  it('does not let untrusted profile email override group demotion', async () => {
    const f = repositoryFixture();
    await f.repository.ensureUser('external-owner', { email, adminByGroup: false });
    expect(f.query).toHaveBeenCalledWith('UPDATE users SET is_system_admin=$2 WHERE id=$1', ['user', false]);
  });

  it.each([false, true])('includes email trust in the read-only provisioning predicate (%s)', async trusted => {
    const query = vi.fn(async (_sql: string, _args?: unknown[]) => ({ rows: [{ userId: 'user', personalSpaceId: 'space' }] }));
    const repository = new MemoryRepository({ query } as never);
    await repository.ensureUser('owner', { email, allowAdminByEmail: trusted });
    expect(query.mock.calls[0][0]).toContain('$5::boolean');
    expect(query.mock.calls[0][1]).toEqual(['owner', email, null, null, trusted]);
  });

  it.each(['api_key', 'authentik'] as const)('propagates the trust boundary from MCP %s authentication', async source => {
    const ensure = vi.spyOn(MemoryRepository.prototype, 'ensureUser').mockResolvedValue({ userId: 'user', personalSpaceId: 'space' });
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
    const server = createServer({} as never, { id: 'owner', source, email, scopes: ['memory:read'], expiresAt: Infinity },
      {} as never, () => config);
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(ensure).toHaveBeenCalledWith('owner', expect.objectContaining({ email, allowAdminByEmail: source === 'authentik' }));
    } finally { await server.close(); }
  });
});
