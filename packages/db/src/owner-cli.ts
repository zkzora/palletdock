/**
 * Create or reset one workspace account.
 *   pnpm owner:create --email you@example.com
 * The password is accepted only through the interactive prompt and is never
 * written to arguments, environment variables, or logs.
 */
import { createInterface } from 'node:readline/promises';
import { createPool, hashPassword, loadEnv } from './index.js';

loadEnv();
const args = process.argv.slice(2);
const at = args.indexOf('--email');
const email = at >= 0 ? (args[at + 1] ?? '').trim().toLowerCase() : '';
if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('Usage: pnpm owner:create --email you@example.com');
  process.exit(1);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question('Owner password (min 12 chars): ');
rl.close();
const pool = createPool();
try {
  const hash = await hashPassword(password);
  // Accounts only: temporary playground guests have no email and are never created or reset here.
  const existing = await pool.query(`SELECT id FROM owners WHERE kind='account' AND lower(email)=$1`, [email]);
  if (existing.rowCount) {
    const r = await pool.query('UPDATE owners SET email=$1, password_hash=$2 WHERE id=$3 RETURNING id', [email, hash, existing.rows[0].id]);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE owner_id=$1 AND revoked_at IS NULL', [existing.rows[0].id]);
    console.log(`Owner updated (${r.rows[0].id}). Existing sessions revoked.`);
  } else {
    const r = await pool.query('INSERT INTO owners(email, password_hash) VALUES ($1,$2) RETURNING id', [email, hash]);
    console.log(`Owner created (${r.rows[0].id}).`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
