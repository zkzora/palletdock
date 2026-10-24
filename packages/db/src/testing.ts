import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from './migrate.js';
import { loadEnv } from './env.js';

/**
 * Server URL used by DB-backed tests. Each test file gets its own freshly
 * migrated database on that server, dropped afterwards. The role needs
 * CREATEDB (the embedded `pnpm db:start` role is a superuser).
 */
export function testServerUrl(env: Record<string, string | undefined> = process.env): string | null {
  loadEnv();
  return env.PALLETDOCK_TEST_DATABASE_URL ?? env.DATABASE_URL ?? null;
}

export interface TestDatabase {
  pool: pg.Pool;
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(serverUrl = testServerUrl()): Promise<TestDatabase> {
  if (!serverUrl) throw new Error('Set PALLETDOCK_TEST_DATABASE_URL (or DATABASE_URL) to run DB-backed tests.');
  const name = `palletdock_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
  await migrate(pool, () => {});
  return {
    pool,
    url: url.toString(),
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: serverUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
