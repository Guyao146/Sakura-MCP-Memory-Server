import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { APP_VERSION, compareVersions, UpdateChecker } from '../src/version.js';

describe('application version and update checks', () => {
  it('uses the released semantic version and compares versions', () => {
    expect(APP_VERSION).toBe('0.5.1');
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
      expect(text).toContain(`ghcr.io/guyao146/sakura-mcp-memory-server:${APP_VERSION}`);
    }
  });

  it('aligns the renamed product across release, runtime, deployment and documentation channels', async () => {
    const files = ['../package.json','../package-lock.json','../src/tools.ts','../src/index.ts',
      '../src/version.ts','../NOTICE.md','../README.md','../.github/workflows/container.yml'];
    const text = await Promise.all(files.map(file => readFile(new URL(file, import.meta.url), 'utf8')));
    const metadata = JSON.parse(text[0]);
    const lock = JSON.parse(text[1]);
    expect(metadata.name).toBe('sakura-mcp-memory-server');
    expect(lock.name).toBe(metadata.name);
    expect(lock.packages[''].name).toBe(metadata.name);
    expect(metadata.repository.url).toBe('git+https://github.com/Guyao146/Sakura-MCP-Memory-Server.git');
    expect(text[2]).toContain("name: 'Sakura-MCP-Memory-Server'");
    expect(text[3]).toContain("service: 'Sakura-MCP-Memory-Server'");
    expect(text[7]).toContain('ghcr.io/guyao146/sakura-mcp-memory-server');
    for (const source of text) expect(source).not.toMatch(/Sakura-MCP-Server|sakura-mcp-server/);
  });

  it('keeps legacy data migration fail-closed without changing authentication identifiers', async () => {
    const [compose, legacy, auth, migration] = await Promise.all([
      '../docker-compose.yml','../docker-compose.legacy-data.yml','../src/auth.ts','../docs/rename-migration.md'
    ].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
    expect(compose).toContain('SAKURA_MCP_MEMORY_IMAGE:-${SAKURA_MCP_IMAGE:-');
    expect(compose).toContain('sakura-mcp-memory:');
    expect(legacy.match(/external: true/g)).toHaveLength(2);
    expect(legacy).toContain('SAKURA_MEMORY_POSTGRES_VOLUME:-sakura-mcp-server_postgres-data');
    expect(legacy).toContain('SAKURA_MEMORY_SECRETS_VOLUME:-sakura-mcp-server_runtime-secrets');
    expect(auth).toContain("credential.startsWith('sk_sakura_')");
    expect(migration).toContain('OIDC issuer');
    expect(migration).toContain('docker compose stop');
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
      releaseUrl: 'https://github.com/Guyao146/Sakura-MCP-Memory-Server/releases/tag/v0.3.0'
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