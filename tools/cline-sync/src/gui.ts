/**
 * Local configuration panel. Serves a small HTML page on 127.0.0.1 so the tray
 * menu can open it in the default browser. Binding to the loopback interface
 * only, plus a per-process random token in every request, keeps the panel (which
 * exposes the Agent key) unreachable from the network and from other origins.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { normalizeConfig, validateConfig, type SyncConfig } from './config.js';
import type { TaskInventoryItem } from './sync.js';
import { panelHtml } from './gui-page.js';

export interface PanelHooks {
  getConfig: () => SyncConfig;
  setConfig: (config: SyncConfig) => Promise<void>;
  getStatus: () => PanelStatus;
  syncNow: () => Promise<void>;
  testConnection: (config: SyncConfig) => Promise<{ ok: boolean; error?: string }>;
  listTasks: () => Promise<TaskInventoryItem[]>;
}

export interface PanelStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: string | null;
  recent: Array<{ taskId: string; status: string; newMessages: number; reason?: string }>;
}

export class ConfigPanel {
  private server?: Server;
  readonly token = randomBytes(16).toString('hex');
  private port = 0;

  constructor(private readonly hooks: PanelHooks) {}

  get url(): string { return `http://127.0.0.1:${this.port}/?token=${this.token}`; }

  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Loopback only: never expose the token or the config to the network.
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const supplied = url.searchParams.get('token') ?? request.headers['x-panel-token'];
    if (supplied !== this.token) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(panelHtml);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const config = this.hooks.getConfig();
        return this.json(response, 200, { config: { ...config, token: mask(config.token) }, status: this.hooks.getStatus() });
      }
      if (request.method === 'POST' && url.pathname === '/api/config') {
        const body = await readJson(request);
        const current = this.hooks.getConfig();
        // An unchanged masked token means "keep the stored value".
        const incoming = body as Partial<SyncConfig>;
        const token = typeof incoming.token === 'string' && !incoming.token.includes('*') ? incoming.token : current.token;
        const next = normalizeConfig({ ...current, ...incoming, token });
        const problems = validateConfig(next);
        if (problems.length) return this.json(response, 400, { error: problems.join(' ') });
        await this.hooks.setConfig(next);
        return this.json(response, 200, { saved: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/test') {
        const config = this.hooks.getConfig();
        const result = await this.hooks.testConnection(config);
        return this.json(response, result.ok ? 200 : 400, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/sync') {
        await this.hooks.syncNow();
        return this.json(response, 200, { started: true, status: this.hooks.getStatus() });
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        return this.json(response, 200, { tasks: await this.hooks.listTasks() });
      }
      this.json(response, 404, { error: 'not_found' });
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : 'internal error' });
    }
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
  }
}

export function mask(token: string): string {
  if (!token) return '';
  return token.length <= 14 ? '*'.repeat(token.length) : `${token.slice(0, 10)}${'*'.repeat(8)}${token.slice(-4)}`;
}

async function readJson(request: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}
