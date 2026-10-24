import { hostname } from 'node:os';
import { createPool, loadEnv, randomToken } from '@palletdock/db';
import { EvmAdapter } from '@palletdock/chain';
import { resolveNetwork } from '@palletdock/shared';
import { verifyAndRecordNetwork } from './network.js';
import { DEFAULT_INDEXER_OPTIONS, runIndexerTick, type IndexerOptions } from './indexer/indexer.js';

loadEnv();
const workerId = `${hostname()}:${process.pid}:${randomToken(6)}`;
const pool = createPool(undefined, 5);
let stopping = false;
let heartbeatTimer: ReturnType<typeof setInterval>;
let probeTimer: ReturnType<typeof setInterval>;
let indexerTimer: ReturnType<typeof setTimeout> | undefined;
let indexerRun: Promise<void> = Promise.resolve();
const adapter = new EvmAdapter(resolveNetwork());
const indexerOptions: IndexerOptions = {
  ...DEFAULT_INDEXER_OPTIONS,
  workerId,
  confirmations: BigInt(process.env.PALLETDOCK_INDEXER_CONFIRMATIONS ?? '0'),
};
const INDEXER_POLL_MS = 2_000;

async function heartbeat(): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats(worker_id,started_at,last_seen_at,info) VALUES ($1,now(),now(),$2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=now(),info=EXCLUDED.info`,
    [workerId, { pid: process.pid, hostname: hostname(), role: 'network-monitor+indexer' }],
  );
}

async function verify(): Promise<void> {
  const result = await verifyAndRecordNetwork(pool);
  console.log(`[worker] network ${result.status}; evm=${result.evm.status} substrate=${result.substrate.status}`);
}

async function indexerLoop(): Promise<void> {
  if (stopping) return;
  indexerRun = (async () => {
    try {
      const outcomes = await runIndexerTick(pool, adapter, indexerOptions);
      for (const o of outcomes) if (o.kind !== 'caught_up') console.log(`[worker] indexer ${JSON.stringify(o)}`);
    } catch (error) {
      console.error(`[worker] indexer tick failed: ${(error as Error).message}`);
    }
  })();
  await indexerRun;
  if (!stopping) indexerTimer = setTimeout(() => void indexerLoop(), INDEXER_POLL_MS);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}; stopping ${workerId}`);
  clearInterval(heartbeatTimer);
  clearInterval(probeTimer);
  clearTimeout(indexerTimer);
  // Let an in-flight step finish or fail its fence; leases expire on their own otherwise.
  await indexerRun;
  await pool.end();
  process.exit(0);
}

await heartbeat();
await verify().catch((error) => console.error(`[worker] initial probe failed: ${(error as Error).message}`));
heartbeatTimer = setInterval(() => void heartbeat().catch((error) => console.error(`[worker] heartbeat failed: ${(error as Error).message}`)), 10_000);
probeTimer = setInterval(() => void verify().catch((error) => console.error(`[worker] probe failed: ${(error as Error).message}`)), 60_000);
void indexerLoop();
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
console.log(`[worker] started ${workerId}`);
