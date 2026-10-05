import { Script, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { adminPage } from '../src/web/admin-page.js';
import { loginPage, localLoginPage } from '../src/web/login-page.js';
import { setupPage } from '../src/setup/page.js';
import { navigationHtml } from '../src/web/admin-navigation.js';
import { reducedMotionStyles } from '../src/web/design.js';

const pages = [adminPage, loginPage, localLoginPage, setupPage];

describe('shared UI presentation', () => {
  it.each(pages.map((html, index) => ({ html, index })))('includes motion opt-out and keyboard focus styles in page $index', ({ html }) => {
    expect(html).toContain(reducedMotionStyles);
    expect(html).toContain(':focus-visible');
    expect(html).toContain('@keyframes sakura-enter');
    expect(html).not.toMatch(/@import|<link[^>]+https?:|<script[^>]+https?:/);
    expect(html).not.toContain('backdrop-filter');
    expect(html).not.toContain('will-change');
    expect(html).not.toMatch(/\$\{(?:adminPolishStyles|loginPolishStyles|setupPolishStyles)\}/);
  });

  it('only loops the pending login spinner, not decorative background animations', () => {
    for (const html of pages) {
      const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
      const repeating = css.match(/animation:[^;}]*infinite/g) ?? [];
      for (const animation of repeating) expect(animation).toContain('sakura-spin');
    }
  });

  it('preserves every navigation target and hides administrator-only navigation initially', () => {
    const views = [...navigationHtml.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
    expect(views).toHaveLength(13);
    for (const view of views) expect(adminPage).toContain(`<section id="${view}"`);
    expect(navigationHtml.match(/aria-current="page"/g)).toHaveLength(1);
    expect(navigationHtml).toContain('id="authentikNav" style="display:none"');
    expect(navigationHtml).toContain('id="providerNav" style="display:none"');
    expect(navigationHtml.match(/aria-hidden="true" focusable="false"/g)).toHaveLength(13);
  });

  it('keeps About available to all users with only project metadata and safe links', () => {
    const button = navigationHtml.match(/<button[^>]*data-view="about"[^>]*>/)?.[0];
    expect(button).toBe('<button type="button" data-view="about">');
    const about = adminPage.match(/<section id="about">([\s\S]*?)<\/section>/)![1];
    expect(about).toContain('<h1>Sakura-MCP-Server</h1>');
    expect(about).toContain('id="aboutVersion"');
    expect(about).toContain('Sakura-License v1.2');
    expect(about).not.toMatch(/page-description|hero-mark|治理边界|pgvector|完整对话原文/);
    const links = [...about.matchAll(/<a href="([^"]+)"([^>]*)>/g)];
    expect(links.map(link => link[1])).toEqual([
      'https://github.com/Guyao146/Sakura-MCP-Server',
      'https://github.com/Guyao146/Sakura-MCP-Server/releases',
      'https://wiki.mcylyr.cn/',
      'https://github.com/Guyao146/Sakura-MCP-Server/blob/main/LICENSE',
      'https://github.com/Guyao146/Sakura-MCP-Server/blob/main/NOTICE.md',
      'https://github.com/Guyao146/Sakura-MCP-Server/issues'
    ]);
    for (const link of links) expect(link[2]).toContain('target="_blank" rel="noopener noreferrer"');
  });

  it.each([false, true])('renders the bootstrap version as text for admin=%s without changing privilege gates', async isSystemAdmin => {
    const elements = new Map<string, { textContent: string; style: { display: string } }>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { textContent: '', style: { display: '' } });
      return elements.get(id)!;
    };
    const version = '0.4.1-<img src=x onerror=alert(1)>';
    const api = vi.fn().mockResolvedValue({ csrf: 'csrf', version, authEnabled: true,
      me: { displayName: 'User', isSystemAdmin }, spaces: [], agents: [] });
    const loadProviders = vi.fn(), loadAuthentik = vi.fn(), loadSakura = vi.fn(), checkUpdate = vi.fn();
    const context = createContext({ $: element, api, location: { origin: 'https://mcp.example.com' },
      renderSpaces: vi.fn(), renderAgents: vi.fn(), checks: vi.fn(),
      loadProviders, loadAuthentik, loadSakura, checkUpdate });
    const script = adminPage.match(/^async function init\(\)[^\n]+/m)![0];
    await new Script('let state={};' + script + ';init()').runInContext(context);
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/admin/bootstrap');
    for (const id of ['aboutVersion', 'currentVersion', 'headerVersion']) {
      expect(element(id).textContent).toBe('v' + version);
      expect(element(id)).not.toHaveProperty('innerHTML');
    }
    for (const id of ['providerNav', 'authentikNav', 'updateBox']) {
      expect(element(id).style.display).toBe(isSystemAdmin ? 'block' : 'none');
    }
    for (const load of [loadProviders, loadAuthentik, loadSakura, checkUpdate]) {
      expect(load).toHaveBeenCalledTimes(isSystemAdmin ? 1 : 0);
    }
  });

  it('switches to About and back with exactly one active view and aria-current navigation', () => {
    const views = [...navigationHtml.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
    const node = (view: string) => {
      const classes = new Set(view === 'overview' ? ['active'] : []);
      const attributes = new Map(view === 'overview' ? [['aria-current', 'page']] : []);
      return { dataset: { view }, classList: classes, attributes, onclick: () => {},
        removeAttribute: (key: string) => attributes.delete(key),
        setAttribute: (key: string, value: string) => attributes.set(key, value) };
    };
    const buttons = views.map(node), sections = views.map(node);
    // Match the DOM classList API while retaining Set membership assertions.
    const domNodes = [...buttons, ...sections].map(item => ({ ...item,
      classList: { add: (name: string) => item.classList.add(name), remove: (name: string) => item.classList.delete(name) } }));
    const domButtons = domNodes.slice(0, buttons.length), domSections = domNodes.slice(buttons.length);
    const context = createContext({
      document: { querySelectorAll: (selector: string) => selector === 'nav button' ? domButtons : domNodes },
      $: (id: string) => domSections.find(section => section.dataset.view === id)
    });
    const script = adminPage.split('\n').find(line => line.startsWith("document.querySelectorAll('nav button').forEach"))!;
    new Script(script).runInContext(context);
    for (const target of ['about', 'overview', 'about']) {
      domButtons.find(button => button.dataset.view === target)!.onclick();
      expect(buttons.filter(button => button.classList.has('active')).map(button => button.dataset.view)).toEqual([target]);
      expect(sections.filter(section => section.classList.has('active')).map(section => section.dataset.view)).toEqual([target]);
      expect(buttons.filter(button => button.attributes.get('aria-current') === 'page').map(button => button.dataset.view)).toEqual([target]);
    }
  });

  it('keeps the latest toast visible when feedback arrives in quick succession', () => {
    const script = adminPage.match(/let toastTimer;function toast[^\n]+/)![0];
    const timers = new Map<number, () => void>(); let id = 0;
    const clear = vi.fn((timer: number) => timers.delete(timer));
    const element = { textContent: '', className: '' };
    const context = createContext({ $: () => element, clearTimeout: clear,
      setTimeout: (callback: () => void) => { timers.set(++id, callback); return id; } });
    new Script(script + ";toast('first');toast('latest',true)").runInContext(context);
    expect(timers.size).toBe(1);
    expect(element.textContent).toBe('latest');
    expect(element.className).toBe('toast show bad');
    expect(adminPage).toContain('role="status" aria-live="polite" aria-atomic="true"');
    [...timers.values()][0](); expect(element.className).toBe('toast');
  });
});
