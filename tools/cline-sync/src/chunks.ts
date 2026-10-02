import { createHash } from 'node:crypto';
import { messageToText, type ClineMessage } from './cline-store.js';
import { redactSecrets } from './redact.js';

export interface SyncChunk { text: string; messageCount: number; messageOffset?: number; messageHash?: string; }
const LIMIT = 200_000;

/** Offsets refer to the redacted message, and never split a surrogate pair. */
export function* syncChunks(messages: ClineMessage[], from: number, offset = 0, redact = true, expectedHash?: string): Generator<SyncChunk> {
  let buffer = '';
  let completed = from;
  for (let index = from; index < messages.length; index++) {
    const raw = messageToText(messages[index]);
    const text = redact ? redactSecrets(raw) : raw;
    const hash = createHash('sha256').update(text).digest('hex');
    let position = index === from && expectedHash === hash ? Math.min(offset, text.length) : 0;
    if (buffer && text.length > position) {
      if (buffer.length + 2 > LIMIT) {
        yield { text: buffer, messageCount: completed };
        buffer = '';
      } else buffer += '\n\n';
    }
    while (position < text.length) {
      // Leave room for separators; flush a completed-message boundary when full.
      if (buffer.length >= LIMIT - 2) {
        yield { text: buffer, messageCount: completed };
        buffer = '';
      }
      let end = Math.min(text.length, position + LIMIT - buffer.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      buffer += text.slice(position, end);
      position = end;
      if (position < text.length) {
        yield { text: buffer, messageCount: index, messageOffset: position, messageHash: hash };
        buffer = '';
      }
    }
    completed = index + 1;
  }
  if (buffer || completed > from) yield { text: buffer, messageCount: completed };
}
