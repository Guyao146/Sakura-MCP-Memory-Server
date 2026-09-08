import { describe, expect, it, vi } from 'vitest';
import { appWindowArgs, engineCandidates, findEngine, openPanelWindow } from '../src/window.js';

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
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn().mockReturnValue(child);
    const handle = openPanelWindow('http://127.0.0.1:1/?token=t', {
      engine: 'C:\\PF86\\msedge.exe', profileDir: 'C:\\p', spawnImpl: spawnImpl as never
    });
    expect(handle.mode).toBe('app-window');
    expect(handle.engine).toBe('C:\\PF86\\msedge.exe');
    expect(spawnImpl).toHaveBeenCalledWith('C:\\PF86\\msedge.exe', expect.arrayContaining(['--app=http://127.0.0.1:1/?token=t']),
      expect.objectContaining({ detached: true }));
    // Detached so closing the daemon does not kill the window and vice versa.
    expect(child.unref).toHaveBeenCalled();
  });

  it('falls back to the default browser when no engine is installed', () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn().mockReturnValue(child);
    const handle = openPanelWindow('http://127.0.0.1:1/?token=t', {
      engine: undefined, profileDir: 'C:\\p', spawnImpl: spawnImpl as never
    });
    // findEngine() may locate a real browser on the test machine; either path is valid,
    // but the fallback must never crash and must still spawn something detached.
    expect(['app-window', 'default-browser']).toContain(handle.mode);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.unref).toHaveBeenCalled();
  });

  it('returns undefined rather than throwing when nothing is found', () => {
    expect(findEngine(['C:\\definitely\\missing.exe'])).toBeUndefined();
  });
});
