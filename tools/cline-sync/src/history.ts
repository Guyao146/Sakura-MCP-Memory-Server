import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './config.js';
import type { SyncSummary } from './sync.js';

/**
 * Append-only run log plus cumulative counters, persisted next to the cursors.
 * The daemon restarts on every reboot or update, but the cost picture and the
 * circuit breaker both need to survive that, so a finished run is never kept
 * in memory only.
 */

const MAX_RUNS = 50;

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  synced: number;
  skipped: number;
  failed: number;
  /** Messages actually pushed during this run. */
  messages: number;
}

export interface SyncTotals {
  runs: number;
  syncedTasks: number;
  messages: number;
  extractions: number;
  failedTasks: number;
}

export interface SyncHistory {
  runs: RunRecord[];
  totals: SyncTotals;
}

export function emptyHistory(): SyncHistory {
  return { runs: [], totals: { runs: 0, syncedTasks: 0, messages: 0, extractions: 0, failedTasks: 0 } };
}

function historyPath(dir = dataDir()): string {
  return join(dir, 'history.json');
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.startedAt === 'string' && typeof record.finishedAt === 'string'
    && Number.isFinite(record.scanned) && Number.isFinite(record.synced)
    && Number.isFinite(record.skipped) && Number.isFinite(record.failed);
}

export async function loadHistory(dir = dataDir()): Promise<SyncHistory> {
  try {
    const raw = await readFile(historyPath(dir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncHistory>;
    if (!parsed || typeof parsed !== 'object') return emptyHistory();
    const totals = { ...emptyHistory().totals, ...(parsed.totals ?? {}) };
    const runs = Array.isArray(parsed.runs) ? parsed.runs.filter(isRunRecord).slice(-MAX_RUNS) : [];
    return { runs, totals };
  } catch {
    return emptyHistory();
  }
}

/**
 * Folds a finished run into the history. Pure: returns a new object so callers
 * can keep rendering the previous snapshot while the new one is being saved.
 */
export function recordRun(summary: SyncSummary, history: SyncHistory = emptyHistory()): SyncHistory {
  const messages = summary.outcomes.reduce((sum, outcome) =>
    sum + (outcome.status === 'synced' ? outcome.newMessages : 0), 0);
  const record: RunRecord = {
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    scanned: summary.scanned,
    synced: summary.synced,
    skipped: summary.skipped,
    failed: summary.failed,
    messages
  };
  return {
    runs: [...history.runs, record].slice(-MAX_RUNS),
    totals: {
      runs: history.totals.runs + 1,
      syncedTasks: history.totals.syncedTasks + summary.synced,
      messages: history.totals.messages + messages,
      extractions: history.totals.extractions + (summary.extractionCalls ?? summary.synced),
      failedTasks: history.totals.failedTasks + summary.failed
    }
  };
}

export async function saveHistory(history: SyncHistory, dir = dataDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  // mode 0o600: the run log reveals how much was sent where.
  await writeFile(historyPath(dir), JSON.stringify(history, null, 2), { mode: 0o600 });
}

/** Wall-clock time of the last recorded run, or null when there has been none. */
export function lastRunFinishedAt(history: SyncHistory): number | null {
  const last = history.runs[history.runs.length - 1];
  if (!last) return null;
  const parsed = Date.parse(last.finishedAt);
  return Number.isNaN(parsed) ? null : parsed;
}
