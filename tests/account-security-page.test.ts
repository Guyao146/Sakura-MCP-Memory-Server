import { Script, createContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { accountSecurityHtml, accountSecurityScript } from '../src/web/account-security-page.js';

function page(admin = true, authEnabled = true) {
  class Element {
    value = ''; textContent = ''; innerHTML = ''; className = ''; checked = false; disabled = false; required = false;
    style: Record<string, string> = {}; children: Element[] = [];
    classList = { add: vi.fn() }; append(...children: Element[]) { this.children.push(...children); }
  }
  const elements = new Map([...accountSecurityHtml.matchAll(/id="([^"]+)"/g)].map(m => [m[1], new Element()]));
  const get = (id: string) => { if (!elements.has(id)) throw new Error('Unknown element ' + id); return elements.get(id)!; };
  const user = { username: 'owner', displayName: '<img src=x onerror=alert(1)>', email: null, isSystemAdmin: true, failedAttempts: 0, lockedUntil: new Date(0).toISOString() };
  const api = vi.fn(async (path: string, _options?: { method: string; body?: string }) => path === '/api/me/sessions'
    ? { sessions: [{ id: 'session', current: true, authSource: 'local', createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date() }] }
    : path === '/api/admin/local-users' ? { users: [user] } : { redirectTo: '/auth/local-login' });
  const toast = vi.fn(); const confirm = vi.fn(() => true);
  const context = createContext({ $: get, document: { createElement: () => new Element() },
    state: { authEnabled, localLogin: true, me: { isSystemAdmin: admin, authSource: 'local' } },
    api, toast, confirm, closeDialogs: vi.fn(), init: vi.fn(), location: '' });
  new Script(accountSecurityScript).runInContext(context);
  return { get, api, toast, context, user, run: (code: string) => new Script(code).runInContext(context) };
}

describe('account security shipped UI', () => {
  it('emits a valid modern HTML username pattern', () => {
    const pattern = /pattern="([^"]+)"/.exec(accountSecurityHtml)![1];
    const regex = new RegExp('^(?:' + pattern + ')$', 'v');
    expect(regex.test('valid-name_123')).toBe(true);
    expect(regex.test('invalid name')).toBe(false);
  });
  it('renders untrusted profile data as text and loads admin controls only for admins', async () => {
    const p = page(); await p.run('loadSecurity()');
    expect(p.get('localUserList').children[0].children[0].children[0].textContent).toContain('<img');
    expect(p.get('localUserList').children[0].children[0].children[0].innerHTML).toBe('');
    const user = page(false); await user.run('loadSecurity()');
    expect(user.get('localAccountAdmin').style.display).toBe('none');
    expect(user.api.mock.calls.map(c => c[0])).toEqual(['/api/me/sessions']);
    const open = page(true, false); await open.run('loadSecurity()');
    expect(open.get('selfSecurity').style.display).toBe('none');
    expect(open.api.mock.calls.map(c => c[0])).toEqual(['/api/admin/local-users']);
  });
  it('separates session metadata and current / locked badges without relying on color alone', async () => {
    const p = page(); p.user.lockedUntil = new Date(Date.now() + 60_000).toISOString();
    await p.run('loadSecurity()');
    const session = p.get('webSessionList').children[0];
    expect(session.className).toContain('current-session');
    const [title, meta] = session.children[0].children;
    expect(title.textContent).toBe('本地账号会话');
    expect(title.children[0].textContent).toBe('当前会话');
    expect(meta.children).toHaveLength(3);
    expect(meta.children[1].textContent).toContain('最近活动');
    const accountTitle = p.get('localUserList').children[0].children[0].children[0];
    expect(accountTitle.children.map(child => child.textContent)).toEqual(['管理员', '已锁定']);
    expect(accountTitle.children[1].className).toContain('locked');
  });
  it('shows explicit empty states for accounts and sessions', async () => {
    const p = page(); p.api.mockImplementation(async path => path === '/api/me/sessions' ? { sessions: [] } : { users: [] });
    await p.run('loadSecurity()');
    expect(p.get('webSessionList').children[0].textContent).toBe('暂无有效会话。');
    expect(p.get('localUserList').children[0].className).toBe('security-empty');
  });
  it('validates confirmation then submits password change and clears secrets', async () => {
    const p = page(); p.get('currentPassword').value = 'old-password'; p.get('newPassword').value = 'new-password';
    await p.run('changeOwnPassword()'); expect(p.api).not.toHaveBeenCalled();
    p.get('confirmPassword').value = 'new-password'; await p.run('changeOwnPassword()');
    expect(p.api).toHaveBeenCalledWith('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password' }) });
    expect(p.context.location).toBe('/auth/local-login'); expect(p.get('currentPassword').value).toBe('');
    expect(p.get('changePasswordButton').disabled).toBe(false);
  });
  it('separates profile editing from password reset and rejects duplicate creation', async () => {
    const p = page(); await p.run('loadSecurity();');
    p.run("openLocalAccount(localAccounts[0],'edit')");
    expect(p.get('accountPassword').required).toBe(false); expect(p.get('accountUsername').disabled).toBe(true);
    await p.run('saveLocalAccount()');
    expect(p.api.mock.calls.find(c => c[1]?.method === 'PATCH')?.[1]?.body).not.toContain('password');
    p.run("openLocalAccount(localAccounts[0],'reset')"); p.get('accountPassword').value = 'reset-password';
    await p.run('saveLocalAccount()');
    expect(p.api).toHaveBeenCalledWith('/api/admin/local-users/owner', { method: 'PUT', body: '{"password":"reset-password"}' });
    expect(p.get('accountPassword').value).toBe('');
    p.api.mockClear(); p.run('openLocalAccount()'); p.get('accountUsername').value = 'OWNER';
    await p.run('saveLocalAccount()'); expect(p.api).not.toHaveBeenCalled();
  });
});
