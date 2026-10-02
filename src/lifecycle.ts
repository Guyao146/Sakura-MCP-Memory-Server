import { operationContext, type OperationContext } from './operations.js';
import { streamWithDeferredCleanup } from './mcp-routing.js';

/** Bounds admitted work, including streaming responses and detached MCP handlers. */
export class RequestLifecycle {
  private readonly active = new Set<{ controller: AbortController; done: Promise<void> }>();
  private stopping = false;
  constructor(private readonly maxConcurrent = 128) {}

  get size(): number { return this.active.size; }

  async handle(request: Request, fetch: (request: Request) => Response | Promise<Response>): Promise<Response> {
    if (this.stopping || this.active.size >= this.maxConcurrent) {
      return new Response(JSON.stringify({ error: this.stopping ? 'shutting_down' : 'server_busy' }), {
        status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '1', Connection: 'close' }
      });
    }
    const controller = new AbortController();
    const abort = () => controller.abort(request.signal.reason);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    let resolve!: () => void;
    const entry = { controller, done: new Promise<void>(done => { resolve = done; }) };
    this.active.add(entry);
    const context: OperationContext = { signal: controller.signal, pending: new Set() };
    let cleanup: Promise<void> | undefined;
    const finish = () => cleanup ??= (async () => {
      controller.abort(new Error('Request finished.'));
      while (context.pending.size) await Promise.allSettled([...context.pending]);
      request.signal.removeEventListener('abort', abort);
      this.active.delete(entry);
      resolve();
    })();
    try {
      const response = await operationContext.run(context, async () => {
        controller.signal.throwIfAborted();
        return fetch(request);
      });
      // A request that finishes after server.close() must not reopen keep-alive.
      const outgoing = this.stopping ? new Response(response.body, {
        status: response.status, statusText: response.statusText, headers: response.headers
      }) : response;
      if (this.stopping) outgoing.headers.set('Connection', 'close');
      return streamWithDeferredCleanup(outgoing, finish, controller.signal);
    } catch (error) {
      await finish();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const entry of this.active) entry.controller.abort(new Error('Server shutting down.'));
    await Promise.all([...this.active].map(entry => entry.done));
  }
}

interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections?(): void;
}

/** One shared shutdown promise; PostgreSQL remains available until users have drained. */
export function createShutdown(server: ClosableServer, requests: RequestLifecycle,
  worker: { stop(): Promise<void> }, database: { close(): Promise<void> }, timeoutMs = 25_000): () => Promise<boolean> {
  let closing: Promise<boolean> | undefined;
  return () => closing ??= (async () => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => { server.closeAllConnections?.(); resolve(false); }, timeoutMs);
    });
    const drained = (async () => {
      const httpClosed = new Promise<void>(resolve => server.close(() => resolve()));
      const results = await Promise.allSettled([requests.stop(), worker.stop(), httpClosed]);
      await database.close();
      return results.every(result => result.status === 'fulfilled');
    })();
    try { return await Promise.race([drained, deadline]); }
    finally { clearTimeout(timer); }
  })();
}
