import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from '../src/tools.js';
import { RequestLifecycle } from '../src/lifecycle.js';
import { operationContext, operationSignal, trackOperation } from '../src/operations.js';
import { streamWithDeferredCleanup } from '../src/mcp-routing.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SpaceRepository } from '../src/spaces/repository.js';
import { SemanticMemoryService } from '../src/semantic/service.js';
import { loadConfig } from '../src/config.js';
import type { Database } from '../src/database.js';
import type { AuditLogger } from '../src/audit.js';

afterEach(() => vi.restoreAllMocks());

it.each(['tool', 'resource'] as const)('tracks actual application %s callbacks until cancellation finishes', async kind => {
  const config = loadConfig({ PUBLIC_BASE_URL: 'http://localhost', DATABASE_URL: 'postgresql://unused',
    CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') });
  vi.spyOn(MemoryRepository.prototype, 'ensureUser').mockResolvedValue({ userId: 'user', personalSpaceId: 'space' });
  const audit = { write: vi.fn(async () => undefined) };
  const parent = new AbortController(); const lifecycle = new RequestLifecycle();
  let signal!: AbortSignal;
  let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; });
  let finish!: () => void; const finishing = new Promise<void>(resolve => { finish = resolve; });
  const stalled = async () => {
    signal = operationSignal()!;
    start();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    await finishing;
    signal.throwIfAborted();
    return [];
  };
  if (kind === 'tool') vi.spyOn(SemanticMemoryService.prototype, 'extract').mockImplementation(stalled);
  else vi.spyOn(SpaceRepository.prototype, 'list').mockImplementation(stalled);
  const request = new Request('http://localhost/mcp', {
    method: 'POST', signal: parent.signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1,
      method: kind === 'tool' ? 'tools/call' : 'resources/read',
      params: kind === 'tool' ? { name: 'memory_extract', arguments: { text: 'test' } } : { uri: 'memory://spaces' } })
  });
  const response = await lifecycle.handle(request, async req => {
    const server = createServer({} as Database, { id: 'test', source: 'local', scopes: ['memory:read', 'memory:write'], expiresAt: Infinity },
      audit as unknown as AuditLogger, () => config);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const context = operationContext.getStore();
    await server.connect(transport);
    return streamWithDeferredCleanup(await transport.handleRequest(req), () => trackOperation(async () => {
      await transport.close(); await server.close();
    }, context), operationSignal());
  });
  try {
    expect(response.status).toBe(200);
    await started;
    parent.abort(new Error('client gone'));
    await expect(response.text()).rejects.toThrow('client gone');
    expect(signal.aborted).toBe(true);
    expect(lifecycle.size).toBe(1);
    finish(); await lifecycle.stop();
    expect(lifecycle.size).toBe(0);
    expect(audit.write).not.toHaveBeenCalled();
  } finally { parent.abort(); finish(); await lifecycle.stop(); }
});
