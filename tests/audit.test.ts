import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger, sanitize } from '../src/audit.js';

describe('audit metadata sanitization', () => {
  it('redacts secrets and large memory bodies recursively', () => {
    const sanitized = sanitize({ apiKey: 'secret-key', nested: { authorization: 'Bearer token', safe: 'visible' },
      content: 'private memory', note: 'x'.repeat(600), list: [{ password: 'hidden' }] }) as Record<string, unknown>;
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.content).toBe('[REDACTED]');
    expect(sanitized.nested).toEqual({ authorization: '[REDACTED]', safe: 'visible' });
    expect(String(sanitized.note)).toContain('[TRUNCATED]');
    expect(sanitized.list).toEqual([{ password: '[REDACTED]' }]);
  });

  it('limits recursion and array size', () => {
    expect((sanitize(Array.from({ length: 150 }, (_, index) => index)) as unknown[])).toHaveLength(100);
    expect(JSON.stringify(sanitize({ a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } }))).toContain('[TRUNCATED]');
  });

  it('reports failed sinks without disclosing the event or raw error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sakura-audit-'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const audit = new AuditLogger(directory, { query: async () => { throw new Error('database secret'); } } as never);
      await expect(audit.record({ action: 'sensitive-action', result: 'error', metadata: { content: 'private text' } })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join(' ')).toContain('file sink failed');
      expect(warn.mock.calls.flat().join(' ')).toContain('database sink failed');
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/database secret|sensitive-action|private text/);
    } finally { warn.mockRestore(); await rm(directory, { recursive: true, force: true }); }
  });

});