import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Lifecycle, stopChild } from '../src/lifecycle.js';

const children: ChildProcess[] = [];
afterEach(async () => { await Promise.all(children.splice(0).map(child => stopChild(child, true))); });

describe('resource shutdown', () => {
  it('is idempotent and executes all cleanups even if one throws', async () => {
    const report = vi.fn();
    const lifecycle = new Lifecycle(report);
    const cleanup = vi.fn(async () => undefined);
    lifecycle.add(cleanup);
    lifecycle.add(() => { throw new Error('cleanup failed'); });
    const closing = lifecycle.close();
    expect(lifecycle.close()).toBe(closing);
    await closing;
    expect(lifecycle.stopping).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('also disposes resources registered after shutdown has started', async () => {
    const lifecycle = new Lifecycle();
    await lifecycle.close();
    const cleanup = vi.fn();
    lifecycle.add(cleanup);
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('terminates a real owned child and removes close listeners', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    children.push(child);
    await once(child, 'spawn');
    const before = child.listenerCount('close');
    await stopChild(child, true);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(child.listenerCount('close')).toBe(before);
    await stopChild(child, true);
  });

  it('kills descendants in the owned process tree, not unrelated processes', async () => {
    const script = `const {spawn}=require('node:child_process');
      const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      c.once('spawn',()=>console.log(c.pid)); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: true });
    children.push(child, unrelated);
    const [data] = await once(child.stdout!, 'data');
    const descendant = Number(String(data).trim());
    expect(descendant).toBeGreaterThan(0);
    try {
      await stopChild(child, true);
      await vi.waitFor(() => expect(() => process.kill(descendant, 0)).toThrow(), { timeout: 3000 });
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    } finally {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
  }, 10_000);
});
