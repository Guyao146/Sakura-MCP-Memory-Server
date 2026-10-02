import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appWindowArgs, engineCandidates, findEngine, openPanelWindow, PanelWindow } from '../src/window.js';

function fakeChild() { return Object.assign(new EventEmitter(), { unref: vi.fn() }); }

describe('desktop panel window', () => {
  it('prefers Edge over Chrome on Windows and lists per-user installs too', () => {
    const candidates = engineCandidates(
      { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      'win32');
    expect(candidates[0]).toContain('msedge.exe');
    expect(candidates.some(path => path.includes('chrome.exe'))).toBe(true);
    expect(candidates.some(path => path.startsWith('C:\\Users\\me\\AppData\\Local'))).toBe(true);
    // No empty entries even when LOCALAPPDATA is absent.
    expect(engineCandidates({ ProgramFiles: 'C:\\PF' }, 'win32').every(Boolean)).toBe(true);
  });

  it('offers platform-appropriate candidates elsewhere', () => {
    expect(engineCandidates({}, 'darwin')[0]).toContain('Microsoft Edge.app');
    expect(engineCandidates({}, 'linux')).toContain('/usr/bin/google-chrome');
  });

  it('builds chromeless app-window arguments with an isolated profile', () => {
    const args = appWindowArgs('http://127.0.0.1:9000/?token=abc', 'C:\\data\\panel-profile', { width: 700, height: 800 });
    expect(args).toContain('--app=http://127.0.0.1:9000/?token=abc');
    expect(args).toContain('--user-data-dir=C:\\data\\panel-profile');
    expect(args).toContain('--window-size=700,800');
    expect(args).toContain('--no-first-run');
  });

  it('launches a detached app window when an engine exists', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const handle = openPanelWindow('http://127.0.0.1:1/?token=t', {
      engine: 'C:\\PF86\\msedge.exe', profileDir: 'C:\\p', spawnImpl: spawnImpl as never
    });
    expect(handle.mode).toBe('app-window');
    expect(handle.engine).toBe('C:\\PF86\\msedge.exe');
    expect(spawnImpl).toHaveBeenCalledWith('C:\\PF86\\msedge.exe', expect.arrayContaining(['--app=http://127.0.0.1:1/?token=t']),
      expect.objectContaining({ detached: true }));
    // Detached for an isolated process group, explicitly owned by PanelWindow.
    expect(child.unref).toHaveBeenCalled();
  });

  it('falls back to the default browser when no engine is installed', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const handle = openPanelWindow('http://127.0.0.1:1/?token=t', {
      engine: '', profileDir: 'C:\\p', spawnImpl: spawnImpl as never
    });
    expect(handle.mode).toBe('default-browser');
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalled();
  });

  it('reuses the owned window across repeated clicks and kills it only once', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const stop = vi.fn(async () => { child.emit('exit', 0); });
    const window = new PanelWindow({ engine: 'test-engine', spawnImpl: spawnImpl as never }, stop);
    const first = window.open('http://127.0.0.1/');
    for (let i = 0; i < 100; i++) expect(window.open('http://127.0.0.1/')).toBe(first);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    await Promise.all([window.close(), window.close()]);
    expect(stop).toHaveBeenCalledExactlyOnceWith(child, true);
    expect(child.listenerCount('exit')).toBe(0);
    expect(window.open('http://127.0.0.1/')).toBeUndefined();
  });

  it('releases an exited or failed window so it can be opened again', async () => {
    const children = [fakeChild(), fakeChild(), fakeChild()];
    const spawnImpl = vi.fn();
    children.forEach(child => spawnImpl.mockReturnValueOnce(child));
    const onError = vi.fn();
    const window = new PanelWindow({ engine: 'test-engine', spawnImpl: spawnImpl as never, onError },
      async () => { children[2].emit('exit', 0); });
    window.open('http://127.0.0.1/');
    children[0].emit('exit', 0);
    window.open('http://127.0.0.1/');
    children[1].emit('error', new Error('spawn failed'));
    expect(onError).toHaveBeenCalledTimes(1);
    window.open('http://127.0.0.1/');
    expect(spawnImpl).toHaveBeenCalledTimes(3);
    expect(children[0].listenerCount('exit')).toBe(0);
    expect(children[1].listenerCount('exit')).toBe(0);
    await window.close();
  });

  it('never terminates a user-owned default browser', async () => {
    const spawnImpl = vi.fn().mockReturnValue(fakeChild());
    const stop = vi.fn(async () => undefined);
    const window = new PanelWindow({ engine: '', spawnImpl: spawnImpl as never }, stop);
    expect(window.open('http://127.0.0.1/')?.mode).toBe('default-browser');
    await window.close();
    expect(stop).not.toHaveBeenCalled();
    expect(appWindowArgs('http://127.0.0.1/', 'profile')).toContain('--disable-background-mode');
  });

  it('returns undefined rather than throwing when nothing is found', () => {
    expect(findEngine(['C:\\definitely\\missing.exe'])).toBeUndefined();
  });
});
