import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { APP_VERSION, compareVersions, UpdateChecker } from '../src/version.js';

describe('application version and update checks', () => {
  it('uses the released semantic version and compares versions', () => {
    expect(APP_VERSION).toBe('0.4.1');
    expect(compareVersions('0.3.4', '0.3.3')).toBe(1);
    expect(compareVersions('0.3.4', '0.3.4')).toBe(0);
    expect(compareVersions('0.3.3', '0.3.4')).toBe(-1);
    expect(compareVersions('0.2.29', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
  });

  it('keeps the runtime version aligned with package metadata and deployment defaults', async () => {
    const [packageText, lockText, compose, environment] = await Promise.all([
      '../package.json', '../package-lock.json', '../docker-compose.yml', '../.env.example'
    ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
    const packageJson = JSON.parse(packageText) as { version: string };
    const lock = JSON.parse(lockText) as { version: string; packages: Record<string, { version: string }> };
    expect(APP_VERSION).toBe(packageJson.version);
    expect(lock.version).toBe(APP_VERSION);
    expect(lock.packages[''].version).toBe(APP_VERSION);
    for (const text of [compose, environment]) {
      expect(text).toContain(`ghcr.io/guyao146/sakura-mcp-server:${APP_VERSION}`);
    }
  });

  it('includes the adopted license and notice in both npm and container distributions', async () => {
    const [packageText, dockerfile, ignore] = await Promise.all([
      '../package.json', '../Dockerfile', '../.dockerignore'
    ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
    const packageJson = JSON.parse(packageText) as { files: string[] };
    expect(packageJson.files).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE.md']));
    const runtime = dockerfile.split(/FROM node:24-bookworm-slim\r?\n/)[1];
    expect(runtime).toContain('COPY LICENSE NOTICE.md ./');
    for (const file of ['LICENSE', 'NOTICE.md']) expect(ignore.split(/\r?\n/)).toContain('!' + file);
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