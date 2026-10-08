import { hostname } from 'node:os';
import { createPool, loadEnv, randomToken } from '@palletdock/db';
import { verifyAndRecordNetwork } from './network.js';

loadEnv();
const workerId = `${hostname()}:${process.pid}:${randomToken(6)}`;
const pool = createPool(undefined, 5);
let stopping = false;
let heartbeatTimer: ReturnType<typeof setInterval>;
let probeTimer: ReturnType<typeof setInterval>;

async function heartbeat(): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats(worker_id,started_at,last_seen_at,info) VALUES ($1,now(),now(),$2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=now(),info=EXCLUDED.info`,
    [workerId, { pid: process.pid, hostname: hostname(), role: 'network-monitor' }],
  );
}

async function verify(): Promise<void> {
  const result = await verifyAndRecordNetwork(pool);
  console.log(`[worker] network ${result.status}; evm=${result.evm.status} substrate=${result.substrate.status}`);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}; stopping ${workerId}`);
  clearInterval(heartbeatTimer);
  clearInterval(probeTimer);
  await pool.end();
  process.exit(0);
}

await heartbeat();
await verify().catch((error) => console.error(`[worker] initial probe failed: ${(error as Error).message}`));
heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.error(`[worker] heartbeat failed: ${(error as Error).message}`)), 10_000);
probeTimer = setInterval(() => void verify().catch((error) => console.error(`[worker] probe failed: ${(error as Error).message}`)), 60_000);
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
console.log(`[worker] started ${workerId}`);
