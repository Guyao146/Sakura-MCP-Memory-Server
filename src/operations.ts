import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationContext {
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
}

export const operationContext = new AsyncLocalStorage<OperationContext>();

/** Provider calls inherit the HTTP request lifetime, even inside MCP callbacks. */
export function operationSignal(signal?: AbortSignal): AbortSignal | undefined {
  const parent = operationContext.getStore()?.signal;
  return signal && parent && signal !== parent ? AbortSignal.any([parent, signal]) : signal ?? parent;
}

/** MCP returns response headers before its tool handlers finish. Track them separately. */
export function trackOperation<T>(operation: () => Promise<T>, context = operationContext.getStore(), signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve().then(() => {
    if (!signal) return operation();
    const combined = context ? AbortSignal.any([context.signal, signal]) : signal;
    return operationContext.run({ signal: combined, pending: context?.pending ?? new Set() }, operation);
  });
  context?.pending.add(pending);
  void pending.then(() => context?.pending.delete(pending), () => context?.pending.delete(pending));
  return pending;
}
