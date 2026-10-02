import { describe, expect, it } from 'vitest';
import { emptyHistory, lastRunFinishedAt, loadHistory, recordRun } from '../src/history.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SyncSummary } from '../src/sync.js';

const summary = (synced: number, failed: number, messages: number): SyncSummary => ({
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:01:00Z',
  scanned: 1, synced, skipped: 0, failed,
  outcomes: [{ taskId: 't', status: 'synced', newMessages: messages }]
});

describe('sync history', () => {
  it('counts every chunk request, including failures, rather than completed tasks', () => {
    const run = { ...summary(1, 1, 4), extractionCalls: 5 };
    expect(recordRun(run).totals.extractions).toBe(5);
  });


  it('accumulates counters across runs', () => {
    const history = recordRun(summary(2, 0, 10), recordRun(summary(1, 1, 4), emptyHistory()));
    expect(history.totals).toEqual({ runs: 2, syncedTasks: 3, messages: 14, extractions: 3, failedTasks: 1 });
    expect(history.runs).toHaveLength(2);
  });

  it('counts only successfully uploaded messages, not skipped or failed ones', () => {
    const run = summary(1, 1, 4);
    run.outcomes.push({ taskId: 'failed', status: 'failed', newMessages: 10 },
      { taskId: 'skipped', status: 'skipped', newMessages: 1 });
    expect(recordRun(run).totals.messages).toBe(4);
  });

  it('caps the run log at 50 entries', () => {
    let history = emptyHistory();
    for (let i = 0; i < 60; i += 1) history = recordRun(summary(1, 0, 1), history);
    expect(history.runs).toHaveLength(50);
    expect(history.totals.runs).toBe(60);
  });

  it('reports when no run has happened yet', () => {
    expect(lastRunFinishedAt(emptyHistory())).toBeNull();
    expect(lastRunFinishedAt(recordRun(summary(1, 0, 1)))).toBe(Date.parse('2026-01-01T00:01:00Z'));
  });

  it('round-trips through disk and tolerates a corrupt or empty file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cline-sync-history-'));
    expect(await loadHistory(dir)).toEqual(emptyHistory());

    const saved = recordRun(summary(1, 0, 5), emptyHistory());
    await (await import('node:fs/promises')).writeFile(join(dir, 'history.json'), JSON.stringify(saved), 'utf8');
    const loaded = await loadHistory(dir);
    expect(loaded.totals.runs).toBe(1);
    expect(loaded.runs).toHaveLength(1);

    await (await import('node:fs/promises')).writeFile(join(dir, 'history.json'), '{not json', 'utf8');
    expect(await loadHistory(dir)).toEqual(emptyHistory());
  });
});
