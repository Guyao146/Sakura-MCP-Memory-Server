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
import type { SyncHistory } from './history.js';
import { panelHtml } from './gui-page.js';

export interface PanelHooks {
  getConfig: () => SyncConfig;
  setConfig: (config: SyncConfig) => Promise<void>;
  getStatus: () => PanelStatus;
  syncNow: () => Promise<void>;
  testConnection: (config: SyncConfig, signal?: AbortSignal) => Promise<{ ok: boolean; error?: string }>;
  listTasks: (signal?: AbortSignal) => Promise<TaskInventoryItem[]>;
  resumeSync: () => void;
}

export interface PanelStatus {
  enabled: boolean;
  running: boolean;
  /** True when the circuit breaker stopped the scheduler. */
  halted: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResult: string | null;
  recent: Array<{ taskId: string; status: string; newMessages: number; reason?: string }>;
  history: SyncHistory;
}

export class ConfigPanel {
  private server?: Server;
  readonly token = randomBytes(16).toString('hex');
  private port = 0;
  private starting?: Promise<string>;
  private closing?: Promise<void>;
  private readonly requests = new Set<AbortController>();
  private readonly busy = new Set<string>();

  constructor(private readonly hooks: PanelHooks) {}

  get url(): string { return `http://127.0.0.1:${this.port}/?token=${this.token}`; }

  start(): Promise<string> {
    if (this.closing) return Promise.reject(new Error('配置面板已关闭'));
    return this.starting ??= this.listen();
  }

  private async listen(): Promise<string> {
    const server = createServer((request, response) => void this.handle(request, response));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    return this.url;
  }

  stop(): Promise<void> {
    return this.closing ??= (async () => {
      await this.starting?.catch(() => undefined);
      for (const controller of this.requests) controller.abort();
      const server = this.server;
      this.server = undefined;
      if (!server) return;
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        // Includes stalled POST bodies and keep-alive sockets; no new work is accepted.
        server.closeAllConnections();
      });
    })();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const supplied = url.searchParams.get('token') ?? request.headers['x-panel-token'];
    if (supplied !== this.token) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.requests.add(controller);
    response.once('close', abort);
    const exclusive = ['/api/tasks', '/api/test', '/api/config'].includes(url.pathname);
    let acquired = false;
    try {
      if (this.closing) return this.json(response, 503, { error: 'shutting_down' });
      if (exclusive) {
        if (this.busy.has(url.pathname)) return this.json(response, 409, { error: '操作仍在进行，请稍后重试' });
        this.busy.add(url.pathname);
        acquired = true;
      }
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
        const token = typeof incoming.token === 'string' && incoming.token.trim() && !incoming.token.includes('*') ? incoming.token : current.token;
        const next = normalizeConfig({ ...current, ...incoming, token });
        const problems = validateConfig(next);
        if (problems.length) return this.json(response, 400, { error: problems.join(' ') });
        await this.hooks.setConfig(next);
        return this.json(response, 200, { saved: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/test') {
        const config = this.hooks.getConfig();
        const result = await this.hooks.testConnection(config, controller.signal);
        return this.json(response, result.ok ? 200 : 400, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/sync') {
        await this.hooks.syncNow();
        return this.json(response, 200, { started: true, status: this.hooks.getStatus() });
      }
      if (request.method === 'POST' && url.pathname === '/api/resume') {
        this.hooks.resumeSync();
        return this.json(response, 200, { resumed: true, status: this.hooks.getStatus() });
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        return this.json(response, 200, { tasks: await this.hooks.listTasks(controller.signal) });
      }
      this.json(response, 404, { error: 'not_found' });
    } catch (error) {
      this.json(response, 500, { error: error instanceof Error ? error.message : 'internal error' });
    } finally {
      if (acquired) this.busy.delete(url.pathname);
      this.requests.delete(controller);
      response.removeListener('close', abort);
    }
  }

  private json(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed || response.writableEnded) return;
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
