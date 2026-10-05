import { providerScope, providerMetrics, reserveProviderCall, recordProviderCall } from './metrics.js';
import { operationSignal } from '../operations.js';

/** The deadline covers headers AND body consumption; always dispose its timer/listener. */
export async function providerRequest<T>(url: string, init: RequestInit, timeoutMs: number,
  consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const parent = operationSignal(signal);
  parent?.throwIfAborted();
  const usageDay = providerScope.getStore() ? await reserveProviderCall() : undefined;
  parent?.throwIfAborted();
  const started=Date.now();
  let failed=true;
  providerMetrics.calls++; providerMetrics.inFlight++;
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Provider request timed out.')), timeoutMs);
  timer.unref();
  let response: Response | undefined;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    const result = await consume(response);
    failed=false;
    return result;
  } finally {
    const duration=Date.now()-started;
    providerMetrics.inFlight--; providerMetrics.durationMs+=duration;
    if(failed) providerMetrics.failures++;
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
    await recordProviderCall(failed,duration,usageDay);
    // Error responses (notably Ollama) may never have been consumed.
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
  }
}
