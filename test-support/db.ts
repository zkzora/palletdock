import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool, migrate, hashPassword } from '@palletdock/db';

declare module 'vitest' {
  export interface ProvidedContext {
    adminDatabaseUrl: string;
  }
}

export interface TestDatabase {
  url: string;
  pool: pg.Pool;
  drop(): Promise<void>;
}

/** Create an isolated, migrated database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `pd_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), 10);
  await migrate(pool, () => {});
  return {
    url: url.toString(),
    pool,
    async drop() {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export const TEST_GENESIS = `0x${'ab'.repeat(32)}`;

/** Insert an owner, active fingerprint, and project. Returns their ids. */
export async function seedWorkspace(pool: pg.Pool, opts: { email?: string; projectName?: string } = {}) {
  const owner = await pool.query('INSERT INTO owners(email,password_hash) VALUES ($1,$2) RETURNING id', [
    opts.email ?? `owner-${randomBytes(3).toString('hex')}@example.test`,
    await hashPassword('correct horse battery staple'),
  ]);
  let fp = await pool.query(`SELECT id FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active'`);
  if (!fp.rowCount) {
    fp = await pool.query(
      `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id,evidence) VALUES ('portaldot-v3-testnet','active',$1,420420777,'{"fixture":true}') RETURNING id`,
      [TEST_GENESIS],
    );
  }
  const project = await pool.query(`INSERT INTO projects(owner_id,name,network_id) VALUES ($1,$2,'portaldot-v3-testnet') RETURNING id`, [
    owner.rows[0].id,
    opts.projectName ?? `Project ${randomBytes(3).toString('hex')}`,
  ]);
  return { ownerId: owner.rows[0].id as string, fingerprintId: fp.rows[0].id as string, projectId: project.rows[0].id as string };
}

/** Insert a temporary playground guest (no email, no password) with its playground project. */
export async function seedGuest(pool: pg.Pool, opts: { expiresInMinutes?: number } = {}) {
  const owner = await pool.query(`INSERT INTO owners(kind,guest_expires_at) VALUES ('guest', now() + ($1::int * interval '1 minute')) RETURNING id`, [opts.expiresInMinutes ?? 360]);
  let fp = await pool.query(`SELECT id FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active'`);
  if (!fp.rowCount) {
    fp = await pool.query(
      `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id,evidence) VALUES ('portaldot-v3-testnet','active',$1,420420777,'{"fixture":true}') RETURNING id`,
      [TEST_GENESIS],
    );
  }
  const project = await pool.query(`INSERT INTO projects(owner_id,name,network_id,playground) VALUES ($1,'Playground','portaldot-v3-testnet',true) RETURNING id`, [owner.rows[0].id]);
  return { ownerId: owner.rows[0].id as string, fingerprintId: fp.rows[0].id as string, projectId: project.rows[0].id as string };
}

/** Move a guest's expiry into the past (as if its lifetime ended). */
export async function expireGuest(pool: pg.Pool, ownerId: string) {
  await pool.query(`UPDATE owners SET guest_expires_at = now() - interval '1 second' WHERE id=$1 AND kind='guest'`, [ownerId]);
}
