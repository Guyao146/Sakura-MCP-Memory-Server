#!/usr/bin/env node
/**
 * Tray application entry point. Runs the interval scheduler in the background,
 * exposes a loopback config panel, and puts a system tray icon in place so the
 * whole thing can live quietly in the notification area.
 *
 * The tray is optional: when systray2 (which ships a native helper binary)
 * cannot start — headless machines, missing tray support — the daemon keeps
 * running in console mode and prints the panel URL instead of exiting.
 */
import { loadConfig, saveConfig } from './store.js';
import { dataDir, type SyncConfig } from './config.js';
import { SyncScheduler } from './scheduler.js';
import { listTaskInventory } from './sync.js';
import { ConfigPanel } from './gui.js';
import { openPanelWindow } from './window.js';
import { resolveSysTray } from './systray-interop.js';
import { prepareTrayBinary } from './tray-binary.js';
import { trayIconIco, trayIconPng } from './tray-icon.js';

const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

async function main(): Promise<void> {
  let config = await loadConfig();
  const scheduler = new SyncScheduler(config, log);

  const panel = new ConfigPanel({
    getConfig: () => config,
    setConfig: async next => {
      config = next;
      await saveConfig(config);
      scheduler.updateConfig(config);
      log('配置已更新');
    },
    getStatus: () => scheduler.status(),
    syncNow: async () => { void scheduler.runOnce(); },
    testConnection: cfg => scheduler.testConnection(cfg),
    listTasks: () => listTaskInventory(config)
  });

  const url = await panel.start();
  log(`配置面板：${url}`);
  log(`数据目录：${dataDir()}`);
  scheduler.restart();
  const unconfigured = !config.mcpUrl || !config.token;
  if (unconfigured) log('尚未配置 MCP 地址与 Agent 密钥，请在配置窗口中填写。');

  await startTray(url, scheduler, () => config, async () => {
    scheduler.stop();
    await panel.stop();
  });

  // A fresh install has nothing to sync yet, so show the window immediately
  // instead of leaving the user to hunt for the tray icon.
  if (unconfigured) showPanel(url);
}

/** Opens the panel as a chromeless app window, falling back to the default browser. */
function showPanel(url: string): void {
  const handle = openPanelWindow(url);
  log(handle.mode === 'app-window' ? '已打开配置窗口' : '未找到可用浏览器引擎，已用默认浏览器打开配置面板');
}

async function startTray(url: string, scheduler: SyncScheduler, getConfig: () => SyncConfig,
  shutdown: () => Promise<void>): Promise<void> {
  // In a packaged build the bundled tray helper lives in the read-only snapshot,
  // so copy it out and run from there before systray2 looks for it.
  try {
    const trayCwd = await prepareTrayBinary();
    if (trayCwd) { process.chdir(trayCwd); log(`托盘辅助程序目录：${trayCwd}`); }
  } catch (error) {
    log(`托盘辅助程序准备失败，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    keepAlive();
    return;
  }

  let SysTray: typeof import('systray2').default;
  try {
    SysTray = resolveSysTray(await import('systray2'));
  }
  catch (error) {
    log(`托盘不可用，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    keepAlive();
    return;
  }

  const openItem = { title: '打开配置窗口', tooltip: '在独立窗口中编辑同步设置', enabled: true, checked: false };
  const syncItem = { title: '立即同步', tooltip: '马上扫描一次 Cline 任务历史', enabled: true, checked: false };
  const statusItem = { title: '状态：就绪', tooltip: '最近一次同步结果', enabled: false, checked: false };
  const toggleItem = { title: '暂停自动同步', tooltip: '临时停止定时扫描', enabled: true, checked: getConfig().enabled };
  const exitItem = { title: '退出', tooltip: '结束后台同步', enabled: true, checked: false };

  let tray: import('systray2').default;
  try {
    tray = new SysTray({
      menu: {
        icon: process.platform === 'win32' ? trayIconIco : trayIconPng,
        isTemplateIcon: process.platform === 'darwin',
        title: 'Sakura Sync',
        tooltip: 'Sakura Cline Sync',
        items: [openItem, syncItem, statusItem, SysTray.separator, toggleItem, exitItem]
      },
      debug: false,
      copyDir: true
    });
  } catch (error) {
    log(`托盘初始化失败，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    keepAlive();
    return;
  }

  tray.onClick(action => {
    const title = action.item?.title;
    if (title === openItem.title) { showPanel(url); return; }
    if (title === syncItem.title) { void scheduler.runOnce(); return; }
    if (title === toggleItem.title) {
      const enabled = !getConfig().enabled;
      void (async () => {
        const next = { ...getConfig(), enabled };
        await saveConfig(next);
        scheduler.updateConfig(next);
        toggleItem.checked = enabled;
        toggleItem.title = enabled ? '暂停自动同步' : '恢复自动同步';
        tray.sendAction({ type: 'update-item', item: toggleItem, seq_id: action.seq_id });
      })();
      return;
    }
    if (title === exitItem.title) {
      void shutdown().finally(() => { tray.kill(false); process.exit(0); });
    }
  });

  // Reflect the latest run in the (disabled) status row so hovering the tray is enough.
  const refresh = setInterval(() => {
    const status = scheduler.status();
    const next = `状态：${status.running ? '同步中' : status.lastResult ?? '就绪'}`;
    if (next === statusItem.title) return;
    statusItem.title = next;
    tray.sendAction({ type: 'update-item', item: statusItem });
  }, 5000);
  refresh.unref?.();

  await tray.ready().then(() => log('托盘已启动')).catch((error: unknown) => {
    log(`托盘启动失败，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    keepAlive();
  });
}

/** Prevents the process from exiting when no tray holds the event loop. */
function keepAlive(): void {
  setInterval(() => undefined, 1 << 30);
}

void main().catch(error => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
