import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

export class Database {
  readonly pool: pg.Pool;
  constructor(connectionString: string, maxConnections: number) {
    this.pool = new Pool({ connectionString, max: maxConnections, statement_timeout: 15_000,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000, idle_in_transaction_session_timeout: 15_000,
      application_name: 'Sakura-MCP-Memory-Server' });
  }
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }
  async migrate(directory = join(process.cwd(), 'migrations')): Promise<void> {
    await this.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const migrations = (await readdir(directory)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
    for (const migration of migrations) {
      const exists = await this.query('SELECT 1 FROM schema_migrations WHERE name = $1', [migration]);
      if (exists.rowCount) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(await readFile(join(directory, migration), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [migration]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
  }

  async migrateWithRetry(directory: string, attempts = 30, delayMs = 2000): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.migrate(directory);
        return;
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
        const wait = Math.min(delayMs, 5000);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
    throw lastError instanceof Error ? new Error(`Database was not ready after ${attempts} attempts: ${lastError.message}`, { cause: lastError }) : lastError;
  }
  private closing?: Promise<void>;
  close(): Promise<void> { return this.closing ??= this.pool.end(); }
}
