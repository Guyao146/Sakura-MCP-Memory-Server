import { serve } from '@hono/node-server';
import { createHttpApp } from '../src/security/app.js';
import { loadConfig } from '../src/config.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('checks loopback health using the public Host without weakening validation', async () => {
  const app = createHttpApp(loadConfig({ HOST: '0.0.0.0', PUBLIC_BASE_URL: 'https://mcp.example.com',
    DATABASE_URL: 'postgresql://unused', CONFIG_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64url') }));
  app.get('/health', context => context.json({ ok: true }));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    expect(denied.status).toBe(403);
    await denied.text();
    await expect(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/healthcheck.mjs', import.meta.url))], {
      env: { ...process.env, PUBLIC_BASE_URL: 'https://mcp.example.com', PORT: String(port) }, timeout: 10000
    })).resolves.toMatchObject({ stdout: '', stderr: '' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
