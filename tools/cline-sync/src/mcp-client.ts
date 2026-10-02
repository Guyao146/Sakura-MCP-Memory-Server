/**
 * Minimal Streamable HTTP MCP client. Only what the sync daemon needs:
 * initialize + tools/call, authenticated with a static Agent bearer token, so
 * it never touches OAuth or dynamic client registration. Responses come back as
 * a single SSE `data:` line which we parse into JSON.
 */

export interface McpCallResult { ok: boolean; error?: string; raw?: unknown; }

const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  constructor(private readonly url: string, private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch) {}

  private async rpc(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('MCP 请求超时')), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${firstLine(body)}`);
      return parseSse(body);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  /** Confirms the endpoint and credential work before syncing. */
  async initialize(timeoutMs = 20_000, signal?: AbortSignal): Promise<void> {
    const result = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: 'sakura-cline-sync', version: '0.2.0' }
    }, timeoutMs, signal) as { error?: { message?: string } };
    if (result?.error) throw new Error(result.error.message ?? 'initialize failed');
  }

  async extractAndRemember(text: string, spaceId: string | undefined, timeoutMs = 120_000,
    signal?: AbortSignal): Promise<McpCallResult> {
    const args: Record<string, unknown> = { text };
    if (spaceId) args.space_id = spaceId;
    const parsed = await this.rpc('tools/call', { name: 'memory_extract_and_remember', arguments: args }, timeoutMs, signal) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    };
    if (parsed?.error) return { ok: false, error: parsed.error.message ?? 'RPC error' };
    if (parsed?.result?.isError) {
      const message = parsed.result.content?.map(c => c.text).filter(Boolean).join(' ') ?? 'tool error';
      return { ok: false, error: message };
    }
    return { ok: true, raw: parsed?.result };
  }
}

function firstLine(body: string): string {
  return body.split('\n', 1)[0]?.slice(0, 300) ?? '';
}

/** Extracts the JSON payload from an SSE response (`event: message\ndata: {...}`). */
export function parseSse(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('空响应');
  const dataLines = trimmed.split(/\r?\n/).filter(line => line.startsWith('data:'));
  const payload = dataLines.length
    ? dataLines.map(line => line.slice(5).trim()).join('')
    : trimmed;
  try { return JSON.parse(payload); }
  catch { throw new Error(`无法解析响应：${payload.slice(0, 200)}`); }
}
