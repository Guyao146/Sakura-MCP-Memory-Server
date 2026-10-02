import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Reads Cline's on-disk task history. Cline (extension id
 * `saoudrizwan.claude-dev`) stores one directory per task, named with the
 * creation timestamp in milliseconds, containing `api_conversation_history.json`
 * — the exact message array sent to the model.
 */

export interface ClineMessage { role: string; content: unknown; }
export interface ClineTask { taskId: string; path: string; modifiedAt: number; messageCount: number; }

const HISTORY_FILE = 'api_conversation_history.json';

export async function listTasks(tasksDir: string, signal?: AbortSignal): Promise<ClineTask[]> {
  signal?.throwIfAborted();
  let entries: string[];
  try { entries = await readdir(tasksDir); }
  catch { signal?.throwIfAborted(); return []; }
  signal?.throwIfAborted();
  const tasks: ClineTask[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const path = join(tasksDir, entry, HISTORY_FILE);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      tasks.push({ taskId: entry, path, modifiedAt: info.mtimeMs, messageCount: 0 });
    } catch { continue; }
  }
  return tasks.sort((a, b) => a.modifiedAt - b.modifiedAt);
}

export async function readMessages(historyPath: string, signal?: AbortSignal): Promise<ClineMessage[]> {
  const raw = await readFile(historyPath, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`对话历史不是合法 JSON：${historyPath}`); }
  if (!Array.isArray(parsed)) throw new Error(`对话历史不是数组：${historyPath}`);
  return parsed.filter((item): item is ClineMessage =>
    Boolean(item) && typeof item === 'object' && typeof (item as ClineMessage).role === 'string');
}

/**
 * Flattens Anthropic-style content blocks into plain text. Tool results and
 * images are dropped: they are large, rarely contain durable knowledge, and
 * would inflate extraction cost.
 */
export function messageToText(message: ClineMessage): string {
  const { role, content } = message;
  if (typeof content === 'string') return `${role}: ${content}`.trim();
  if (!Array.isArray(content)) return '';
  const parts = content
    .map(block => {
      if (!block || typeof block !== 'object') return '';
      const typed = block as { type?: string; text?: string };
      return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : '';
    })
    .filter(Boolean);
  return parts.length ? `${role}: ${parts.join('\n')}`.trim() : '';
}

export function buildText(messages: ClineMessage[], limit = 200_000): string {
  const text = messages.map(messageToText).filter(Boolean).join('\n\n');
  return clampTail(text, limit);
}

/**
 * Keeps the tail of `text`, which holds the most recent (and usually most
 * conclusive) exchange. Applied after redaction too, because masking can make
 * the text longer than the server's 200k limit.
 */
export function clampTail(text: string, limit = 200_000): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}
