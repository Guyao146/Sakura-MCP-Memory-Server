import { operationSignal } from '../operations.js';

/** The deadline covers headers AND body consumption; always dispose its timer/listener. */
export async function providerRequest<T>(url: string, init: RequestInit, timeoutMs: number,
  consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const parent = operationSignal(signal);
  parent?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out.')), timeoutMs);
  timer.unref();
  let response: Response | undefined;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    return await consume(response);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    // Error responses (notably Ollama) may never have been consumed.
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
  }
}
