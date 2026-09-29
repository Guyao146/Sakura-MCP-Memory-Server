import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autostartLocation, disableAutostart, enableAutostart, isAutostartEnabled } from '../src/autostart.js';

/**
 * Windows: reg.exe is faked so no real registry value is written. The recorder
 * asserts the exact arguments and answers with a chosen exit code.
 */
function fakeReg(code: number, stdout = ''): { spawnImpl: typeof spawn; calls: string[][] } {
  const calls: string[][] = [];
  const spawnImpl = ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const events = new EventEmitter();
    process.nextTick(() => {
      if (stdout) events.emit('data', Buffer.from(stdout));
      events.emit('close', code);
    });
    // reg() reads `child.stdout` as an EventEmitter.
    return Object.assign(events, { stdout: events });
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

describe('autostart (windows)', () => {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

  it('writes the Run value with reg.exe and reads it back', async () => {
    const writer = fakeReg(0);
    const exe = 'C:\\app\\cline-sync.exe';
    await enableAutostart({ platform: 'win32', executable: exe, spawnImpl: writer.spawnImpl });
    expect(writer.calls[0]).toEqual(['reg', 'add', key, '/v', 'SakuraClineSync', '/t', 'REG_SZ', '/d', exe, '/f']);

    const probe = fakeReg(0, `    ${'SakuraClineSync'}    REG_SZ    ${exe}`);
    expect(await isAutostartEnabled({ platform: 'win32', executable: exe, spawnImpl: probe.spawnImpl })).toBe(true);
    expect(probe.calls[0]).toEqual(['reg', 'query', key, '/v', 'SakuraClineSync']);
  });

  it('reports disabled when the value or the path differs', async () => {
    const probe = fakeReg(0, '    SakuraClineSync    REG_SZ    C:\\other.exe');
    expect(await isAutostartEnabled({ platform: 'win32', executable: 'C:\\app\\cline-sync.exe', spawnImpl: probe.spawnImpl }))
      .toBe(false);
    expect(await isAutostartEnabled({ platform: 'win32', executable: 'C:\\app\\x.exe', spawnImpl: fakeReg(1).spawnImpl }))
      .toBe(false);
  });

  it('refuses to start when reg.exe fails', async () => {
    await expect(enableAutostart({ platform: 'win32', executable: 'C:\\app\\x.exe', spawnImpl: fakeReg(5).spawnImpl }))
      .rejects.toThrow('写入注册表失败');
  });

  it('treats a missing Run value as already disabled', async () => {
    await expect(disableAutostart({ platform: 'win32', executable: 'C:\\app\\x.exe', spawnImpl: fakeReg(1).spawnImpl }))
      .resolves.toBeUndefined();
    await expect(disableAutostart({ platform: 'win32', executable: 'C:\\app\\x.exe', spawnImpl: fakeReg(9).spawnImpl }))
      .rejects.toThrow('删除注册表项失败');
  });
});

describe('autostart (posix)', () => {
  it('writes a LaunchAgent on macOS and removes it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-sync-home-'));
    const options = { platform: 'darwin' as const, executable: '/Applications/sakura.app/Contents/MacOS/app', home };
    await enableAutostart(options);
    const path = autostartLocation(options);
    expect(path).toBe(join(home, 'Library', 'LaunchAgents', 'org.sakura.cline-sync.plist'));
    const body = await readFile(path, 'utf8');
    expect(body).toContain('<key>Label</key><string>org.sakura.cline-sync</string>');
    expect(body).toContain('<key>RunAtLoad</key><true/>');
    expect(await isAutostartEnabled(options)).toBe(true);
    await disableAutostart(options);
    expect(await isAutostartEnabled(options)).toBe(false);
    // Removing when already removed is not an error.
    await expect(disableAutostart(options)).resolves.toBeUndefined();
  });

  it('writes an XDG .desktop file on linux', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cline-sync-home-'));
    const options = { platform: 'linux' as const, executable: '/opt/sakura/cline-sync', home };
    await enableAutostart(options);
    const path = autostartLocation(options);
    expect(path).toBe(join(home, '.config', 'autostart', 'sakura-cline-sync.desktop'));
    const body = await readFile(path, 'utf8');
    expect(body).toContain('Exec=/opt/sakura/cline-sync');
    expect(body).toContain('Type=Application');
    expect(await isAutostartEnabled(options)).toBe(true);
    await disableAutostart(options);
    expect(await isAutostartEnabled(options)).toBe(false);
  });
});
