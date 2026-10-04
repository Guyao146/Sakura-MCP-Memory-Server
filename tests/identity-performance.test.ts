import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../src/memory/repository.js';
import { createServer } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { McpServer } from '@modelcontextprotocol/server';

afterEach(() => vi.restoreAllMocks());
describe('request identity and statistical writes', () => {
  it('resolves an unchanged user with one live SELECT and no transaction/writes', async () => {
    const identity = { userId: 'owner', personalSpaceId: 'personal' };
    const query = vi.fn(async () => ({ rows: [identity] }));
    const connect = vi.fn();
    const repository = new MemoryRepository({ query, pool: { connect } } as never);
    await expect(repository.ensureUser('subject')).resolves.toEqual(identity);
    expect(query).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    const [sql, args] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/^SELECT /);
    for (const guard of ["sm.role='owner'", 's.deleted_at IS NULL', 'system_admin_allowlist', '$4::boolean', "interval '5 minutes'"]) expect(sql).toContain(guard);
    expect(args).toEqual(['subject', null, null, null, false]);
  });

  it('falls back to transactional provisioning and authoritative group updates', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('RETURNING id') ? [{ id: sql.includes('INSERT INTO users') ? 'user' : 'space' }] : [] }));
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const repository = new MemoryRepository({ query: async () => ({ rows: [] }), pool: { connect } } as never);
    await expect(repository.ensureUser('subject', { adminByGroup: false })).resolves.toEqual({ userId: 'user', personalSpaceId: 'space' });
    expect(query).toHaveBeenCalledWith('UPDATE users SET is_system_admin=$2 WHERE id=$1', ['user', false]);
    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('reuses the supplied request identity in real tool handlers without reprovisioning', async () => {
    const handlers = new Map<string, Function>();
    const original = McpServer.prototype.registerTool;
    vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function(this: McpServer, name, options, handler) {
      handlers.set(name, handler); return original.call(this, name, options, handler);
    });
    const ensure = vi.spyOn(MemoryRepository.prototype, 'ensureUser');
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
      CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
    const server = createServer({ query } as never, { id: 'subject', source: 'local', scopes: ['memory:read'], expiresAt: Infinity },
      { write: async () => undefined } as never, () => config, Promise.resolve({ userId: 'user', personalSpaceId: 'personal' }));
    try {
      const result = await handlers.get('memory_search')!({ query: '', limit: 20 }, { mcpReq: { signal: new AbortController().signal } });
      // Identity reuse must NOT bypass the live space membership check.
      expect(result.isError).toBe(true);
      expect(query.mock.calls[0][0]).toContain('SELECT sm.role');
      expect(ensure).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });

  it('throttles last access writes without throttling membership reads', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith('SELECT') ? [{ id: 'memory' }] : [] }));
    const repository = new MemoryRepository({ query } as never);
    await repository.get('user', 'memory'); await repository.get('user', 'memory');
    expect(query.mock.calls.filter(([sql]) => sql.includes('JOIN space_members'))).toHaveLength(2);
    expect(query.mock.calls[1][0]).toContain("last_accessed_at < now()-interval '5 minutes'");
  });
});
