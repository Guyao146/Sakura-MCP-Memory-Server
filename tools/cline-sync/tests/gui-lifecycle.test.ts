import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigPanel, type PanelHooks } from '../src/gui.js';
import { normalizeConfig } from '../src/config.js';
import { emptyHistory } from '../src/history.js';

const panels: ConfigPanel[] = [];
afterEach(async () => { await Promise.all(panels.splice(0).map(panel => panel.stop())); });
function create(hooks: Partial<PanelHooks> = {}) {
  const panel = new ConfigPanel({
    getConfig: () => normalizeConfig({}), setConfig: async () => undefined,
    getStatus: () => ({ enabled: false, running: false, halted: false,
      lastRunAt: null, nextRunAt: null, lastResult: null, recent: [], history: emptyHistory() }),
    syncNow: async () => undefined, resumeSync: () => undefined,
    testConnection: async () => ({ ok: true }), listTasks: async () => [], ...hooks
  });
  panels.push(panel);
  return panel;
}
function endpoint(panel: ConfigPanel, path: string) {
  const url = new URL(panel.url);
  url.pathname = path;
  return url;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { resolve, promise };
}

describe('config panel token retention', () => {
  it.each(['', '  \t ', '********', undefined])('keeps the stored token for %j over HTTP', async token => {
    const config = normalizeConfig({ mcpUrl: 'https://mcp.example.com', token: 'sk_sakura_existing_secret', clineTasksDir: 'C:/tasks' });
    const setConfig = vi.fn(async () => undefined);
    const panel = create({ getConfig: () => config, setConfig });
    await panel.start();
    const response = await fetch(endpoint(panel, '/api/config'), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(response.status).toBe(200);
    await response.json();
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ token: config.token }));
  });
});


describe('config panel resource lifecycle', () => {
  it('starts one listener, rejects unauthenticated access, and closes keep-alive connections', async () => {
    const panel = create();
    const urls = await Promise.all([panel.start(), panel.start(), panel.start()]);
    expect(new Set(urls).size).toBe(1);
    const response = await fetch(endpoint(panel, '/api/state'));
    expect(response.status).toBe(200);
    await response.json();
    const denied = await fetch(new URL('/api/state', panel.url));
    expect(denied.status).toBe(403);
    await denied.text();
    await Promise.all([panel.stop(), panel.stop()]);
    await expect(fetch(panel.url)).rejects.toThrow();
    await expect(panel.start()).rejects.toThrow('已关闭');
  });

  it('does not leak a listener when stopped during startup', async () => {
    const panel = create();
    const starting = panel.start();
    await panel.stop();
    await starting;
    await expect(fetch(panel.url)).rejects.toThrow();
  });

  it('aborts pending hooks on client disconnect and releases the exclusive slot', async () => {
    const entered = deferred<AbortSignal>();
    const aborted = deferred<void>();
    const listTasks = vi.fn<PanelHooks['listTasks']>(signal => new Promise((_resolve, reject) => {
      entered.resolve(signal!);
      signal!.addEventListener('abort', () => { aborted.resolve(); reject(signal!.reason); }, { once: true });
    }));
    const panel = create({ listTasks });
    await panel.start();
    const controller = new AbortController();
    const first = fetch(endpoint(panel, '/api/tasks'), { signal: controller.signal }).catch(error => error);
    const signal = await entered.promise;
    const duplicate = await fetch(endpoint(panel, '/api/tasks'));
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    expect(listTasks).toHaveBeenCalledTimes(1);
    controller.abort();
    await first;
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    listTasks.mockResolvedValue([]);
    const next = await fetch(endpoint(panel, '/api/tasks'));
    expect(next.status).toBe(200);
    await next.json();
    expect(listTasks).toHaveBeenCalledTimes(2);
  });

  it('aborts connection tests and closes their sockets on shutdown', async () => {
    const entered = deferred<AbortSignal>();
    const panel = create({ testConnection: (_config, signal) => new Promise((_resolve, reject) => {
      entered.resolve(signal!);
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }) });
    await panel.start();
    const response = fetch(endpoint(panel, '/api/test'), { method: 'POST' }).catch(error => error);
    const signal = await entered.promise;
    const duplicate = await fetch(endpoint(panel, '/api/test'), { method: 'POST' });
    expect(duplicate.status).toBe(409);
    await duplicate.text();
    await panel.stop();
    await response;
    expect(signal.aborted).toBe(true);
  });
});
