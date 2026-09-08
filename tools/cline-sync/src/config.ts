import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime configuration for the sync daemon. Persisted as JSON next to the
 * executable data directory so the tray GUI can edit it and the watcher can
 * hot-reload it. Secrets (the Agent token) live here too, so the file is
 * written with owner-only permissions.
 */
export interface SyncConfig {
  /** Sakura-MCP-Server `/mcp` endpoint, e.g. https://mcp.example.com/mcp */
  mcpUrl: string;
  /** Agent API key: sk_sakura_... Used as a Bearer credential. */
  token: string;
  /** Cline task history directory. Auto-detected when empty. */
  clineTasksDir: string;
  /** Minutes between scans. */
  intervalMinutes: number;
  /** Whether the daemon is actively syncing. Toggled from the tray. */
  enabled: boolean;
  /** Skip tasks whose last activity is older than this many days (0 = no limit). */
  maxTaskAgeDays: number;
  /** Redact secrets (tokens, keys, .env values) before uploading. */
  redactSecrets: boolean;
  /**
   * Task selection mode:
   * - `all`: sync every task inside the age window (default).
   * - `include`: only sync task IDs listed in `selectedTasks`.
   * - `exclude`: sync everything except the listed task IDs.
   */
  selectionMode: 'all' | 'include' | 'exclude';
  /** Task IDs the selection mode applies to. */
  selectedTasks: string[];
}

export const DEFAULT_CONFIG: SyncConfig = {
  mcpUrl: '',
  token: '',
  clineTasksDir: '',
  intervalMinutes: 10,
  enabled: false,
  maxTaskAgeDays: 30,
  redactSecrets: true,
  selectionMode: 'all',
  selectedTasks: []
};

/** Per-platform Cline (saoudrizwan.claude-dev) globalStorage tasks directory. */
export function defaultClineTasksDir(env = process.env, platform = process.platform): string {
  const ext = 'saoudrizwan.claude-dev';
  if (platform === 'win32' && env.APPDATA) {
    return join(env.APPDATA, 'Code', 'User', 'globalStorage', ext, 'tasks');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', ext, 'tasks');
  }
  return join(homedir(), '.config', 'Code', 'User', 'globalStorage', ext, 'tasks');
}

/** Data directory holding config.json and cursors.json. */
export function dataDir(env = process.env, platform = process.platform): string {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'sakura-cline-sync');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'sakura-cline-sync');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'sakura-cline-sync');
}

export function normalizeConfig(partial: Partial<SyncConfig>): SyncConfig {
  const merged = { ...DEFAULT_CONFIG, ...partial };
  const mode = merged.selectionMode === 'include' || merged.selectionMode === 'exclude' ? merged.selectionMode : 'all';
  return {
    mcpUrl: merged.mcpUrl.trim(),
    token: merged.token.trim(),
    clineTasksDir: merged.clineTasksDir.trim() || defaultClineTasksDir(),
    intervalMinutes: clamp(Math.round(merged.intervalMinutes), 1, 1440),
    enabled: Boolean(merged.enabled),
    maxTaskAgeDays: clamp(Math.round(merged.maxTaskAgeDays), 0, 3650),
    redactSecrets: merged.redactSecrets !== false,
    selectionMode: mode,
    selectedTasks: Array.isArray(merged.selectedTasks)
      ? [...new Set(merged.selectedTasks.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map(id => id.trim()))]
      : []
  };
}

/**
 * Decides whether a task should be synced. The age window is applied first, then
 * the explicit selection. An `include` list with no entries selects nothing,
 * which is deliberate: it means "I have not picked any task yet" rather than
 * silently falling back to syncing everything.
 */
export function taskFilterReason(config: SyncConfig, taskId: string, modifiedAt: number, now: number): string | undefined {
  if (config.maxTaskAgeDays > 0 && modifiedAt < now - config.maxTaskAgeDays * 86_400_000) return '超出时间范围';
  if (config.selectionMode === 'include' && !config.selectedTasks.includes(taskId)) return '未在同步列表中';
  if (config.selectionMode === 'exclude' && config.selectedTasks.includes(taskId)) return '已排除';
  return undefined;
}

/** Validates a config for actual syncing and returns human-readable problems. */
export function validateConfig(config: SyncConfig): string[] {
  const problems: string[] = [];
  let url: URL | undefined;
  try { url = new URL(config.mcpUrl); } catch { problems.push('MCP 地址不是合法的 URL。'); }
  if (url && url.protocol !== 'https:' && url.protocol !== 'http:') problems.push('MCP 地址必须是 http(s)。');
  if (!config.token.startsWith('sk_sakura_')) problems.push('Agent 密钥应以 sk_sakura_ 开头。');
  return problems;
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
