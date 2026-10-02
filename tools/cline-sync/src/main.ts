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
import { loadHistory } from './history.js';
import { ConfigPanel } from './gui.js';
import { PanelWindow } from './window.js';
import { Lifecycle, stopChild } from './lifecycle.js';
import { resolveSysTray } from './systray-interop.js';
import { prepareTrayBinary, isPackaged } from './tray-binary.js';
import { trayIconIco, trayIconPng } from './tray-icon.js';
import { autostartLocation, disableAutostart, enableAutostart, isAutostartEnabled } from './autostart.js';

const log = (message: string) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

async function main(): Promise<void> {
  let config = await loadConfig();
  const scheduler = new SyncScheduler(config, log, { history: await loadHistory() });

  const lifecycle = new Lifecycle(error => log(`资源回收失败：${String(error)}`));
  const window = new PanelWindow({ onError: error => log(`配置窗口启动失败：${error.message}`) });
  lifecycle.add(() => scheduler.close());
  lifecycle.add(() => window.close());
  const setConfig = async (next: SyncConfig) => {
    await saveConfig(next);
    if (lifecycle.stopping) return;
    config = next;
    scheduler.updateConfig(config);
    log('配置已更新');
  };
  const showPanel = (url: string) => {
    const handle = window.open(url);
    if (handle) log(handle.mode === 'app-window' ? '配置窗口已打开（已存在时复用）' : '已用默认浏览器打开配置面板');
  };
  const panel = new ConfigPanel({
    getConfig: () => config,
    setConfig,
    getStatus: () => scheduler.status(),
    syncNow: async () => { void scheduler.runOnce(); },
    testConnection: (cfg, signal) => scheduler.testConnection(cfg, signal),
    listTasks: signal => listTaskInventory(config, { signal }),
    resumeSync: () => scheduler.resume()
  });
  lifecycle.add(() => panel.stop());
  const shutdown = () => {
    if (lifecycle.stopping) return;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    void lifecycle.close().finally(() => clearTimeout(deadline));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  lifecycle.add(() => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });
  try {
    const url = await panel.start();
    if (lifecycle.stopping) return;
    log(`配置面板：${url}`);
    log(`数据目录：${dataDir()}`);
    scheduler.start();
    await startTray(url, scheduler, () => config, setConfig, showPanel, lifecycle, shutdown);
    if (!lifecycle.stopping && (!config.mcpUrl || !config.token)) showPanel(url);
  } catch (error) {
    await lifecycle.close();
    throw error;
  }
}

async function startTray(url: string, scheduler: SyncScheduler, getConfig: () => SyncConfig,
  setConfig: (config: SyncConfig) => Promise<void>, showPanel: (url: string) => void,
  lifecycle: Lifecycle, shutdown: () => void): Promise<void> {
  // In a packaged build the bundled tray helper lives in the read-only snapshot,
  // so copy it out and run from there before systray2 looks for it.
  // The loopback HTTP server keeps console mode alive; no dummy interval needed.
  try {
    const trayCwd = await prepareTrayBinary();
    if (trayCwd) { process.chdir(trayCwd); log(`托盘辅助程序目录：${trayCwd}`); }
  } catch (error) {
    log(`托盘辅助程序准备失败，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    return;
  }

  let SysTray: typeof import('systray2').default;
  try {
    SysTray = resolveSysTray(await import('systray2'));
  }
  catch (error) {
    log(`托盘不可用，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    return;
  }

  const openItem = { title: '打开配置窗口', tooltip: '在独立窗口中编辑同步设置', enabled: true, checked: false };
  const syncItem = { title: '立即同步', tooltip: '马上扫描一次 Cline 任务历史', enabled: true, checked: false };
  const statusItem = { title: '状态：就绪', tooltip: '最近一次同步结果', enabled: false, checked: false };
  const toggleItem = { title: getConfig().enabled ? '暂停自动同步' : '恢复自动同步', tooltip: '停止在途同步及定时扫描', enabled: true, checked: getConfig().enabled };
  // Only a packaged build has a stable entry point worth registering at login.
  const autostartItem = { title: '开机自启', tooltip: '登录时自动启动本程序', enabled: isPackaged(), checked: false };
  const exitItem = { title: '退出', tooltip: '结束后台同步', enabled: true, checked: false };
  if (autostartItem.enabled) {
    autostartItem.checked = await isAutostartEnabled().catch(() => false);
    log(`开机自启：${autostartItem.checked ? '已开启（' + autostartLocation() + '）' : '未开启'}`);
  }

  if (lifecycle.stopping) return;
  let tray: import('systray2').default;
  try {
    tray = new SysTray({
      menu: {
        icon: process.platform === 'win32' ? trayIconIco : trayIconPng,
        isTemplateIcon: process.platform === 'darwin',
        title: 'Sakura Sync',
        tooltip: 'Sakura Cline Sync',
        items: [openItem, syncItem, statusItem, SysTray.separator, toggleItem, autostartItem, SysTray.separator, exitItem]
      },
      debug: false,
      copyDir: true
    });
  } catch (error) {
    log(`托盘初始化失败，继续以控制台模式运行：${error instanceof Error ? error.message : error}`);
    return;
  }

  const disposeTray = async () => {
    if (tray.process) await stopChild(tray.process);
  };
  lifecycle.add(disposeTray);
  let readyTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      tray.ready(),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('托盘启动超时')), 5000);
      })
    ]);
  } catch (error) {
    log(`托盘不可用，继续以控制台模式运行：${String(error)}`);
    await disposeTray();
    // If initialization finishes late, do not leave its helper running.
    void tray.ready().then(disposeTray, () => undefined);
    return;
  } finally {
    clearTimeout(readyTimer);
  }
  if (lifecycle.stopping) { await disposeTray(); return; }

  const send = (action: Parameters<typeof tray.sendAction>[0]) => {
    if (!lifecycle.stopping && tray.process.exitCode === null && !tray.process.killed) {
      void tray.sendAction(action).catch(error => log(`托盘更新失败：${String(error)}`));
    }
  };
  let changingConfig = false;
  let changingAutostart = false;
  await tray.onClick(action => {
    if (lifecycle.stopping) return;
    const title = action.item?.title;
    if (title === openItem.title) { showPanel(url); return; }
    if (title === syncItem.title) { void scheduler.runOnce(); return; }
    if (title === toggleItem.title) {
      if (changingConfig) return;
      changingConfig = true;
      const enabled = !getConfig().enabled;
      void (async () => {
        await setConfig({ ...getConfig(), enabled });
        if (enabled && scheduler.status().halted) scheduler.resume();
        toggleItem.checked = enabled;
        toggleItem.title = enabled ? '暂停自动同步' : '恢复自动同步';
        send({ type: 'update-item', item: toggleItem, seq_id: action.seq_id });
      })().catch(error => log(`配置更新失败：${String(error)}`)).finally(() => { changingConfig = false; });
      return;
    }
    if (title === autostartItem.title) {
      if (changingAutostart || !autostartItem.enabled) return;
      changingAutostart = true;
      void (async () => {
        try {
          if (autostartItem.checked) await disableAutostart();
          else await enableAutostart();
          autostartItem.checked = !autostartItem.checked;
          send({ type: 'update-item', item: autostartItem, seq_id: action.seq_id });
          log(autostartItem.checked ? `已开启开机自启（${autostartLocation()}）` : '已关闭开机自启');
        } catch (error) {
          log(`开机自启设置失败：${error instanceof Error ? error.message : error}`);
        } finally {
          changingAutostart = false;
        }
      })();
      return;
    }
    if (title === exitItem.title) {
      shutdown();
    }
  });

  // No later tray resources should be installed if shutdown won the await above.
  if (lifecycle.stopping) return;
  // Reflect the latest run in the (disabled) status row so hovering the tray is enough.
  const refresh = setInterval(() => {
    const status = scheduler.status();
    if (toggleItem.checked !== getConfig().enabled) {
      toggleItem.checked = getConfig().enabled;
      toggleItem.title = toggleItem.checked ? '暂停自动同步' : '恢复自动同步';
      send({ type: 'update-item', item: toggleItem });
    }
    const next = `状态：${status.running ? '同步中' : status.lastResult ?? '就绪'}`;
    if (next === statusItem.title) return;
    statusItem.title = next;
    send({ type: 'update-item', item: statusItem });
  }, 5000);
  refresh.unref();
  const clearRefresh = () => clearInterval(refresh);
  tray.process.once('exit', clearRefresh);
  lifecycle.add(() => {
    clearRefresh();
    tray.process.removeListener('exit', clearRefresh);
  });
  log('托盘已启动');
}

void main().catch(error => {
  console.error('启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
