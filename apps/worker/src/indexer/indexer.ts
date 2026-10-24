import type pg from 'pg';
import type { Abi, Hex } from 'viem';
import { getAddress } from 'viem';
import { withTx, type PoolClient } from '@palletdock/db';
import { RpcResponseError, RpcTransportError, type EvmAdapter, type EvmBlockHeader, type EvmLog } from '@palletdock/chain';
import { createEventDecoder } from './decode.js';
import { assertFence, claimNextLease, LeaseLostError, releaseLease, renewLease, type AttemptPolicy, type Lease } from './lease.js';

export interface IndexerOptions {
  workerId: string;
  leaseTtlMs: number;
  /** Blocks behind the observed head to stay. 0 indexes up to the observed head. */
  confirmations: bigint;
  minChunk: number;
  maxChunk: number;
  /** Deepest rollback performed automatically; deeper forks require an operator reset. */
  maxReorgDepth: bigint;
  followIntervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Jitter source in [0, 1). Injected so tests are deterministic. */
  random: () => number;
  /** Test hook run after fetching and before the fenced commit. */
  beforeCommit?: (sourceId: string) => Promise<void>;
}

export const DEFAULT_INDEXER_OPTIONS: Omit<IndexerOptions, 'workerId'> = {
  leaseTtlMs: 60_000,
  confirmations: 0n,
  minChunk: 1,
  maxChunk: 5_000,
  maxReorgDepth: 128n,
  followIntervalMs: 5_000,
  backoffBaseMs: 2_000,
  backoffMaxMs: 300_000,
  random: Math.random,
};

export type StepOutcome =
  | { kind: 'committed'; from: string; to: string; logs: number; caughtUp: boolean; completed: boolean }
  | { kind: 'caught_up'; head: string }
  | { kind: 'completed'; endBlock: string }
  | { kind: 'reorg'; from: string; ancestor: string }
  | { kind: 'recovery_required'; reason: string }
  | { kind: 'range_split'; chunkSize: number; reason: string }
  | { kind: 'chain_moved'; reason: string }
  | { kind: 'fenced'; reason: string }
  | { kind: 'error'; message: string; retryInMs: number };

interface SourceState {
  id: string;
  projectId: string;
  fingerprintId: string;
  fingerprintStatus: string;
  contractAddress: string;
  eventTopics: string[];
  startBlock: bigint;
  endBlock: bigint | null;
  generation: string;
  abiVersionId: string;
  abi: Abi;
  chunkSize: number;
  attempts: number;
  checkpoint: { number: bigint; hash: string } | null;
}

/** A transient condition: the chain changed while a range was being read. Retried without backoff. */
class ChainMovedError extends Error {}

/** The RPC rejected or could not serve a range of this size. */
function isRangeLimitError(error: unknown): boolean {
  if (error instanceof RpcTransportError) return error.kind === 'timeout' || error.kind === 'response_too_large';
  if (error instanceof RpcResponseError) {
    return error.code === -32005 || /block range|range (is )?too (large|wide)|too many (results|logs|blocks)|more than \d+|limit exceeded|query timeout|response (size|is too)/i.test(error.message);
  }
  return false;
}

export function backoffMs(attempts: number, opts: Pick<IndexerOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'random'>): number {
  const exp = Math.min(opts.backoffMaxMs, opts.backoffBaseMs * 2 ** Math.min(attempts, 20));
  // Equal jitter: never less than half the exponential delay.
  return Math.round(exp / 2 + (exp / 2) * opts.random());
}

async function loadSource(pool: pg.Pool, sourceId: string): Promise<SourceState> {
  const result = await pool.query(
    `SELECT s.id, s.project_id, s.fingerprint_id, f.status AS fingerprint_status, s.contract_address, s.event_topics,
            s.start_block::text, s.end_block::text, s.generation::text, s.abi_version_id, a.abi,
            j.chunk_size, j.attempts, c.block_number::text AS cp_number, c.block_hash AS cp_hash
       FROM indexer_sources s
       JOIN indexer_jobs j ON j.source_id = s.id
       JOIN abi_versions a ON a.id = s.abi_version_id
       JOIN network_fingerprints f ON f.id = s.fingerprint_id
       LEFT JOIN indexer_checkpoints c ON c.source_id = s.id
      WHERE s.id = $1`,
    [sourceId],
  );
  const r = result.rows[0];
  if (!r) throw new Error(`Indexer source ${sourceId} not found`);
  return {
    id: r.id,
    projectId: r.project_id,
    fingerprintId: r.fingerprint_id,
    fingerprintStatus: r.fingerprint_status,
    contractAddress: getAddress(r.contract_address),
    eventTopics: r.event_topics,
    startBlock: BigInt(r.start_block),
    endBlock: r.end_block === null ? null : BigInt(r.end_block),
    generation: r.generation,
    abiVersionId: r.abi_version_id,
    abi: r.abi,
    chunkSize: r.chunk_size,
    attempts: r.attempts,
    checkpoint: r.cp_number === null ? null : { number: BigInt(r.cp_number), hash: r.cp_hash },
  };
}

async function requireHeader(adapter: EvmAdapter, block: bigint): Promise<EvmBlockHeader> {
  const header = await adapter.blockHeader(block);
  if (!header) throw new ChainMovedError(`Block ${block} is not available from the RPC`);
  if (BigInt(header.number) !== block) throw new Error(`RPC returned block ${header.number} when asked for ${block}`);
  return header;
}

async function opsLog(c: pg.Pool | PoolClient, s: { id: string; projectId: string }, level: 'INFO' | 'WARN' | 'ERROR', message: string, detail: Record<string, unknown>): Promise<void> {
  await c.query(`INSERT INTO ops_logs(project_id,source,level,message,detail,indexer_source_id) VALUES ($1,'indexer',$2,$3,$4,$5)`, [s.projectId, level, message, detail, s.id]);
}

/**
 * Run one bounded unit of work for a leased source: verify the checkpoint is
 * still canonical (rolling back on a fork), then scan the next range and commit
 * headers, raw logs, decoded events, coverage and the checkpoint atomically.
 */
export async function runIndexerStep(pool: pg.Pool, adapter: EvmAdapter, lease: Lease, opts: IndexerOptions): Promise<StepOutcome> {
  const source = await loadSource(pool, lease.sourceId);
  if (source.generation !== lease.generation) return { kind: 'fenced', reason: 'generation changed after claim' };
  if (source.fingerprintStatus !== 'active') {
    throw new Error('The network fingerprint this source was configured against is no longer active; indexing is held until the network is re-verified.');
  }

  const head = BigInt(await adapter.blockNumber());
  const safeHead = head - opts.confirmations;

  if (source.checkpoint) {
    // A node that is behind is not a fork: wait for it instead of rolling back.
    if (source.checkpoint.number > head) {
      throw new Error(`RPC head ${head} is behind checkpoint ${source.checkpoint.number}; waiting for the node to catch up instead of rolling back.`);
    }
    const current = await adapter.blockHeader(source.checkpoint.number);
    if (!current || current.hash.toLowerCase() !== source.checkpoint.hash.toLowerCase()) {
      return rollback(pool, adapter, lease, source, opts, head);
    }
  }

  const next = source.checkpoint ? source.checkpoint.number + 1n : source.startBlock;
  const limit = source.endBlock !== null && source.endBlock < safeHead ? source.endBlock : safeHead;
  if (next > limit) {
    if (source.endBlock !== null && source.checkpoint && source.checkpoint.number >= source.endBlock) {
      await markStatus(pool, lease, source, 'completed', head);
      return { kind: 'completed', endBlock: source.endBlock.toString() };
    }
    await markStatus(pool, lease, source, 'following', head);
    return { kind: 'caught_up', head: head.toString() };
  }
  const chunk = BigInt(Math.max(opts.minChunk, Math.min(opts.maxChunk, source.chunkSize)));
  const to = next + chunk - 1n < limit ? next + chunk - 1n : limit;

  const toBefore = await requireHeader(adapter, to);
  let logs: EvmLog[];
  try {
    logs = await adapter.logs({
      address: source.contractAddress,
      fromBlock: next,
      toBlock: to,
      ...(source.eventTopics.length ? { topics: [source.eventTopics as Hex[]] } : {}),
    });
  } catch (error) {
    if (isRangeLimitError(error) && chunk > BigInt(opts.minChunk)) {
      const smaller = Math.max(opts.minChunk, Math.floor(Number(chunk) / 2));
      return { kind: 'range_split', chunkSize: smaller, reason: (error as Error).message };
    }
    throw error;
  }

  // Validate every log belongs to this request and to the chain we observed.
  const blocks = new Map<bigint, string>();
  for (const log of logs) {
    if (log.removed) throw new ChainMovedError(`RPC returned a removed log in block ${log.blockNumber}`);
    if (log.address.toLowerCase() !== source.contractAddress.toLowerCase()) throw new Error(`RPC returned a log for ${log.address}, which was not requested`);
    const n = BigInt(log.blockNumber);
    if (n < next || n > to) throw new Error(`RPC returned a log in block ${n}, outside the requested range ${next}-${to}`);
    const seen = blocks.get(n);
    if (seen && seen.toLowerCase() !== log.blockHash.toLowerCase()) throw new ChainMovedError(`Logs in block ${n} reference two different block hashes`);
    blocks.set(n, log.blockHash);
  }
  const headers = new Map<bigint, EvmBlockHeader>([[to, toBefore]]);
  for (const [n, hash] of blocks) {
    const header = n === to ? toBefore : await requireHeader(adapter, n);
    if (header.hash.toLowerCase() !== hash.toLowerCase()) throw new ChainMovedError(`Block ${n} changed while its logs were being read`);
    headers.set(n, header);
  }

  await renewLease(pool, lease, opts.leaseTtlMs);
  // Re-read both ends after the scan: if the range end or the checkpoint moved,
  // the logs may come from a chain we are not about to record.
  const toAfter = await requireHeader(adapter, to);
  if (toAfter.hash.toLowerCase() !== toBefore.hash.toLowerCase()) throw new ChainMovedError(`Block ${to} changed while range ${next}-${to} was being read`);
  if (source.checkpoint) {
    const cpAfter = await adapter.blockHeader(source.checkpoint.number);
    if (!cpAfter || cpAfter.hash.toLowerCase() !== source.checkpoint.hash.toLowerCase()) throw new ChainMovedError(`Checkpoint block ${source.checkpoint.number} changed during the scan`);
  }

  await opts.beforeCommit?.(source.id);

  const decoder = createEventDecoder(source.abi);
  const caughtUp = to >= limit;
  const completed = source.endBlock !== null && to >= source.endBlock;
  await withTx(pool, async (c) => {
    await assertFence(c, lease);
    const cp = await c.query(`SELECT block_number::text, block_hash FROM indexer_checkpoints WHERE source_id=$1 FOR UPDATE`, [source.id]);
    const stored = cp.rows[0] ? `${cp.rows[0].block_number}:${cp.rows[0].block_hash}` : null;
    const expected = source.checkpoint ? `${source.checkpoint.number}:${source.checkpoint.hash}` : null;
    if (stored !== expected) throw new LeaseLostError(source.id, 'checkpoint moved since this range was planned');

    for (const header of headers.values()) {
      await c.query(
        `INSERT INTO block_headers(fingerprint_id,source_id,block_number,block_hash,parent_hash,block_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (source_id,block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,parent_hash=EXCLUDED.parent_hash,
           block_timestamp=EXCLUDED.block_timestamp,observed_at=now()`,
        [source.fingerprintId, source.id, header.number, header.hash, header.parentHash, header.timestamp],
      );
    }
    for (const log of logs) {
      const inserted = await c.query(
        `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (source_id,fingerprint_id,block_hash,transaction_hash,log_index)
           DO UPDATE SET canonical=true, orphaned_at=NULL
         RETURNING id`,
        [source.id, source.projectId, source.fingerprintId, log.address, log.blockNumber, log.blockHash, log.transactionHash, log.transactionIndex, log.logIndex, log.topics, log.data],
      );
      const decoded = decoder.decode(log.topics, log.data);
      await c.query(
        `INSERT INTO decoded_events(raw_log_id,abi_version_id,status,event_name,event_signature,args,decode_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (raw_log_id) DO NOTHING`,
        [inserted.rows[0].id, source.abiVersionId, decoded.status, decoded.eventName, decoded.eventSignature, decoded.status === 'decoded' ? JSON.stringify(decoded.args) : null, decoded.status === 'decoded' ? null : decoded.error],
      );
    }
    await c.query(
      `INSERT INTO indexer_coverage(source_id,from_block,to_block,to_block_hash,log_count,generation,reorg_epoch,lease_token)
       SELECT $1,$2,$3,$4,$5,generation,reorg_epoch,$6 FROM indexer_sources WHERE id=$1`,
      [source.id, next.toString(), to.toString(), toBefore.hash, logs.length, lease.token],
    );
    await c.query(
      `INSERT INTO indexer_checkpoints(source_id,block_number,block_hash) VALUES ($1,$2,$3)
       ON CONFLICT (source_id) DO UPDATE SET block_number=EXCLUDED.block_number,block_hash=EXCLUDED.block_hash,committed_at=now()`,
      [source.id, to.toString(), toBefore.hash],
    );
    await c.query(
      `UPDATE indexer_sources SET status=$2,last_error=NULL,last_error_at=NULL,latest_observed_block=$3,latest_observed_at=now(),updated_at=now() WHERE id=$1`,
      [source.id, completed ? 'completed' : caughtUp ? 'following' : 'backfilling', head.toString()],
    );
  });
  return { kind: 'committed', from: next.toString(), to: to.toString(), logs: logs.length, caughtUp, completed };
}

async function markStatus(pool: pg.Pool, lease: Lease, source: SourceState, status: 'following' | 'completed', head: bigint): Promise<void> {
  await withTx(pool, async (c) => {
    await assertFence(c, lease);
    await c.query(
      `UPDATE indexer_sources SET status=$2,last_error=NULL,last_error_at=NULL,latest_observed_block=$3,latest_observed_at=now(),updated_at=now() WHERE id=$1`,
      [source.id, status, head.toString()],
    );
  });
}

/**
 * The checkpoint block is no longer canonical. Walk retained headers downward
 * to the newest one the chain still agrees with, then orphan everything above
 * it in one fenced transaction. Orphaned logs are kept (canonical=false) for
 * audit; re-ingesting the same log later flips it back to canonical.
 */
async function rollback(pool: pg.Pool, adapter: EvmAdapter, lease: Lease, source: SourceState, opts: IndexerOptions, head: bigint): Promise<StepOutcome> {
  const checkpoint = source.checkpoint!;
  const floor = checkpoint.number - opts.maxReorgDepth;
  const stored = await pool.query(
    `SELECT block_number::text, block_hash, parent_hash FROM block_headers WHERE source_id=$1 AND block_number <= $2 AND block_number >= $3 ORDER BY block_number DESC`,
    [source.id, checkpoint.number.toString(), (floor < 0n ? 0n : floor).toString()],
  );
  // Each retained header pins its own hash and, through parent_hash, the hash
  // of the block below it, so a one-block fork resolves without extra storage.
  const candidates: Array<{ number: bigint; hash: string }> = [];
  for (const row of stored.rows) {
    const n = BigInt(row.block_number);
    candidates.push({ number: n, hash: row.block_hash });
    if (n - 1n >= source.startBlock - 1n && n - 1n >= floor && n > 0n) candidates.push({ number: n - 1n, hash: row.parent_hash });
  }
  let ancestor: { number: bigint; hash: string; header: EvmBlockHeader } | null = null;
  const checked = new Map<bigint, EvmBlockHeader | null>();
  for (const candidate of candidates) {
    if (!checked.has(candidate.number)) checked.set(candidate.number, await adapter.blockHeader(candidate.number));
    const header = checked.get(candidate.number);
    if (header && header.hash.toLowerCase() === candidate.hash.toLowerCase()) {
      ancestor = { ...candidate, header };
      break;
    }
  }
  if (!ancestor && source.startBlock - 1n < floor) {
    const reason = `Fork deeper than ${opts.maxReorgDepth} blocks below checkpoint ${checkpoint.number}; no retained header within that depth is canonical.`;
    await withTx(pool, async (c) => {
      await assertFence(c, lease);
      await c.query(`UPDATE indexer_sources SET status='recovery_required',last_error=$2,last_error_at=now(),latest_observed_block=$3,latest_observed_at=now(),updated_at=now() WHERE id=$1`, [source.id, reason, head.toString()]);
      await opsLog(c, source, 'ERROR', 'Indexer recovery required', { checkpoint: checkpoint.number.toString(), checkpointHash: checkpoint.hash, maxReorgDepth: opts.maxReorgDepth.toString() });
    });
    return { kind: 'recovery_required', reason };
  }
  // No retained header matched but the whole indexed range is within depth: rewind to before start.
  const keep = ancestor ? ancestor.number : source.startBlock - 1n;
  await withTx(pool, async (c) => {
    await assertFence(c, lease);
    const orphaned = await c.query(`UPDATE raw_logs SET canonical=false,orphaned_at=now() WHERE source_id=$1 AND block_number > $2 AND canonical`, [source.id, keep.toString()]);
    await c.query(`DELETE FROM block_headers WHERE source_id=$1 AND block_number > $2`, [source.id, keep.toString()]);
    await c.query(`DELETE FROM indexer_coverage WHERE source_id=$1 AND from_block > $2`, [source.id, keep.toString()]);
    if (ancestor) {
      // Anchor the new checkpoint with a retained header (it may have been known only as a parent hash).
      await c.query(
        `INSERT INTO block_headers(fingerprint_id,source_id,block_number,block_hash,parent_hash,block_timestamp)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (source_id,block_number) DO NOTHING`,
        [source.fingerprintId, source.id, ancestor.header.number, ancestor.header.hash, ancestor.header.parentHash, ancestor.header.timestamp],
      );
      await c.query(`UPDATE indexer_coverage SET to_block=$2,to_block_hash=$3 WHERE source_id=$1 AND to_block > $2`, [source.id, keep.toString(), ancestor.hash]);
      await c.query(`UPDATE indexer_checkpoints SET block_number=$2,block_hash=$3,committed_at=now() WHERE source_id=$1`, [source.id, keep.toString(), ancestor.hash]);
    } else {
      await c.query(`DELETE FROM indexer_checkpoints WHERE source_id=$1`, [source.id]);
    }
    await c.query(
      `UPDATE indexer_sources SET status='backfilling',reorg_epoch=reorg_epoch+1,last_reorg_at=now(),last_reorg_from=$2,last_reorg_ancestor=$3,
              latest_observed_block=$4,latest_observed_at=now(),updated_at=now() WHERE id=$1`,
      [source.id, checkpoint.number.toString(), keep.toString(), head.toString()],
    );
    await opsLog(c, source, 'WARN', 'Reorg detected; rolled back to common ancestor', {
      checkpoint: checkpoint.number.toString(),
      checkpointHash: checkpoint.hash,
      ancestor: keep.toString(),
      orphanedLogs: orphaned.rowCount ?? 0,
    });
  });
  return { kind: 'reorg', from: checkpoint.number.toString(), ancestor: keep.toString() };
}

/**
 * Run one step under an already-claimed lease, record failures on the source,
 * and release the lease with the next run time. Never throws for chain or
 * RPC failures; a lost fence is reported and leaves the source untouched.
 */
export async function processLease(pool: pg.Pool, adapter: EvmAdapter, lease: Lease, opts: IndexerOptions): Promise<StepOutcome> {
  let outcome: StepOutcome;
  let attempts: AttemptPolicy = 'reset';
  let chunkSize: number | undefined;
  let nextRunInMs = 0;
  const state = await pool.query(`SELECT s.project_id, j.attempts, j.chunk_size FROM indexer_jobs j JOIN indexer_sources s ON s.id=j.source_id WHERE j.source_id=$1`, [lease.sourceId]);
  const meta = { id: lease.sourceId, projectId: state.rows[0]?.project_id as string, attempts: Number(state.rows[0]?.attempts ?? 0), chunkSize: Number(state.rows[0]?.chunk_size ?? 1) };
  try {
    outcome = await runIndexerStep(pool, adapter, lease, opts);
    switch (outcome.kind) {
      case 'committed':
        nextRunInMs = outcome.caughtUp ? opts.followIntervalMs : 0;
        // Grow the window after a full-size range succeeds.
        if (BigInt(outcome.to) - BigInt(outcome.from) + 1n >= BigInt(meta.chunkSize) && meta.chunkSize < opts.maxChunk) {
          chunkSize = Math.min(opts.maxChunk, meta.chunkSize * 2);
        }
        break;
      case 'caught_up':
      case 'completed':
        nextRunInMs = opts.followIntervalMs;
        break;
      case 'reorg':
        nextRunInMs = 0;
        break;
      case 'range_split':
        attempts = 'keep';
        chunkSize = outcome.chunkSize;
        await opsLog(pool, meta, 'INFO', `RPC refused a log range; retrying with ${outcome.chunkSize} blocks`, { reason: outcome.reason.slice(0, 500) });
        break;
      case 'recovery_required':
      case 'fenced':
        attempts = 'keep';
        break;
    }
  } catch (error) {
    if (error instanceof LeaseLostError) {
      outcome = { kind: 'fenced', reason: error.reason };
      attempts = 'keep';
    } else if (error instanceof ChainMovedError) {
      outcome = { kind: 'chain_moved', reason: error.message };
      attempts = 'keep';
      nextRunInMs = Math.min(opts.followIntervalMs, 1_000);
    } else {
      const message = (error as Error).message.slice(0, 2000);
      nextRunInMs = backoffMs(meta.attempts, opts);
      attempts = 'increment';
      outcome = { kind: 'error', message, retryInMs: nextRunInMs };
      // Only the current generation may record an error; a fenced worker stays silent.
      const updated = await pool.query(
        `UPDATE indexer_sources SET status='error',last_error=$3,last_error_at=now(),updated_at=now() WHERE id=$1 AND generation=$2 AND desired_state='running'`,
        [lease.sourceId, lease.generation, message],
      );
      if (updated.rowCount) {
        await opsLog(pool, meta, meta.attempts >= 3 ? 'ERROR' : 'WARN', 'Indexer step failed; retrying with backoff', { error: message, attempt: meta.attempts + 1, retryInMs: nextRunInMs });
      }
    }
  }
  await releaseLease(pool, lease, nextRunInMs, { attempts, chunkSize });
  return outcome;
}

/** Claim and process due sources until none are due or `maxSteps` is reached. */
export async function runIndexerTick(pool: pg.Pool, adapter: EvmAdapter, opts: IndexerOptions, maxSteps = 25): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const lease = await claimNextLease(pool, opts.workerId, opts.leaseTtlMs);
    if (!lease) break;
    outcomes.push(await processLease(pool, adapter, lease, opts));
  }
  return outcomes;
}
