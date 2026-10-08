import pg from 'pg';
export { migrate } from './migrate.js';
export * from './crypto.js';
export { loadEnv } from './env.js';

// int8 / numeric are returned as strings by node-pg (default). Keep it that
// way: chain quantities must never be parsed through Number.

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function databaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Copy .env.example to .env and run `pnpm db:start` for local PostgreSQL.');
  return url;
}

export function createPool(url = databaseUrl(), max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString: url, max, application_name: process.env.PALLETDOCK_PROCESS ?? 'palletdock' });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  return pool;
}

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
