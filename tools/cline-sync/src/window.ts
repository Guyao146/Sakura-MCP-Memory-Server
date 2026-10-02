import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config.js';
import { stopChild } from './lifecycle.js';

/**
 * Opens the config panel as a chromeless desktop window using the browser engine
 * already installed on the machine (Edge/WebView2 on Windows, Chrome elsewhere)
 * in `--app` mode. This gives a native-feeling window without bundling Electron:
 * the executable stays the same size and there is no native dependency to build.
 *
 * A dedicated profile directory keeps the window out of the user's normal browser
 * session, so the panel token never lands in their history and an existing browser
 * window cannot swallow the launch.
 *
 * Falls back to the default browser when no suitable engine is found; the panel is
 * plain HTML, so it works either way.
 */

export interface WindowHandle {
  /** The launched process, if a dedicated app window was opened. */
  process?: ChildProcess;
  mode: 'app-window' | 'default-browser';
  engine?: string;
}

/** Candidate engines, most preferred first. */
export function engineCandidates(env = process.env, platform = process.platform): string[] {
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA ?? '';
    return [
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
      localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ];
  }
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

export function findEngine(candidates = engineCandidates()): string | undefined {
  return candidates.find(candidate => existsSync(candidate));
}

/** Arguments that turn a Chromium binary into a single-purpose app window. */
export function appWindowArgs(url: string, profileDir: string, size = { width: 780, height: 900 }): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${size.width},${size.height}`,
    // Keep the throwaway profile quiet and self-contained.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-networking',
    '--disable-background-mode'
  ];
}

export function openPanelWindow(url: string, options: {
  engine?: string; profileDir?: string; spawnImpl?: typeof spawn; onError?: (error: Error) => void;
} = {}): WindowHandle {
  const engine = options.engine ?? findEngine();
  const launch = options.spawnImpl ?? spawn;
  const profileDir = options.profileDir ?? join(dataDir(), 'panel-profile');
  if (engine) {
    const child = launch(engine, appWindowArgs(url, profileDir), { detached: true, stdio: 'ignore' });
    child.once('error', options.onError ?? (() => undefined));
    child.unref();
    return { process: child, mode: 'app-window', engine };
  }
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  const child = launch(command, args, { detached: true, stdio: 'ignore' });
  child.once('error', options.onError ?? (() => undefined));
  child.unref();
  return { mode: 'default-browser' };
}

/** Repeated tray clicks reuse the owned window rather than spawning more browsers. */
export class PanelWindow {
  private handle?: WindowHandle;
  private closed = false;
  private closing?: Promise<void>;

  constructor(private readonly options: Parameters<typeof openPanelWindow>[1] = {},
    private readonly stop = stopChild) {}

  open(url: string): WindowHandle | undefined {
    if (this.closed) return undefined;
    if (this.handle) return this.handle;
    const handle = openPanelWindow(url, this.options);
    if (handle.process) {
      this.handle = handle;
      const release = () => {
        if (this.handle === handle) this.handle = undefined;
        handle.process!.removeListener('exit', release);
        handle.process!.removeListener('error', release);
      };
      handle.process.once('exit', release);
      handle.process.once('error', release);
    }
    // Default browser is user-owned: do not retain or terminate it.
    return handle;
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const child = this.handle?.process;
      this.handle = undefined;
      this.closing = child ? this.stop(child, true) : Promise.resolve();
    }
    return this.closing;
  }
}
