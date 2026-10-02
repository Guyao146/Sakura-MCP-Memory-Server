import { describe, expect, it } from 'vitest';
import { syncChunks } from '../src/chunks.js';
import { messageToText } from '../src/cline-store.js';

describe('lossless sync chunks', () => {
  it('includes the beginning and end of a long conversation within the server limit', () => {
    const messages = [{ role: 'user', content: 'EARLY' }, { role: 'assistant', content: 'x'.repeat(410000) + 'END' }];
    const chunks = [...syncChunks(messages,0,0,false)];
    expect(chunks.every(chunk => chunk.text.length <= 200000)).toBe(true);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(messages.map(messageToText).join('\n\n'));
    expect(chunks.at(-1)?.messageCount).toBe(2);
  });
  it('resumes an oversized message at the confirmed offset', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(400001) }];
    const [first] = syncChunks(messages,0,0,false);
    const tail = [...syncChunks(messages,first.messageCount,first.messageOffset,false,first.messageHash)];
    expect(first.text + tail.map(chunk => chunk.text).join('')).toBe(messageToText(messages[0]));
  });
  it('restarts the partial message when its contents changed', () => {
    const [first] = syncChunks([{role:'user',content:'a'.repeat(300000)}],0,0,false);
    const [next] = syncChunks([{role:'user',content:'new'}],0,first.messageOffset,false,first.messageHash);
    expect(next.text).toBe('user: new');
  });
  it.each([199992,199993,199994,199995,199996,199997,199998,200000])('keeps boundaries safe at %i characters', length => {
    const chunks = [...syncChunks([{role:'user',content:'x'.repeat(length)}, {role:'user',content:'😀'.repeat(100005)}],0,0,false)];
    expect(chunks.every(chunk => chunk.text.length<=200000)).toBe(true);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk.text))).toBe(true);
    expect(chunks.at(-1)?.messageCount).toBe(2);
  });
  it('redacts before splitting', () => {
    const chunks = [...syncChunks([{ role:'user',content:'password=demo-secret-value' }],0)];
    expect(chunks[0].text).not.toContain('demo-secret-value');
  });
});
