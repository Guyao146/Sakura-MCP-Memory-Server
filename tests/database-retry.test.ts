import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/database.js';

describe('database startup retry', () => {
  it('closes the pool only once and bounds connection waits', async () => {
    const database = new Database('postgresql://unused', 1);
    const end = vi.spyOn(database.pool, 'end');
    const first = database.close();
    expect(database.close()).toBe(first);
    await first;
    expect(end).toHaveBeenCalledTimes(1);
    expect(database.pool.options).toMatchObject({ connectionTimeoutMillis: 5000, statement_timeout: 15000,
      idle_in_transaction_session_timeout: 15000 });
  });

  it('retries transient migration failures and eventually succeeds', async () => {
    const database = new Database('postgresql://unused', 1);
    const migrate = vi.spyOn(database, 'migrate').mockRejectedValueOnce(new Error('getaddrinfo EAI_AGAIN postgres'))
      .mockResolvedValueOnce(undefined);
    await expect(database.migrateWithRetry('.', 2, 1)).resolves.toBeUndefined();
    expect(migrate).toHaveBeenCalledTimes(2);
    await database.close();
  });
});