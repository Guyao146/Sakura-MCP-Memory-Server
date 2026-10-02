import { spawn, type ChildProcess } from 'node:child_process';

/** Only stop a child we own; never select processes by name. */
export async function stopChild(child: ChildProcess, tree = false): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    let killer: ChildProcess | undefined;
    const finish = () => {
      clearTimeout(timer);
      child.removeListener('close', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        if (tree && process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* Already exited. */ }
      killer?.kill();
      finish();
    }, 2000);
    child.once('close', finish);
    try {
      if (tree && process.platform === 'win32') {
        killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill(); });
      } else if (tree) {
        // App windows are launched detached, hence have their own process group.
        try { process.kill(-pid, 'SIGTERM'); } catch { child.kill(); }
      } else {
        child.kill();
      }
    } catch { finish(); }
  });
}

/** Idempotent shutdown, also used for console mode and tray startup failures. */
export class Lifecycle {
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly report: (error: unknown) => void = () => undefined) {}

  get stopping(): boolean { return this.closed; }

  add(cleanup: () => void | Promise<void>): void {
    if (this.closed) {
      void Promise.resolve().then(cleanup).catch(this.report);
    } else {
      this.cleanups.push(cleanup);
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      const tasks = this.cleanups.splice(0).reverse();
      this.closing = Promise.all(tasks.map(async cleanup => {
        try { await cleanup(); } catch (error) { this.report(error); }
      })).then(() => undefined);
    }
    return this.closing;
  }
}
