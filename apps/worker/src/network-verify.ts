import { createPool, loadEnv } from '@palletdock/db';
import { verifyAndRecordNetwork } from './network.js';

loadEnv();
const pool = createPool();
try {
  const result = await verifyAndRecordNetwork(pool);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'verified') process.exitCode = 1;
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
