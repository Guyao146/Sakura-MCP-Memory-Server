/**
 * Scheduler wrapping the sync engine: fixed-interval scans, single-flight
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

  constructor(
    private config: SyncConfig,
    private readonly log: (message: string) => void,
    options: SchedulerOptions = {}
  ) {
    this.history = options.history ?? emptyHistory();
    this.lastRunAt = lastRunFinishedAt(this.history);
    this.runSyncImpl = options.runSyncImpl ?? runSync;
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
    if (!this.config.enabled || this.halted) {
      this.nextRunAt = null;
      if (!this.config.enabled) this.log('自动同步已关闭');
      else this.log('自动同步已暂停（连续失败保护）');
      return;
    }
    const period = this.config.intervalMinutes * 60_000;
    this.nextRunAt = Date.now() + period;
    this.timer = setInterval(() => void this.runOnce(), period);
    // Do not hold the event loop open purely for the timer.
    this.timer.unref?.();
    this.log(`自动同步已启用，每 ${this.config.intervalMinutes} 分钟扫描一次`);
  }

  /**
   * Schedules the timer and flushes immediately when a run is overdue. Called
   * once at startup so a freshly booted machine does not sit idle for a whole
   * interval before its first sync.
   */
  start(): void {
    if (this.config.enabled && !this.halted) {
      const period = this.config.intervalMinutes * 60_000;
      const overdue = this.lastRunAt === null || Date.now() - this.lastRunAt >= period;
      if (overdue) {
        this.log('距上次同步已超过一个周期，立即同步一次');
        void this.runOnce();
      }
    }
    this.restart();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs a scan unless one is already in flight. */
  async runOnce(): Promise<SyncSummary | undefined> {
    if (this.running) { this.log('上一次同步仍在进行，跳过本次触发'); return undefined; }
    if (!this.config.mcpUrl || !this.config.token) { this.lastResult = '未配置 MCP 地址或密钥'; return undefined; }
    this.running = true;
    try {
      const summary = await this.runSyncImpl(this.config, { logger: this.log });
      this.lastRunAt = Date.now();
      this.recent = summary.outcomes;
      this.lastResult = `扫描 ${summary.scanned} 个任务：${summary.synced} 已同步 / ${summary.skipped} 跳过 / ${summary.failed} 失败`;
      this.history = recordRun(summary, this.history);
      // A failed save must never mask a successful sync.
      await saveHistory(this.history).catch(error => this.log(`运行历史保存失败：${error instanceof Error ? error.message : error}`));

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
      this.lastResult = `同步失败：${error instanceof Error ? error.message : String(error)}`;
      this.consecutiveFailures += 1;
      this.log(`连续 ${this.consecutiveFailures} 次同步出错：${this.lastResult}`);
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) this.halt();
      return undefined;
    } finally {
      this.running = false;
      if (this.config.enabled && !this.halted) this.nextRunAt = Date.now() + this.config.intervalMinutes * 60_000;
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

  async testConnection(config: SyncConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      await new McpClient(config.mcpUrl, config.token).initialize();
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

