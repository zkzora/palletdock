import { createPool, migrate, loadEnv } from './index.js';

loadEnv();
const pool = createPool();
try {
  await migrate(pool);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
