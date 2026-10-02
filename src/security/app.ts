import type { AppConfig } from '../config.js';
import { Hono, type Context, type Next } from 'hono';
import { hostHeaderValidation, localhostOriginValidation } from '@modelcontextprotocol/hono';
import { RateLimiter, securityHeaders } from './http.js';
import { operationSignal } from '../operations.js';

/** Keep SDK host/origin protection without its eager, cloned JSON parser. */
export function createHttpApp(config: AppConfig) {
  const app = new Hono();
  const limiter = new RateLimiter();
  app.use('*', securityHeaders());
  app.use('*', hostHeaderValidation([new URL(config.publicBaseUrl).hostname]));
  if (['127.0.0.1', 'localhost', '::1'].includes(config.host)) app.use('*', localhostOriginValidation());
  app.use('/mcp', limiter.middleware('mcp', config.security.mcpPerMinute, config.security.trustProxy));
  app.use('/', limiter.middleware('mcp-root', config.security.mcpPerMinute, config.security.trustProxy));
  app.use('/auth/*', limiter.middleware('auth', config.security.authPerMinute, config.security.trustProxy));
  app.use('/api/setup/*', limiter.middleware('setup', config.security.setupPerMinute, config.security.trustProxy));
  app.use('/api/admin/*', limiter.middleware('web', config.security.webPerMinute, config.security.trustProxy));
  app.use('*', boundedBody(config.security.maxBodyBytes));
  return app;
}

/** Count actual bytes, including chunked bodies and incorrectly declared lengths. */
export function boundedBody(maxBytes: number) {
  return async (context: Context, next: Next) => {
    const tooLarge = () => context.json({ error: 'payload_too_large', max_bytes: maxBytes }, 413);
    const encoding = context.req.header('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') return context.json({ error: 'unsupported_content_encoding' }, 415);
    const length = context.req.header('content-length');
    if (length !== undefined) {
      if (!/^\d+$/.test(length)) return context.json({ error: 'invalid_content_length' }, 400);
      if (Number(length) > maxBytes) return tooLarge();
    }
    const request = context.req.raw;
    if (request.body) {
      const reader = request.body.getReader();
      const signal = operationSignal() ?? request.signal;
      const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            void reader.cancel().catch(() => undefined);
            return tooLarge();
          }
          chunks.push(value);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        reader.releaseLock();
      }
      // No clone/tee: handlers parse once after authentication/CSRF checks and
      // pass that object to the SDK. Buffering is capped above.
      context.req.raw = new Request(request, { body: Buffer.concat(chunks, size) });
    }
    await next();
  };
}
