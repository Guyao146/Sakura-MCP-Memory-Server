/**
 * Scheduler wrapping the sync engine: completion-based scans, single-flight
 * guarding (a long extraction never overlaps with the next tick), and status the
 * tray and config panel can read.
 */
import { McpClient } from './mcp-client.js';
import { runSync, type SyncSummary } from './sync.js';
import { emptyHistory, lastRunFinishedAt, recordRun, saveHistory, type SyncHistory } from './history.js';
import type { SyncConfig } from './config.js';
import type { PanelStatus } from './gui.js';

/**
 * Consecutive runs where nothing got through before the daemon stops hammering
 * the server. One failing task does not count: only a run that produced zero
 * successful extractions, or threw outright, does.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface SchedulerOptions {
  /** Pre-loaded history so `lastRunAt` survives a restart of the daemon. */
  history?: SyncHistory;
  /** Overrides the sync entry point for tests. */
  saveHistoryImpl?: typeof saveHistory;
  runSyncImpl?: typeof runSync;
}

export class SyncScheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastRunAt: number | null = null;
  private nextRunAt: number | null = null;
  private lastResult: string | null = null;
  private recent: SyncSummary['outcomes'] = [];
  private consecutiveFailures = 0;
  private halted = false;
  private history: SyncHistory;
  private readonly runSyncImpl: typeof runSync;
  private readonly saveHistoryImpl: typeof saveHistory;
  private scheduled = false;
  private closed = false;
  private controller?: AbortController;
  private inFlight?: Promise<SyncSummary | undefined>;

  constructor(
    private config: SyncConfig,
    private readonly log: (message: string) => void,
    options: SchedulerOptions = {}
  ) {
    this.history = options.history ?? emptyHistory();
    this.lastRunAt = lastRunFinishedAt(this.history);
    this.runSyncImpl = options.runSyncImpl ?? runSync;
    this.saveHistoryImpl = options.saveHistoryImpl ?? saveHistory;
  }

  updateConfig(config: SyncConfig): void {
    this.config = config;
    this.restart();
  }

  status(): PanelStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      halted: this.halted,
      lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toLocaleString() : null,
      nextRunAt: this.nextRunAt ? new Date(this.nextRunAt).toLocaleString() : null,
      lastResult: this.lastResult,
      recent: this.recent.slice(-12).reverse(),
      history: this.history
    };
  }

  restart(): void {
    this.stop();
    if (this.closed) return;
    this.scheduled = true;
    this.scheduleNext();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = null;
  }

  /** One timeout after completion, never an interval piling up ticks during I/O. */
  private scheduleNext(delay = this.config.intervalMinutes * 60_000): void {
    this.clearTimer();
    if (!this.scheduled || this.closed || this.running || !this.config.enabled || this.halted) return;
    this.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.clearTimer();
      void this.runOnce();
    }, delay);
    this.timer.unref?.();
  }

  start(): void {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    const elapsed = this.lastRunAt === null ? Infinity : Date.now() - this.lastRunAt;
    const period = this.config.intervalMinutes * 60_000;
    if (this.config.enabled && !this.halted && elapsed >= period) {
      void this.runOnce();
    } else {
      this.scheduleNext(Math.max(0, period - elapsed));
    }
  }

  /** Abort the active request as well as removing the next scheduled scan. */
  stop(): void {
    this.scheduled = false;
    this.clearTimer();
    this.controller?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await this.inFlight;
  }

  runOnce(): Promise<SyncSummary | undefined> {
    if (this.closed || this.running) return Promise.resolve(undefined);
    if (!this.config.mcpUrl || !this.config.token) {
      this.lastResult = '未配置 MCP 地址或密钥';
      this.scheduleNext();
      return Promise.resolve(undefined);
    }
    this.clearTimer();
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    const pending = this.execute(controller).finally(() => {
      this.running = false;
      this.controller = undefined;
      this.inFlight = undefined;
      this.scheduleNext();
    });
    this.inFlight = pending;
    return pending;
  }

  private async execute(controller: AbortController): Promise<SyncSummary | undefined> {
    try {
      const summary = await this.runSyncImpl(this.config, { logger: this.log, signal: controller.signal });
      this.lastRunAt = Date.now();
      this.recent = summary.outcomes.slice(-12);
      this.lastResult = `扫描 ${summary.scanned} 个任务：${summary.synced} 已同步 / ${summary.skipped} 跳过 / ${summary.failed} 失败`;
      this.history = recordRun(summary, this.history);
      // A failed save must never mask a successful sync.
      await this.saveHistoryImpl(this.history).catch(error => this.log(`运行历史保存失败：${error instanceof Error ? error.message : error}`));
      if (controller.signal.aborted || summary.cancelled) {
        this.lastResult = '同步已取消';
        return summary;
      }

      // Nothing got through at all: the server is likely down or the key revoked.
      const allFailed = summary.failed > 0 && summary.synced === 0;
      if (allFailed) {
        this.consecutiveFailures += 1;
        this.log(`连续 ${this.consecutiveFailures} 次同步全部失败`);
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.halt();
      } else {
        this.consecutiveFailures = 0;
        if (this.halted) { this.halted = false; this.log('同步恢复正常，已解除自动暂停'); }
      }
      this.log(this.lastResult);
      return summary;
    } catch (error) {
      if (controller.signal.aborted) {
        this.lastResult = '同步已取消';
        return undefined;
      }
      this.lastResult = `同步失败：${error instanceof Error ? error.message : String(error)}`;
      this.consecutiveFailures += 1;
      this.log(`连续 ${this.consecutiveFailures} 次同步出错：${this.lastResult}`);
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.halt();
      return undefined;
    }
  }

  /** Stops the timer and flags the halt so the panel and tray can explain it. */
  private halt(): void {
    this.halted = true;
    this.stop();
    this.nextRunAt = null;
    this.lastResult = `已自动暂停：连续 ${MAX_CONSECUTIVE_FAILURES} 次同步全部失败，请检查 MCP 地址与密钥后恢复`;
    this.log(this.lastResult);
  }

  /** Clears the breaker and resumes scheduling. */
  resume(): void {
    this.consecutiveFailures = 0;
    this.halted = false;
    this.log('已手动恢复自动同步');
    this.restart();
  }

  async testConnection(config: SyncConfig, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    try {
      await new McpClient(config.mcpUrl, config.token).initialize(undefined, signal);
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

