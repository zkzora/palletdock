/**
 * Create or reset the single workspace owner.
 *   pnpm owner:create --email you@example.com
 * The password comes from PALLETDOCK_OWNER_PASSWORD or an interactive prompt.
 * It is never written to logs.
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
let password = process.env.PALLETDOCK_OWNER_PASSWORD ?? '';
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question('Owner password (min 12 chars): ');
  rl.close();
}
const pool = createPool();
try {
  const hash = await hashPassword(password);
  const existing = await pool.query('SELECT id FROM owners LIMIT 1');
  if (existing.rowCount) {
    const r = await pool.query('UPDATE owners SET email=$1, password_hash=$2 WHERE id=$3 RETURNING id', [email, hash, existing.rows[0].id]);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE revoked_at IS NULL');
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
