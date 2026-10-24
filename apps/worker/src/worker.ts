import { hostname } from 'node:os';
import { createPool, loadEnv, randomToken } from '@palletdock/db';
import { EvmAdapter, JsonRpcClient, RpcTransportError, type RpcCaller } from '@palletdock/chain';
import { resolveNetwork } from '@palletdock/shared';
import { verifyAndRecordNetwork } from './network.js';
import { IndexerEngine } from './indexer/engine.js';
import { TransactionTracker } from './tx-tracker.js';
import { Backoff } from './backoff.js';

loadEnv();
const workerId = `${hostname()}:${process.pid}:${randomToken(6)}`;
const pool = createPool(undefined, 8);
const network = resolveNetwork();
const devControls = process.env.PALLETDOCK_DEV_CONTROLS === '1' && process.env.NODE_ENV !== 'production';

/** RPC wrapper that supports the development-only "simulate interruption" control. */
class ControlledRpc implements RpcCaller {
  injectedFailures = 0;
  constructor(private readonly inner: RpcCaller) {}
  async call<T>(method: string, params?: readonly unknown[]): Promise<T> {
    if (this.injectedFailures > 0) {
      this.injectedFailures--;
      throw new RpcTransportError(`Simulated RPC interruption (development control) during ${method}`, 'network', method);
    }
    return this.inner.call<T>(method, params);
  }
}

const rpc = new ControlledRpc(new JsonRpcClient(network.evmRpcUrl, { timeoutMs: 20_000 }));
const evm = new EvmAdapter(network, rpc);
// Blocks to stay behind the head. Portaldot's RPC can report a block before its logs are queryable
// (live 2026-10-24: a log at the head was missed), and tip reorgs of 1–3 blocks are common.
const indexLag = Number(process.env.PALLETDOCK_INDEX_LAG_BLOCKS ?? 3);
if (!Number.isInteger(indexLag) || indexLag < 0 || indexLag > 64) throw new Error('PALLETDOCK_INDEX_LAG_BLOCKS must be an integer between 0 and 64.');
const indexer = new IndexerEngine(pool, evm, { workerId, backoffMaxMs: 10 * 60_000, confirmations: indexLag });
const tracker = new TransactionTracker(pool, evm);

let stopping = false;
let networkStatus: 'verified' | 'unavailable' | 'mismatch' | 'starting' = 'starting';
const timers: Array<ReturnType<typeof setInterval>> = [];

async function heartbeat(): Promise<void> {
  await pool.query(
    `INSERT INTO worker_heartbeats(worker_id,started_at,last_seen_at,info) VALUES ($1,now(),now(),$2)
     ON CONFLICT (worker_id) DO UPDATE SET last_seen_at=now(),info=EXCLUDED.info`,
    [workerId, { pid: process.pid, hostname: hostname(), roles: ['network-monitor', 'indexer', 'receipt-tracker'], networkStatus, devControls }],
  );
}

// RPC traffic is bounded: identity probes run every 60 s while healthy and back
// off exponentially (60 s → 30 min, jittered) while the RPCs are failing.
const probeBackoff = new Backoff({ baseMs: 60_000, maxMs: 30 * 60_000, healthyMs: 60_000 });
const trackerBackoff = new Backoff({ baseMs: 4_000, maxMs: 10 * 60_000, healthyMs: 4_000 });

async function verify(): Promise<void> {
  const nativeDisabled = process.env.PALLETDOCK_NATIVE_ADAPTER === 'disabled';
  const r = await probeBackoff.attempt(
    () => verifyAndRecordNetwork(pool),
    (v) => v.evm.status === 'responded' && (v.substrate.status === 'responded' || nativeDisabled),
  );
  if (!r.ran) return;
  const result = r.result;
  networkStatus = result.status;
  if (probeBackoff.consecutiveFailures > 0) {
    console.log(`[worker] probe failed ${probeBackoff.consecutiveFailures}x; next identity probe in ${Math.round(r.nextInMs / 1000)} s`);
  }
  if (result.status === 'mismatch') {
    await pool.query(
      `INSERT INTO ops_logs(source,level,message,detail) VALUES ('network','ERROR','Network identity changed. Indexing and receipt tracking are stopped until an operator migration is performed.',$1)`,
      [JSON.stringify({ evm: result.evm.value, substrate: result.substrate.value })],
    );
  }
  console.log(`[worker] network ${result.status}; evm=${result.evm.status} substrate=${result.substrate.status}`);
}

async function consumeCommands(): Promise<void> {
  const cmds = await pool.query(
    `UPDATE worker_commands SET consumed_at=now() WHERE id IN (SELECT id FROM worker_commands WHERE consumed_at IS NULL ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING id, source_id, command`,
  );
  for (const c of cmds.rows) {
    if (c.command === 'reconnect') {
      await pool.query(`UPDATE indexer_jobs SET next_run_at=now(), attempts=0 WHERE ($1::uuid IS NULL OR source_id=$1)`, [c.source_id]);
      await pool.query(
        `INSERT INTO ops_logs(project_id,source,level,message,indexer_source_id) VALUES ((SELECT project_id FROM indexer_sources WHERE id=$1),'worker','INFO','Reconnect requested; retrying from the stored checkpoint now.',$1)`,
        [c.source_id],
      );
    } else if (c.command === 'simulate_rpc_failure') {
      if (!devControls) {
        await pool.query(
          `INSERT INTO ops_logs(project_id,source,level,message,indexer_source_id) VALUES ((SELECT project_id FROM indexer_sources WHERE id=$1),'worker','WARN','Ignored simulated RPC failure: development controls are disabled.',$1)`,
          [c.source_id],
        );
        continue;
      }
      rpc.injectedFailures += 3;
      await pool.query(
        `INSERT INTO ops_logs(project_id,source,level,message,detail,indexer_source_id) VALUES ((SELECT project_id FROM indexer_sources WHERE id=$2),'worker','WARN','Development control: next 3 RPC calls will fail.',$1,$2)`,
        [JSON.stringify({ simulated: true }), c.source_id],
      );
    }
  }
}

let indexing = false;
async function indexLoop(): Promise<void> {
  if (indexing || stopping || networkStatus === 'mismatch' || networkStatus === 'starting') return;
  indexing = true;
  try {
    for (let i = 0; i < 10 && !stopping; i++) {
      const r = await indexer.runOnce();
      if (r.every((x) => x.kind === 'idle')) break;
    }
  } catch (e) {
    console.error(`[worker] indexer error: ${(e as Error).message}`);
  } finally {
    indexing = false;
  }
}

async function trackLoop(): Promise<void> {
  if (stopping || networkStatus === 'mismatch' || networkStatus === 'starting') return;
  try {
    const r = await trackerBackoff.attempt(
      () => tracker.runOnce(),
      (x) => !(x.checked > 0 && x.failed === x.checked),
    );
    if (r.ran && trackerBackoff.consecutiveFailures > 0) {
      console.log(`[worker] receipt checks failing (${r.result.failed}); next attempt in ${Math.round(r.nextInMs / 1000)} s`);
    }
  } catch (e) {
    console.error(`[worker] receipt tracker error: ${(e as Error).message}`);
  }
}

async function pruneRetention(): Promise<void> {
  await pool.query(`DELETE FROM rpc_probes WHERE observed_at < now() - interval '14 days'`);
  await pool.query(`DELETE FROM ops_logs WHERE created_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM request_logs WHERE created_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM worker_heartbeats WHERE last_seen_at < now() - interval '1 day'`);
}

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}; stopping ${workerId}`);
  timers.forEach(clearInterval);
  // Release leases held by this worker; uncommitted work is discarded and resumed from checkpoints.
  await pool.query(`UPDATE indexer_jobs SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL WHERE lease_owner=$1`, [workerId]).catch(() => {});
  await pool.end();
  process.exit(0);
}

const safe = (name: string, fn: () => Promise<void>) => () => void fn().catch((e) => console.error(`[worker] ${name} failed: ${(e as Error).message}`));

await heartbeat();
await verify().catch((error) => console.error(`[worker] initial probe failed: ${(error as Error).message}`));
timers.push(setInterval(safe('heartbeat', heartbeat), 10_000));
timers.push(setInterval(safe('probe', verify), 5_000)); // gated by probeBackoff
timers.push(setInterval(safe('commands', consumeCommands), 2_000));
timers.push(setInterval(safe('indexer', indexLoop), 2_000));
timers.push(setInterval(safe('tracker', trackLoop), 4_000));
timers.push(setInterval(safe('retention', pruneRetention), 3_600_000));
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
console.log(`[worker] started ${workerId}${devControls ? ' (development controls enabled)' : ''}`);
