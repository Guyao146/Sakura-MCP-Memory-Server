import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { APP_VERSION, compareVersions, UpdateChecker } from '../src/version.js';

describe('application version and update checks', () => {
  it('uses the released semantic version and compares versions', () => {
    expect(APP_VERSION).toBe('0.3.2');
    expect(compareVersions('0.3.2', '0.3.1')).toBe(1);
    expect(compareVersions('0.3.0', '0.2.29')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.2.29', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
  });

  it('keeps the runtime version aligned with package metadata', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it('checks the latest GitHub release and caches the result', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      tag_name: 'v0.3.0', published_at: '2026-08-27T00:00:00Z'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const checker = new UpdateChecker('0.2.23', 60_000, fetcher, () => 1_000);
    await expect(checker.check()).resolves.toMatchObject({
      currentVersion: '0.2.23', latestVersion: '0.3.0', updateAvailable: true,
      releaseUrl: 'https://github.com/Guyao146/Sakura-MCP-Server/releases/tag/v0.3.0'
    });
    await checker.check();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await checker.check(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid or unsuccessful release responses', async () => {
    const failed = new UpdateChecker('0.2.23', 60_000, vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(failed.check()).rejects.toThrow('503');
    const invalid = new UpdateChecker('0.2.23', 60_000, vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(invalid.check()).rejects.toThrow('version tag');
  });
});