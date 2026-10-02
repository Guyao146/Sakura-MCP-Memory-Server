import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../src/sync.js';
import { normalizeConfig } from '../src/config.js';
import { loadCursors, saveCursors } from '../src/store.js';
import { messageToText } from '../src/cline-store.js';
import type { McpClient } from '../src/mcp-client.js';

const message = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] });

const tempDirs: string[] = [];
afterEach(async () => { await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function makeTasksDir(tasks: Record<string, unknown[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cline-sync-run-'));
  tempDirs.push(root);
  for (const [taskId, messages] of Object.entries(tasks)) {
    const dir = join(root, taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api_conversation_history.json'), JSON.stringify(messages), 'utf8');
  }
  return root;
}

function fakeClient(): McpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    initialize: async () => undefined,
    extractAndRemember: async (text: string) => { calls.push(text); return { ok: true }; }
  } as unknown as McpClient & { calls: string[] };
}

describe('incremental sync', () => {
  it('persists each oversized-message chunk and resumes from disk after failure', async () => {
    const messages = [message('user', 'BEGIN-' + 'x'.repeat(450000) + '-END')];
    const dir = await makeTasksDir({ task: messages });
    const config = normalizeConfig({ clineTasksDir: dir, maxTaskAgeDays: 0, redactSecrets: false });
    const extract = vi.fn<McpClient['extractAndRemember']>()
      .mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, error: 'offline' });
    const persist = (cursors: Parameters<typeof saveCursors>[0]) => saveCursors(cursors, dir);
    const first = await runSync(config, { client: { extractAndRemember: extract } as never, cursors: {}, saveCursorsImpl: persist });
    expect(first.failed).toBe(1);
    expect(first.extractionCalls).toBe(2);
    const checkpoint = await loadCursors(dir);
    expect(checkpoint.task).toMatchObject({ messageCount: 0, messageOffset: 200000 });
    expect(checkpoint.task.messageHash).toHaveLength(64);
    const resumed = fakeClient();
    const second = await runSync(config, { client: resumed, cursors: checkpoint, saveCursorsImpl: persist });
    expect(second.synced).toBe(1);
    expect(extract.mock.calls[0][0] + resumed.calls.join('')).toBe(messageToText(messages[0]));
    expect(resumed.calls[0]).toBe(extract.mock.calls[1][0]);
    expect((await loadCursors(dir)).task).toMatchObject({ messageCount: 1 });
    expect((await loadCursors(dir)).task.messageOffset).toBeUndefined();
    await runSync(config, { client: resumed, cursors: await loadCursors(dir), saveCursorsImpl: persist });
    expect(resumed.calls).toHaveLength(2);
  });

  it('pushes only new messages and advances the cursor', async () => {
    const dir = await makeTasksDir({ '1700000000010': [message('user', 'first task detail'), message('assistant', 'first answer detail')] });
    const config = normalizeConfig({ mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', clineTasksDir: dir, maxTaskAgeDays: 0 });
    const client = fakeClient();
    const cursors = {};

    const first = await runSync(config, { client, cursors, persist: false });
    expect(first.synced).toBe(1);
    expect(client.calls).toHaveLength(1);

    // No new messages: the second run is a no-op.
    const second = await runSync(config, { client, cursors, persist: false });
    expect(second.synced).toBe(0);
    expect(second.skipped).toBe(1);
    expect(client.calls).toHaveLength(1);
  });

  it('re-syncs from scratch when a task is restored to fewer messages', async () => {
    const dir = await makeTasksDir({ '1700000000011': [message('user', 'a detail one'), message('assistant', 'b detail two')] });
    const config = normalizeConfig({ mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', clineTasksDir: dir, maxTaskAgeDays: 0 });
    const client = fakeClient();
    const cursors = { '1700000000011': { messageCount: 9, syncedAt: '2020-01-01T00:00:00Z' } };
    const summary = await runSync(config, { client, cursors, persist: false });
    expect(summary.synced).toBe(1);
    expect(client.calls[0]).toContain('a detail one');
  });

  it('keeps the cursor unchanged when the upload fails so the next run retries', async () => {
    const dir = await makeTasksDir({ '1700000000012': [message('user', 'x detail one'), message('assistant', 'y detail two')] });
    const config = normalizeConfig({ mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', clineTasksDir: dir, maxTaskAgeDays: 0 });
    const cursors = {};
    const failing = { extractAndRemember: async () => ({ ok: false, error: 'boom' }), initialize: async () => undefined } as unknown as McpClient;
    const summary = await runSync(config, { client: failing, cursors, persist: false });
    expect(summary.failed).toBe(1);
    expect(cursors).toEqual({});
  });

  it('persists completed cursors but not an interrupted upload, and stops before the next task', async () => {
    const messages = [message('user', 'task details'), message('assistant', 'answer details')];
    const dir = await makeTasksDir({ a: messages, b: messages, c: messages });
    const config = normalizeConfig({ clineTasksDir: dir, maxTaskAgeDays: 0 });
    const controller = new AbortController();
    const cursors = {};
    const save = vi.fn(async () => undefined);
    const extract = vi.fn<McpClient['extractAndRemember']>()
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async (_text, _space, _timeout, signal) => {
        expect(signal).toBe(controller.signal);
        controller.abort();
        throw signal!.reason;
      });
    const client = { extractAndRemember: extract } as unknown as McpClient;
    const result = await runSync(config, { client, cursors, signal: controller.signal, saveCursorsImpl: save });
    expect(result.cancelled).toBe(true);
    expect(result.synced).toBe(1);
    expect(result.failed).toBe(0);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(Object.keys(cursors)).toHaveLength(1);
    expect(save).toHaveBeenCalledWith(cursors);
    expect(cursors).toHaveProperty(result.outcomes[0].taskId);
  });

  it('does not scan or upload when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = fakeClient();
    await expect(runSync(normalizeConfig({}), { client, cursors: {}, persist: false,
      signal: controller.signal })).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });

  it('skips tasks older than the configured age window', async () => {
    const dir = await makeTasksDir({ '1700000000013': [message('user', 'old task one'), message('assistant', 'old task two')] });
    const config = normalizeConfig({ mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', clineTasksDir: dir, maxTaskAgeDays: 1 });
    const client = fakeClient();
    // now = far in the future so the freshly written file is "old".
    const summary = await runSync(config, { client, cursors: {}, persist: false, now: () => Date.now() + 10 * 86_400_000 });
    expect(summary.skipped).toBe(1);
    expect(client.calls).toHaveLength(0);
  });
});
