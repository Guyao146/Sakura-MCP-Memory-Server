import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync, listTaskInventory } from '../src/sync.js';
import { normalizeConfig } from '../src/config.js';
import { loadCursors, saveCursors, type Cursors } from '../src/store.js';
import * as history from '../src/cline-store.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(messages: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'cline-cache-')); dirs.push(dir);
  await mkdir(join(dir, 'task'));
  const path = join(dir, 'task', 'api_conversation_history.json');
  await writeFile(path, JSON.stringify(messages));
  const config = normalizeConfig({ clineTasksDir: dir, maxTaskAgeDays: 0, redactSecrets: false });
  const extract = vi.fn(async (_text: string) => ({ ok: true }));
  const cursors: Cursors = {};
  const options = { client: { extractAndRemember: extract } as never, cursors, persist: false };
  return { dir, path, config, extract, cursors, options };
}
const message = (content: string) => ({ role: 'user', content });

describe('fully synchronized history metadata cache', () => {
  it('skips disk reads in scans and inventories, including after cursor reload', async () => {
    const f = await fixture([message('hello')]);
    const read = vi.spyOn(history, 'readMessages');
    await runSync(f.config, f.options);
    expect(read).toHaveBeenCalledTimes(1);
    await saveCursors(f.cursors, f.dir);
    const cursors = await loadCursors(f.dir);
    read.mockClear();
    expect((await runSync(f.config, { ...f.options, cursors })).skipped).toBe(1);
    expect((await listTaskInventory(f.config, { cursors }))[0]).toMatchObject({ messageCount: 1, pendingMessages: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(f.extract).toHaveBeenCalledTimes(1);
  });

  it('rereads appended and rolled-back histories instead of trusting the cache', async () => {
    const f = await fixture([message('first'), message('second')]);
    await runSync(f.config, f.options);
    await writeFile(f.path, JSON.stringify([message('first'), message('second'), message('third')]));
    await runSync(f.config, f.options);
    expect(f.extract.mock.calls[1][0]).toBe('user: third');
    await writeFile(f.path, JSON.stringify([message('restored')]));
    await runSync(f.config, f.options);
    expect(f.extract.mock.calls[2][0]).toBe('user: restored');
  });

  it('invalidates on same-sized rewrites even with restored mtime', async () => {
    const f = await fixture([message('before')]);
    await runSync(f.config, f.options);
    const info = await stat(f.path);
    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(f.path, JSON.stringify([message('after!')]));
    await utimes(f.path, info.atime, info.mtime);
    const read = vi.spyOn(history, 'readMessages');
    await runSync(f.config, f.options);
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not cache partial failures and revalidates changed partial-message hashes', async () => {
    const f = await fixture([message('x'.repeat(450000))]);
    f.extract.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false });
    expect((await runSync(f.config, f.options)).failed).toBe(1);
    expect(f.cursors.task.history).toBeUndefined();
    expect(f.cursors.task.messageOffset).toBe(200000);
    const changed = 'y'.repeat(450000);
    await writeFile(f.path, JSON.stringify([message(changed)]));
    f.extract.mockClear();
    await runSync(f.config, f.options);
    expect(f.extract.mock.calls.map(([text]) => text).join('')).toBe('user: ' + changed);
    expect(f.cursors.task.history).toBeDefined();
    expect(f.cursors.task.messageOffset).toBeUndefined();
  });

  it('does not certify a file changed during the read', async () => {
    const f = await fixture([message('old')]);
    const original = history.readMessages;
    vi.spyOn(history, 'readMessages').mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      await writeFile(f.path, JSON.stringify([message('old'), message('appended')]));
      return result;
    });
    await runSync(f.config, f.options);
    expect(f.cursors.task.history).toBeUndefined();
    await runSync(f.config, f.options);
    expect(f.extract.mock.calls[1][0]).toBe('user: appended');
  });

  it('avoids rereading 32 MiB across repeated scans of 64 unchanged histories', async () => {
    const f = await fixture([]);
    const size = 512 * 1024;
    const body = JSON.stringify([message('x'.repeat(size - JSON.stringify([message('')]).length))]);
    expect(Buffer.byteLength(body)).toBe(size);
    await rm(join(f.dir, 'task'), { recursive: true });
    for (let index = 0; index < 64; index++) {
      const id = `task-${index}`;
      await mkdir(join(f.dir, id));
      await writeFile(join(f.dir, id, 'api_conversation_history.json'), body);
      f.cursors[id] = { messageCount: 1, syncedAt: '2020-01-01T00:00:00Z' };
    }
    const read = vi.spyOn(history, 'readMessages');
    await runSync(f.config, f.options);
    expect(read).toHaveBeenCalledTimes(64); // Legacy cursors: 32 MiB read once to seed metadata.
    read.mockClear();
    for (let index = 0; index < 2; index++) expect((await runSync(f.config, f.options)).skipped).toBe(64);
    expect(await listTaskInventory(f.config, { cursors: f.cursors })).toHaveLength(64);
    expect(read).not.toHaveBeenCalled();
    expect(f.extract).not.toHaveBeenCalled();
  });

  it('upgrades legacy completed cursors with one read and no reupload', async () => {
    const f = await fixture([message('old')]);
    f.cursors.task = { messageCount: 1, syncedAt: '2020-01-01T00:00:00Z' };
    const read = vi.spyOn(history, 'readMessages');
    await runSync(f.config, f.options); await runSync(f.config, f.options);
    expect(read).toHaveBeenCalledOnce();
    expect(f.extract).not.toHaveBeenCalled();
    expect(f.cursors.task.syncedAt).toBe('2020-01-01T00:00:00Z');
  });
});
