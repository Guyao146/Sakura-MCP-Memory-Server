/**
 * Extracts client identity hints from a JSON-RPC MCP request body so the console
 * can label sessions. The body is supplied by the caller, so every field is
 * treated as untrusted: names and versions are length-capped and control
 * characters stripped before they reach the database or the admin page.
 */
export interface McpRequestFacts {
  method?: string;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
  toolName?: string;
  isInitialize: boolean;
  isToolCall: boolean;
}

/** Tools that write memories; used to flag a session as uploading. */
const WRITE_TOOLS = new Set([
  'memory_remember', 'memory_extract_and_remember', 'memory_update', 'memory_forget',
  'memory_resolve_conflict', 'memory_import', 'space_create', 'agent_create'
]);

export function readMcpFacts(body: unknown): McpRequestFacts {
  // Batched requests are arrays; the first entry carries the interesting method.
  const entry = Array.isArray(body) ? body[0] : body;
  const object = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const method = typeof object.method === 'string' ? object.method : undefined;
  const params = object.params && typeof object.params === 'object' ? object.params as Record<string, unknown> : {};
  const clientInfo = params.clientInfo && typeof params.clientInfo === 'object'
    ? params.clientInfo as Record<string, unknown> : {};
  return {
    method,
    clientName: clean(clientInfo.name, 120),
    clientVersion: clean(clientInfo.version, 60),
    protocolVersion: clean(params.protocolVersion, 40),
    toolName: clean(params.name, 120),
    isInitialize: method === 'initialize',
    isToolCall: method === 'tools/call'
  };
}

export function isWriteTool(toolName: string | undefined): boolean {
  return Boolean(toolName && WRITE_TOOLS.has(toolName));
}

/** Strips control characters and caps length so client-supplied text stays safe. */
function clean(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return stripped ? stripped.slice(0, limit) : undefined;
}
