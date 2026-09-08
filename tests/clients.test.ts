import { describe, expect, it } from 'vitest';
import { clientKey, deriveStatus, toClientView, LIVE_WINDOW_SECONDS, STALE_WINDOW_SECONDS,
  type ClientSessionRow } from '../src/clients/types.js';
import { isWriteTool, readMcpFacts } from '../src/clients/facts.js';

const now = Date.UTC(2026, 7, 31, 12, 0, 0);
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

const row = (overrides: Partial<ClientSessionRow> = {}): ClientSessionRow => ({
  id: '1', client_name: 'Cline', client_version: '4.1.15', protocol_version: '2025-06-18',
  auth_source: 'api_key', agent_id: null, agent_name: null, remote_address: null,
  connected_at: at(600), last_seen_at: at(5), disconnected_at: null,
  active_operations: 0, last_activity: 'memory_recall',
  request_count: '10', write_calls: '2', error_count: '0', ...overrides
});

describe('client session status', () => {
  it('reports uploading while a tool call is in flight', () => {
    expect(deriveStatus(row({ active_operations: 1 }), now)).toBe('uploading');
    // Even a slow call past the live window still counts as uploading.
    expect(deriveStatus(row({ active_operations: 2, last_seen_at: at(LIVE_WINDOW_SECONDS + 30) }), now)).toBe('uploading');
  });

  it('reports connected inside the liveness window and idle past it', () => {
    expect(deriveStatus(row({ last_seen_at: at(1) }), now)).toBe('connected');
    expect(deriveStatus(row({ last_seen_at: at(LIVE_WINDOW_SECONDS - 1) }), now)).toBe('connected');
    expect(deriveStatus(row({ last_seen_at: at(LIVE_WINDOW_SECONDS + 1) }), now)).toBe('idle');
  });

  it('reports disconnected when explicitly closed or long silent', () => {
    expect(deriveStatus(row({ disconnected_at: at(0) }), now)).toBe('disconnected');
    expect(deriveStatus(row({ last_seen_at: at(STALE_WINDOW_SECONDS + 1) }), now)).toBe('disconnected');
    // An explicit disconnect wins over an in-flight counter that was never released.
    expect(deriveStatus(row({ active_operations: 3, disconnected_at: at(0) }), now)).toBe('disconnected');
  });

  it('converts bigint counters to numbers for the API', () => {
    const view = toClientView(row({ request_count: '4000000000', write_calls: '7', error_count: '1' }), now);
    expect(view.requestCount).toBe(4_000_000_000);
    expect(view.writeCalls).toBe(7);
    expect(view.errorCount).toBe(1);
    expect(view.status).toBe('connected');
  });

  it('scopes the client key by user and agent so names cannot collide across tenants', () => {
    const a = clientKey({ userId: 'user-a', authSource: 'api_key', clientName: 'Cline' });
    const b = clientKey({ userId: 'user-b', authSource: 'api_key', clientName: 'Cline' });
    const c = clientKey({ userId: 'user-a', agentId: 'agent-1', authSource: 'api_key', clientName: 'Cline' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(clientKey({ userId: 'user-a', authSource: 'authentik', clientName: 'Cline' }));
  });
});

describe('MCP request facts', () => {
  it('reads clientInfo from initialize', () => {
    const facts = readMcpFacts({ method: 'initialize', params: {
      protocolVersion: '2025-06-18', clientInfo: { name: 'Cline', version: '4.1.15' } } });
    expect(facts).toMatchObject({ isInitialize: true, isToolCall: false, clientName: 'Cline',
      clientVersion: '4.1.15', protocolVersion: '2025-06-18' });
  });

  it('reads the tool name from tools/call and flags writes', () => {
    const facts = readMcpFacts({ method: 'tools/call', params: { name: 'memory_extract_and_remember' } });
    expect(facts.isToolCall).toBe(true);
    expect(facts.toolName).toBe('memory_extract_and_remember');
    expect(isWriteTool(facts.toolName)).toBe(true);
    expect(isWriteTool('memory_recall')).toBe(false);
    expect(isWriteTool(undefined)).toBe(false);
  });

  it('takes the first entry of a batched request', () => {
    expect(readMcpFacts([{ method: 'tools/list' }, { method: 'tools/call' }]).method).toBe('tools/list');
  });

  it('sanitises client-supplied strings and tolerates junk', () => {
    const facts = readMcpFacts({ method: 'initialize', params: {
      clientInfo: { name: `  Evil\u0000\nName  `, version: 'x'.repeat(200) } } });
    expect(facts.clientName).toBe('EvilName');
    expect(facts.clientVersion).toHaveLength(60);
    expect(readMcpFacts(null)).toMatchObject({ isInitialize: false, isToolCall: false });
    expect(readMcpFacts('not an object').clientName).toBeUndefined();
    expect(readMcpFacts({ method: 'initialize', params: { clientInfo: { name: '   ' } } }).clientName).toBeUndefined();
  });
});
