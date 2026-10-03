import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hiddenInputs, IdpBrowser, startSakura } from './helpers/sakura-process.js';

describe('isolated IdP test helpers', () => {
  it('refuses a missing checkout before starting a service', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'sakura-mcp-source-'));
    try { await expect(startSakura(empty, 'http://localhost/auth/callback')).rejects.toThrow('ENOENT'); }
    finally { await rm(empty, { recursive: true, force: true }); }
  });

  it('never forwards IdP cookies to a different origin', async () => {
    const browser = new IdpBrowser('http://127.0.0.1:9000');
    await expect(browser.request('https://other.example/login')).rejects.toThrow('another origin');
    await expect(browser.request('//other.example/login')).rejects.toThrow('another origin');
    await expect(browser.request('http://127.0.0.1:9001/login')).rejects.toThrow('another origin');
  });

  it('decodes form values once without treating escaped markup as fields', () => {
    expect(hiddenInputs('<input type="hidden" name="next" value="/authorize?a=1&amp;b=&quot;x&quot;">'
      + '<input type="hidden" name="literal" value="&amp;quot;&lt;tag&gt;">'))
      .toEqual({ next: '/authorize?a=1&b="x"', literal: '&quot;<tag>' });
  });
});
