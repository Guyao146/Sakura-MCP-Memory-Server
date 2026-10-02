import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';

/**
 * Registers the executable to start when the user logs in, per platform:
 *  - Windows: a value under HKCU\...\Run, written through reg.exe
 *  - macOS: a LaunchAgent plist in ~/Library/LaunchAgents
 *  - Linux: an XDG autostart .desktop file
 *
 * Only the packaged executable is worth registering: from source the entry
 * point depends on the working directory and on node being on PATH, so the
 * tray only offers this toggle when running as a single-file build.
 */

const NAME = 'SakuraClineSync';
const LABEL = 'org.sakura.cline-sync';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

export interface AutostartOptions {
  platform?: NodeJS.Platform;
  /** Path to register. Defaults to the running executable. */
  executable?: string;
  /** Injected by tests so no real registry entry is touched. */
  spawnImpl?: typeof spawn;
  /** Home directory for the macOS/Linux entries. */
  home?: string;
}

function executablePath(options: AutostartOptions): string {
  return options.executable ?? process.execPath;
}

function homeDir(options: AutostartOptions): string {
  return options.home ?? homedir();
}

function macosPlistPath(options: AutostartOptions): string {
  return join(homeDir(options), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function linuxDesktopPath(options: AutostartOptions): string {
  return join(homeDir(options), '.config', 'autostart', 'sakura-cline-sync.desktop');
}

/** Runs `reg.exe` and collects its output; returns the exit code. */
function reg(args: string[], spawnImpl: typeof spawn): Promise<{ code: number | null; stdout: string }> {
  const child = spawnImpl('reg', args, { windowsHide: true, timeout: 5000, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
  return new Promise(resolve => {
    child.on('error', () => resolve({ code: 1, stdout }));
    child.on('close', code => resolve({ code: code ?? 1, stdout }));
  });
}

function macosPlist(executable: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '  <key>Label</key><string>' + LABEL + '</string>',
    '  <key>ProgramArguments</key><array><string>' + executable + '</string></array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict></plist>'
  ].join('\n');
}

function linuxDesktop(executable: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Sakura Cline Sync',
    'Comment=Sync Cline task history into Sakura-MCP-Server',
    'Exec=' + executable,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n');
}

export async function enableAutostart(options: AutostartOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const executable = executablePath(options);
  if (platform === 'win32') {
    const { code } = await reg(['add', RUN_KEY, '/v', NAME, '/t', 'REG_SZ', '/d', executable, '/f'],
      options.spawnImpl ?? spawn);
    if (code !== 0) throw new Error(`写入注册表失败（退出码 ${code}）`);
    return;
  }
  const path = platform === 'darwin' ? macosPlistPath(options) : linuxDesktopPath(options);
  await mkdir(join(path, '..'), { recursive: true });
  const body = platform === 'darwin' ? macosPlist(executable) : linuxDesktop(executable);
  await writeFile(path, body + '\n', 'utf8');
}

export async function disableAutostart(options: AutostartOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const { code } = await reg(['delete', RUN_KEY, '/v', NAME, '/f'], options.spawnImpl ?? spawn);
    // 1 = the value was not there to begin with, which is not an error here.
    if (code !== 0 && code !== 1) throw new Error(`删除注册表项失败（退出码 ${code}）`);
    return;
  }
  const path = platform === 'darwin' ? macosPlistPath(options) : linuxDesktopPath(options);
  await unlink(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

export async function isAutostartEnabled(options: AutostartOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  const executable = executablePath(options);
  if (platform === 'win32') {
    const { code, stdout } = await reg(['query', RUN_KEY, '/v', NAME], options.spawnImpl ?? spawn);
    return code === 0 && stdout.includes(NAME) && stdout.includes(executable);
  }
  const path = platform === 'darwin' ? macosPlistPath(options) : linuxDesktopPath(options);
  try {
    const body = await readFile(path, 'utf8');
    return body.includes(executable);
  } catch {
    return false;
  }
}

/** Platform-native description of the registration, for logging and tests. */
export function autostartLocation(options: AutostartOptions = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return `${RUN_KEY}\\${NAME}`;
  return platform === 'darwin' ? macosPlistPath(options) : linuxDesktopPath(options);
}
