import { buildText, clampTail, listTasks, readMessages } from './cline-store.js';
import { McpClient } from './mcp-client.js';
import { redactSecrets } from './redact.js';
import type { SyncConfig } from './config.js';
import { taskFilterReason } from './config.js';
import { loadCursors, saveCursors, type Cursors } from './store.js';

/**
 * Incremental sync engine. For every Cline task it pushes only the messages
 * added since the last successful run, so re-scanning an active conversation
 * does not re-extract (and re-charge for) the whole history.
 */

export interface TaskOutcome {
  taskId: string;
  status: 'synced' | 'skipped' | 'failed';
  newMessages: number;
  reason?: string;
}

export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  scanned: number;
  synced: number;
  skipped: number;
  failed: number;
  outcomes: TaskOutcome[];
}

/** Minimum new messages before a task is worth extracting. */
const MIN_NEW_MESSAGES = 2;

export async function runSync(config: SyncConfig, options: {
  client?: McpClient;
  cursors?: Cursors;
  persist?: boolean;
  now?: () => number;
  logger?: (message: string) => void;
} = {}): Promise<SyncSummary> {
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const client = options.client ?? new McpClient(config.mcpUrl, config.token);
  const cursors = options.cursors ?? await loadCursors();
  const persist = options.persist !== false;

  const tasks = await listTasks(config.clineTasksDir);
  const outcomes: TaskOutcome[] = [];

  for (const task of tasks) {
    const filtered = taskFilterReason(config, task.taskId, task.modifiedAt, now());
    if (filtered) {
      outcomes.push({ taskId: task.taskId, status: 'skipped', newMessages: 0, reason: filtered });
      continue;
    }
    let messages;
    try { messages = await readMessages(task.path); }
    catch (error) {
      outcomes.push({ taskId: task.taskId, status: 'failed', newMessages: 0, reason: message(error) });
      continue;
    }
    const already = cursors[task.taskId]?.messageCount ?? 0;
    // A shorter history means the task was restored to an earlier checkpoint;
    // treat it as fresh from that point instead of pushing nothing forever.
    const from = already > messages.length ? 0 : already;
    const pending = messages.slice(from);
    if (pending.length < MIN_NEW_MESSAGES) {
      outcomes.push({ taskId: task.taskId, status: 'skipped', newMessages: pending.length, reason: '无新增内容' });
      continue;
    }

    const raw = buildText(pending);
    // Redaction can grow the text (masks are longer than short secrets), so clamp again.
    const text = clampTail(config.redactSecrets ? redactSecrets(raw) : raw);
    if (!text.trim()) {
      cursors[task.taskId] = { messageCount: messages.length, syncedAt: new Date(now()).toISOString() };
      outcomes.push({ taskId: task.taskId, status: 'skipped', newMessages: pending.length, reason: '无可提取文本' });
      continue;
    }

    log(`推送 ${task.taskId}：${pending.length} 条新消息，${text.length} 字符`);
    const result = await client.extractAndRemember(text, undefined).catch(error => ({ ok: false, error: message(error) }));
    if (!result.ok) {
      // Leave the cursor untouched so the next run retries the same window.
      outcomes.push({ taskId: task.taskId, status: 'failed', newMessages: pending.length, reason: result.error });
      log(`失败 ${task.taskId}：${result.error}`);
      continue;
    }
    cursors[task.taskId] = { messageCount: messages.length, syncedAt: new Date(now()).toISOString() };
    outcomes.push({ taskId: task.taskId, status: 'synced', newMessages: pending.length });
  }

  if (persist) await saveCursors(cursors);
  return {
    startedAt, finishedAt: new Date(now()).toISOString(), scanned: tasks.length,
    synced: outcomes.filter(o => o.status === 'synced').length,
    skipped: outcomes.filter(o => o.status === 'skipped').length,
    failed: outcomes.filter(o => o.status === 'failed').length,
    outcomes
  };
}

/**
 * Builds an inventory of the tasks on disk so the config panel can present a
 * pick-list instead of forcing a single age cutoff. Reports message counts and
 * how many are still pending against the stored cursor, plus whether the current
 * selection would sync each task, so the cost of a run is visible before it runs.
 */
export interface TaskInventoryItem {
  taskId: string;
  modifiedAt: string;
  messageCount: number;
  pendingMessages: number;
  syncedAt: string | null;
  selected: boolean;
  /** True when the age window alone excludes this task, regardless of selection. */
  outOfWindow: boolean;
  skipReason?: string;
}

export async function listTaskInventory(config: SyncConfig, options: {
  cursors?: Cursors; now?: () => number;
} = {}): Promise<TaskInventoryItem[]> {
  const now = options.now ?? Date.now;
  const cursors = options.cursors ?? await loadCursors();
  const tasks = await listTasks(config.clineTasksDir);
  const items: TaskInventoryItem[] = [];
  for (const task of tasks) {
    let messageCount = 0;
    try { messageCount = (await readMessages(task.path)).length; }
    catch { messageCount = 0; }
    const already = cursors[task.taskId]?.messageCount ?? 0;
    const from = already > messageCount ? 0 : already;
    const skipReason = taskFilterReason(config, task.taskId, task.modifiedAt, now());
    items.push({
      taskId: task.taskId,
      modifiedAt: new Date(task.modifiedAt).toISOString(),
      messageCount,
      pendingMessages: Math.max(0, messageCount - from),
      syncedAt: cursors[task.taskId]?.syncedAt ?? null,
      selected: !skipReason,
      outOfWindow: skipReason === '超出时间范围',
      skipReason
    });
  }
  // Most recent first: that is what the operator usually wants to act on.
  return items.reverse();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
