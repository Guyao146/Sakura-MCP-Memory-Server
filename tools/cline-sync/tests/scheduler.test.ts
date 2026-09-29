import { describe, expect, it } from 'vitest';
import type { SyncSummary } from '../src/sync.js';
import { SyncScheduler } from '../src/scheduler.js';
import { emptyHistory } from '../src/history.js';
import { normalizeConfig } from '../src/config.js';

const baseConfig = () => normalizeConfig({
  mcpUrl: 'https://mcp.example.com/mcp', token: 'sk_sakura_x', enabled: true, intervalMinutes: 10
});

function summary(failed: number, synced: number): SyncSummary {
  return {
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
    scanned: 1, synced, skipped: 0, failed,
    outcomes: []
  };
}

/** A sync entry point the test drives directly: no disk, no network. */
function scriptedSync(planned: SyncSummary[]): { impl: typeof import('../src/sync.js').runSync; calls: number } {
  const calls = { current: 0 };
  const impl = async () => planned[Math.min(calls.current, planned.length - 1)] as SyncSummary;
  return { impl: impl as never, calls: calls as never };
}

describe('circuit breaker', () => {
  it('halts after three consecutive total failures', async () => {
    const failing = Array.from({ length: 3 }, () => summary(1, 0));
    const { impl } = scriptedSync(failing);
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: impl });
    expect(scheduler.status().halted).toBe(false);

    await scheduler.runOnce();
    await scheduler.runOnce();
    await scheduler.runOnce();

    const status = scheduler.status();
    expect(status.halted).toBe(true);
    expect(status.lastResult).toContain('已自动暂停');
    expect(status.history.totals.runs).toBe(3);
  });

  it('a single failing task does not trip the breaker', async () => {
    const { impl } = scriptedSync([summary(1, 1)]);
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: impl });
    await scheduler.runOnce();
    expect(scheduler.status().halted).toBe(false);
  });

  it('a success resets the failure streak', async () => {
    const { impl } = scriptedSync([summary(1, 0), summary(0, 1)]);
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: impl });
    await scheduler.runOnce();
    await scheduler.runOnce();
    expect(scheduler.status().halted).toBe(false);
  });

  it('resume clears the halt and reschedules', async () => {
    const failing = Array.from({ length: 3 }, () => summary(1, 0));
    const { impl } = scriptedSync(failing);
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: impl });
    for (let i = 0; i < 3; i += 1) await scheduler.runOnce();
    expect(scheduler.status().halted).toBe(true);

    scheduler.resume();
    expect(scheduler.status().halted).toBe(false);
    expect(scheduler.status().nextRunAt).not.toBeNull();

    // A recovered run after resume does not re-halt immediately.
    const recovered = scriptedSync([summary(0, 1)]);
    const restored = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: recovered.impl });
    await restored.runOnce();
    expect(restored.status().halted).toBe(false);
  });
});

describe('startup behaviour', () => {
  it('records every run in the persisted history', async () => {
    const { impl } = scriptedSync([summary(0, 2)]);
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { runSyncImpl: impl });
    await scheduler.runOnce();
    const totals = scheduler.status().history.totals;
    expect(totals.syncedTasks).toBe(2);
    expect(totals.extractions).toBe(2);
  });

  it('restores lastRunAt from the loaded history', async () => {
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const history = {
      ...emptyHistory(),
      runs: [{ startedAt: longAgo, finishedAt: longAgo, scanned: 1, synced: 1, skipped: 0, failed: 0, messages: 2 }]
    };
    const scheduler = new SyncScheduler(baseConfig(), () => undefined, { history });
    expect(scheduler.status().lastRunAt).not.toBeNull();
  });
});
