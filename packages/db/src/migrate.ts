import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Apply numbered SQL migrations in order, each in its own transaction, under a
 * Postgres advisory lock. Applied files are checksummed; editing an applied
 * migration is refused.
 */
export async function migrate(pool: pg.Pool, log: (m: string) => void = console.log): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const done = new Map<string, string>((await c.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = (await readFile(path.join(MIGRATIONS_DIR, f), 'utf8')).replace(/\r\n/g, '\n');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) throw new Error(`Applied migration ${f} was modified (checksum mismatch). Add a new migration instead.`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1,$2)', [f, sum]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
      applied.push(f);
      log(`[migrate] applied ${f}`);
    }
    if (!applied.length) log('[migrate] up to date');
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    c.release();
  }
  return applied;
}
