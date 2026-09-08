import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, taskFilterReason } from '../src/config.js';
import { listTaskInventory, runSync } from '../src/sync.js';
import type { McpClient } from '../src/mcp-client.js';

const message = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] });

async function makeTasksDir(tasks: Record<string, unknown[]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cline-select-'));
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

const base = { mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', maxTaskAgeDays: 0 };

describe('task selection', () => {
  it('normalizes the mode and de-duplicates the id list', () => {
    const config = normalizeConfig({ selectionMode: 'weird' as never, selectedTasks: ['a', 'a', ' b ', '', 7 as never] });
    expect(config.selectionMode).toBe('all');
    expect(config.selectedTasks).toEqual(['a', 'b']);
  });

  it('applies the age window before the selection', () => {
    const now = 1_000_000_000_000;
    const config = normalizeConfig({ ...base, maxTaskAgeDays: 1, selectionMode: 'include', selectedTasks: ['old'] });
    // Selected but outside the window: the window wins.
    expect(taskFilterReason(config, 'old', now - 5 * 86_400_000, now)).toBe('超出时间范围');
    expect(taskFilterReason(config, 'old', now, now)).toBeUndefined();
  });

  it('include mode syncs only the listed tasks', () => {
    const config = normalizeConfig({ ...base, selectionMode: 'include', selectedTasks: ['keep'] });
    expect(taskFilterReason(config, 'keep', 0, 0)).toBeUndefined();
    expect(taskFilterReason(config, 'other', 0, 0)).toBe('未在同步列表中');
  });

  it('exclude mode syncs everything but the listed tasks', () => {
    const config = normalizeConfig({ ...base, selectionMode: 'exclude', selectedTasks: ['drop'] });
    expect(taskFilterReason(config, 'drop', 0, 0)).toBe('已排除');
    expect(taskFilterReason(config, 'other', 0, 0)).toBeUndefined();
  });

  it('an empty include list selects nothing rather than everything', () => {
    const config = normalizeConfig({ ...base, selectionMode: 'include', selectedTasks: [] });
    expect(taskFilterReason(config, 'anything', 0, 0)).toBe('未在同步列表中');
  });

  it('runSync honours the selection', async () => {
    const dir = await makeTasksDir({
      '1700000000100': [message('user', 'first detail one'), message('assistant', 'first detail two')],
      '1700000000200': [message('user', 'second detail one'), message('assistant', 'second detail two')]
    });
    const config = normalizeConfig({ ...base, clineTasksDir: dir, selectionMode: 'include', selectedTasks: ['1700000000200'] });
    const client = fakeClient();
    const summary = await runSync(config, { client, cursors: {}, persist: false });
    expect(summary.synced).toBe(1);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toContain('second detail one');
    expect(summary.outcomes.find(o => o.taskId === '1700000000100')?.reason).toBe('未在同步列表中');
  });

  it('reports pending counts and window state so the panel can show cost', async () => {
    const dir = await makeTasksDir({
      '1700000000300': [message('user', 'a one'), message('assistant', 'b two'), message('user', 'c three')]
    });
    const config = normalizeConfig({ ...base, clineTasksDir: dir });
    const fresh = await listTaskInventory(config, { cursors: {} });
    expect(fresh[0]).toMatchObject({ taskId: '1700000000300', messageCount: 3, pendingMessages: 3, outOfWindow: false, selected: true });
    expect(fresh[0].syncedAt).toBeNull();

    const partial = await listTaskInventory(config, {
      cursors: { '1700000000300': { messageCount: 2, syncedAt: '2020-01-01T00:00:00Z' } }
    });
    expect(partial[0].pendingMessages).toBe(1);
    expect(partial[0].syncedAt).toBe('2020-01-01T00:00:00Z');

    const windowed = normalizeConfig({ ...base, clineTasksDir: dir, maxTaskAgeDays: 1 });
    const old = await listTaskInventory(windowed, { cursors: {}, now: () => Date.now() + 10 * 86_400_000 });
    expect(old[0]).toMatchObject({ outOfWindow: true, selected: false, skipReason: '超出时间范围' });
  });
});
