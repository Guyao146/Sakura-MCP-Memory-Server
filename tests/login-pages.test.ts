import { Script, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { setupPage, setupScript } from '../src/setup/page.js';
import { loginPage, localLoginPage } from '../src/web/login-page.js';

// Minimal DOM adapter: execute the shipped scripts without adding a browser dependency.
class Element {
  value = ''; textContent = ''; innerHTML = ''; className = ''; href = '';
  hidden = false; disabled = false; checked = false;
  style: Record<string, string> = {}; dataset: Record<string, string> = {};
  classes = new Set<string>();
  classList = { toggle: (name: string, on: boolean) => on ? this.classes.add(name) : this.classes.delete(name) };
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  siblings: Element[] = [];
  parentNode = { insertBefore: (node: Element, next: Element | null) => {
    node.siblings = this.siblings;
    this.siblings.splice(next ? this.siblings.indexOf(next) : this.siblings.length, 0, node);
  } };
  get nextSibling() { return this.siblings[this.siblings.indexOf(this) + 1] ?? null; }
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => unknown) { this.listeners.set(name, callback); }
  focus() {}
  async fire(name: string) { await this.listeners.get(name)?.({ preventDefault() {} }); }
}
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function page(html: string, fetcher: typeof fetch, script?: string) {
  const elements = new Map<string, Element>();
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(); el.hidden = /\shidden(?:\s|>)/.test(match[0]);
    el.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] ?? '';
    elements.set(match[1], el);
  }
  const order = [...elements.values()]; order.forEach(el => { el.siblings = order; });
  const get = (id: string) => { const el = elements.get(id); if (!el) throw new Error(`Unknown element: ${id}`); return el; };
  if (elements.has('authMethod')) get('authMethod').value = 'local';
  if (elements.has('provider')) get('provider').value = 'none';
  const location = { origin: 'https://mcp.example.com', search: '?return_to=%2Fadmin', href: '' };
  const context = createContext({ document: { getElementById: get, querySelectorAll: () => [],
    documentElement: { dataset: {} }, cookie: '', createElement: () => new Element() },
    location, fetch: fetcher, URLSearchParams, AbortController, DOMException, TextDecoder,
    setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }) });
  if (script) new Script(script).runInContext(context);
  else for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]).runInContext(context);
  return { get, order, location, run: (code: string) => new Script(code).runInContext(context) };
}

describe('shipped page scripts', () => {
  it('does not claim or submit a local account in AUTH=false mode', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ completed: true }));
    const p = page(setupPage, fetcher, setupScript); await flush();
    p.get('confirm').checked = true; p.get('localUsername').value = 'not-created';
    p.run('authEnabled=false; buildSummary()');
    await p.run('completeSetup()');
    expect(p.get('summary').textContent).toContain('AUTH=false');
    expect(p.get('finalUrls').textContent).not.toContain('刚才创建');
    expect(p.get('finalUrls').textContent).not.toContain('not-created');
    const call = fetcher.mock.calls.find(args => args[0] === '/api/setup/complete');
    expect(JSON.parse(call![1]!.body as string)).toEqual({});
  });

  it.each([
    { local: true, sakura: true, authentik: true, provider: 'sakura' },
    { local: false, sakura: true, authentik: false, provider: 'sakura' },
    { local: false, sakura: false, authentik: true, provider: 'authentik' },
    { local: false, sakura: false, authentik: false, provider: null }
  ])('shows only available methods in local / Sakura / Authentik order: %j', async modes => {
    const fetcher = vi.fn(async (url: string | URL | Request) => Response.json(String(url) === '/auth/modes' ? modes : { version: 'test' }));
    const p = page(loginPage, fetcher); await flush();
    const visible = ['localLoginLink', 'startButton', 'otherProviderLink'].map(p.get).filter(el => !el.hidden);
    const methods = visible.map(el => el.href.includes('/auth/local-login') ? 'local' : new URL(el.href, p.location.origin).searchParams.get('provider'));
    expect(methods).toEqual(['local', 'sakura', 'authentik'].filter(name => modes[name as 'local' | 'sakura' | 'authentik']));
    expect(p.location.href).toBe('');
    expect(fetcher.mock.calls.every(([url]) => ['/auth/modes', '/health'].includes(String(url)))).toBe(true);
  });

  it('shows pending login feedback and restores the button after a failed request', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const p = page(localLoginPage, vi.fn(async url => String(url) === '/auth/local' ? pending : Response.json({})));
    p.get('username').value = 'owner'; p.get('password').value = 'wrong-password';
    await p.get('localForm').fire('submit');
    expect(p.get('submitButton').disabled).toBe(true);
    expect(p.get('submitButton').textContent).toBe('正在登录…');
    resolve(Response.json({ error_description: '登录失败' }, { status: 400 })); await flush();
    expect(p.get('submitButton').disabled).toBe(false);
    expect(p.get('submitButton').textContent).toBe('登录');
    expect(p.get('password').value).toBe('');
    expect(p.get('notice').textContent).toBe('登录失败');
  });

  it('inserts Sakura then Authentik after the local form', async () => {
    const p = page(localLoginPage, vi.fn(async () => Response.json({ local: true, sakura: true, authentik: true })));
    await flush();
    const form = p.get('localForm');
    const links = p.order.filter(el => el.href.includes('/auth/start'));
    expect(links.map(el => new URL(el.href, p.location.origin).searchParams.get('provider'))).toEqual(['sakura', 'authentik']);
    expect(p.order.indexOf(form)).toBeLessThan(p.order.indexOf(links[0]));
  });

  it('clears provider fields and ignores discovery completed after switching methods', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>(r => { resolve = r; });
    const fetcher = vi.fn(async (url: string | URL | Request) => String(url).includes('discover-')
      ? pending : Response.json({ completed: true }));
    const p = page(setupPage, fetcher, setupScript); await flush();
    p.get('authMethod').value = 'authentik'; await p.get('authMethod').fire('change');
    p.get('authBaseUrl').value = 'https://login.example.com'; p.get('authApplicationSlug').value = 'mcp';
    const discovery = p.run('discoverAuthentik(true)');
    p.get('tokenUrl').value = 'stale'; p.get('adminEmail').value = 'stale@example.com';
    p.get('authMethod').value = 'sakura'; await p.get('authMethod').fire('change');
    resolve(Response.json({ issuer: 'stale-issuer', tokenUrl: 'stale-token' })); await discovery;
    for (const id of ['issuer', 'tokenUrl', 'adminEmail', 'authBaseUrl', 'jwksUri', 'clientId']) expect(p.get(id).value).toBe('');
    expect(p.get('adminEmail').hidden).toBe(true); expect(p.get('adminEmailLabel').hidden).toBe(true);
    expect(p.get('discoverAuthentikButton').disabled).toBe(false);
    p.get('adminGroups').value = 'MCP Admins'; p.run('buildSummary()');
    expect(p.get('summary').textContent).toContain('Sakura 用户组：MCP Admins');
    p.get('authMethod').value = 'authentik'; await p.get('authMethod').fire('change');
    expect(p.get('adminEmailLabel').hidden).toBe(false);
  });
});
