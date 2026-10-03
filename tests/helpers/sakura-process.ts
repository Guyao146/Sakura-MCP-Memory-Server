import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';

async function terminate(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { child.kill('SIGTERM'); await exited; }
  finally { clearTimeout(force); }
}

export async function startSakura(source: string, callback: string) {
  const root = resolve(source);
  await access(join(root, 'server.js')); // Fail before allocating data for a missing checkout.
  const reservation = createServer();
  await new Promise<void>((r, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', r);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r, reject) => reservation.close(e => e ? reject(e) : r()));
  const data = await mkdtemp(join(tmpdir(), 'sakura-mcp-idp-'));
  const origin = `http://127.0.0.1:${port}`;
  // Do not inherit SMTP/TLS settings or credentials from the developer's IdP.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    PORT: String(port), BASE_URL: origin, DATA_DIR: data };
  const moduleUrl = (name: string) => pathToFileURL(join(root, 'src', name)).href;
  const seed = `
    import { initDb, getDb } from ${JSON.stringify(moduleUrl('core/db.js'))};
    import { hashPassword } from ${JSON.stringify(moduleUrl('core/password.js'))};
    import * as users from ${JSON.stringify(moduleUrl('models/users.js'))};
    import * as clients from ${JSON.stringify(moduleUrl('models/clients.js'))};
    import * as groups from ${JSON.stringify(moduleUrl('models/groups.js'))};
    import { setSetting } from ${JSON.stringify(moduleUrl('models/settings.js'))};
    initDb();
    const user = users.create({ username: 'integration-owner', passwordHash: hashPassword('idp-password-123'),
      name: 'Integration Owner', email: 'owner@example.com' });
    groups.setUserGroups(user.id, ['MCP-Admins']);
    const client = clients.create({ name: 'Isolated MCP integration', redirectUris: [${JSON.stringify(callback)}],
      scopes: 'openid profile email groups', isPublic: true, pkceRequired: true, requireConsent: true });
    setSetting('setup_done', '1');
    console.log('FIXTURE:' + JSON.stringify({ clientId: client.client_id, subject: user.id }));
    getDb().close();
  `;
  let child: ChildProcess | undefined;
  let seeder: ChildProcess | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    await Promise.all([terminate(child), terminate(seeder)]);
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  })();
  try {
    seeder = spawn(process.execPath, ['--input-type=module'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    seeder.stdout!.on('data', chunk => { output = (output + chunk).slice(-4000); });
    seeder.stderr!.on('data', chunk => { errors = (errors + chunk).slice(-1000); });
    seeder.stdin!.on('error', () => undefined); // The exit/error result below carries startup failures.
    seeder.stdin!.end(seed);
    const seedDeadline = setTimeout(() => seeder?.kill('SIGKILL'), 8000);
    let code: number | null;
    try { [code] = await once(seeder, 'exit'); }
    finally { clearTimeout(seedDeadline); }
    if (code !== 0) throw new Error(`Isolated IdP fixture failed: ${errors}`);
    const fixtureLine = output.split('\n').find(line => line.startsWith('FIXTURE:'));
    if (!fixtureLine) throw new Error('Isolated IdP fixture did not return a client.');
    const fixture = JSON.parse(fixtureLine.slice(8)) as { clientId: string; subject: string };
    // Constrain the sibling's wildcard listener to loopback in this child only.
    // No source edits, fixed ports, existing databases or existing IdP accounts.
    const launcher = `
      import { Server } from 'node:net';
      const listen = Server.prototype.listen;
      Server.prototype.listen = function(port, callback) {
        return listen.call(this, { port, host: '127.0.0.1' }, callback);
      };
      await import(${JSON.stringify(pathToFileURL(join(root, 'server.js')).href)});
    `;
    child = spawn(process.execPath, ['--input-type=module', '-e', launcher], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.stdout!.on('data', chunk => { logs = (logs + chunk).slice(-2000); });
    child.stderr!.on('data', chunk => { logs = (logs + chunk).slice(-2000); });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Isolated IdP exited: ${logs}`);
      try {
        const response = await fetch(`${origin}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(500), redirect: 'error' });
        const metadata = response.ok ? await response.json() : undefined;
        if (metadata?.issuer === origin) return { ...fixture, origin, stop };
      } catch { /* Wait for the child listener. */ }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Isolated IdP did not start: ${logs}`);
  } catch (error) { await stop(); throw error; }
}

export class IdpBrowser {
  private cookies = new Map<string, string>();
  constructor(readonly origin: string) {}
  async request(path: string, form?: Record<string, string>) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Do not forward IdP cookies to another origin.');
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000),
      method: form ? 'POST' : 'GET', headers: { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form) : undefined });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]; const at = pair.indexOf('=');
      if (pair.slice(at + 1)) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
      else this.cookies.delete(pair.slice(0, at));
    }
    return res;
  }
}
export function hiddenInputs(html: string): Record<string, string> {
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)]
    .map(m => [m[1], decode(m[2])]));
}
