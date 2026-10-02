import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncScheduler } from '../src/scheduler.js';
import { normalizeConfig } from '../src/config.js';
import { emptyHistory } from '../src/history.js';
import type { runSync, SyncSummary } from '../src/sync.js';

const config = normalizeConfig({ mcpUrl: 'http://127.0.0.1/mcp', token: 'test', enabled: true, intervalMinutes: 1 });
const result: SyncSummary = { startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
  scanned: 0, synced: 0, skipped: 0, failed: 0, outcomes: [] };
const schedulers: SyncScheduler[] = [];
function create(impl: typeof runSync, history = emptyHistory()) {
  const save = vi.fn(async () => undefined);
  const scheduler = new SyncScheduler(config, () => undefined, { runSyncImpl: impl, history, saveHistoryImpl: save });
  schedulers.push(scheduler);
  return { scheduler, save };
}
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(s => s.close()));
  vi.useRealTimers();
});
function waiting() {
  let signal: AbortSignal;
  const impl = vi.fn<typeof runSync>((_config, options) => new Promise((_resolve, reject) => {
    signal = options!.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  return { impl, get signal() { return signal; } };
}

describe('scheduler resource lifecycle', () => {
  it('never overlaps or queues ticks while a request is stalled', async () => {
    vi.useFakeTimers();
    const pending = waiting();
    const { scheduler } = create(pending.impl);
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await Promise.all(Array.from({ length: 100 }, () => scheduler.runOnce()));
    expect(pending.impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.close();
    expect(pending.signal.aborted).toBe(true);
    expect(scheduler.status().running).toBe(false);
    scheduler.start();
    scheduler.restart();
    await scheduler.runOnce();
    expect(pending.impl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels the old config before allowing another run and retains just one timer', async () => {
    vi.useFakeTimers();
    const pending = waiting();
    const { scheduler } = create(pending.impl);
    scheduler.start();
    const firstSignal = pending.signal;
    for (let i = 0; i < 50; i++) scheduler.updateConfig({ ...config, token: 'new' });
    expect(firstSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.status().running).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending.impl).toHaveBeenCalledTimes(2);
    expect(pending.impl.mock.calls[1][0].token).toBe('new');
    scheduler.updateConfig({ ...config, enabled: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancellation is not a failure and repeated stop/close is safe', async () => {
    const pending = waiting();
    const { scheduler, save } = create(pending.impl);
    for (let i = 0; i < 5; i++) {
      const run = scheduler.runOnce();
      scheduler.stop();
      scheduler.stop();
      await run;
    }
    expect(scheduler.status().halted).toBe(false);
    expect(scheduler.status().lastResult).toBe('同步已取消');
    expect(save).not.toHaveBeenCalled();
    await Promise.all([scheduler.close(), scheduler.close()]);
  });

  it('starts overdue runs immediately, schedules from completion, and saves before the next run', async () => {
    vi.useFakeTimers();
    const impl = vi.fn<typeof runSync>(async () => result);
    const { scheduler, save } = create(impl);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(scheduler.status().history);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(impl).toHaveBeenCalledTimes(2);
    await scheduler.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits only the remaining interval after a recent run', async () => {
    vi.useFakeTimers();
    const finishedAt = new Date(Date.now() - 10_000).toISOString();
    const history = { ...emptyHistory(), runs: [{ ...result, finishedAt, messages: 0 }] };
    const impl = vi.fn<typeof runSync>(async () => result);
    const { scheduler } = create(impl, history);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(impl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
