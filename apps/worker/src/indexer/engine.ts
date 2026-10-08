import type pg from 'pg';
import type { Abi } from 'viem';
import { EvmAdapter, RpcResponseError, RpcTransportError, type EvmBlockHeader, type EvmLog } from '@palletdock/chain';
import { decodeLog } from './decode.js';

export interface IndexerOptions {
  workerId: string;
  /** Lease duration; renewed on every commit. */
  leaseMs?: number;
  maxChunk?: number;
  minChunk?: number;
  /** Poll interval once the source has caught up with the observed head. */
  pollMs?: number;
  /** Headers retained per source for ancestry checks; reorgs deeper than this need recovery. */
  headerRetention?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Max chunks processed per claim before releasing the lease. */
  maxChunksPerClaim?: number;
  random?: () => number;
  /** Restrict claims to these sources (tests, targeted runs). */
  onlySourceIds?: string[];
  /** Test hook invoked after logs are fetched and before commit. */
  beforeCommit?: (ctx: { sourceId: string; fromBlock: bigint; toBlock: bigint }) => Promise<void>;
}

interface Claim {
  sourceId: string;
  leaseToken: string;
  generation: string;
  chunkSize: number;
  attempts: number;
}

interface SourceRow {
  id: string;
  project_id: string;
  fingerprint_id: string;
  abi_version_id: string;
  contract_address: string;
  event_topics: string[];
  start_block: string;
  end_block: string | null;
  status: string;
  abi: Abi;
  active_fingerprint: string | null;
  checkpoint_block: string | null;
  checkpoint_hash: string | null;
}

export type RunResult =
  | { kind: 'idle' }
  | { kind: 'progress'; sourceId: string; committedTo: string; logs: number }
  | { kind: 'caught_up'; sourceId: string }
  | { kind: 'reorg'; sourceId: string; ancestor: string; orphaned: number }
  | { kind: 'recovery_required'; sourceId: string; reason: string }
  | { kind: 'fenced'; sourceId: string }
  | { kind: 'backoff'; sourceId: string; error: string; retryInMs: number };

export class FencedError extends Error {
  constructor(message = 'Lease or generation changed; commit discarded.') {
    super(message);
    this.name = 'FencedError';
  }
}

class InconsistentRangeError extends Error {}

const RANGE_ERROR_RE = /(range|block range|too many|limit|exceed|response size|query returned more than|max results)/i;

export function isRangeTooLarge(error: unknown): boolean {
  if (error instanceof RpcResponseError) return error.code === -32005 || RANGE_ERROR_RE.test(error.message);
  if (error instanceof RpcTransportError) return error.kind === 'response_too_large';
  return false;
}

export class IndexerEngine {
  private readonly o: Required<Omit<IndexerOptions, 'beforeCommit' | 'onlySourceIds'>> & Pick<IndexerOptions, 'beforeCommit' | 'onlySourceIds'>;

  constructor(
    private readonly pool: pg.Pool,
    private readonly evm: EvmAdapter,
    options: IndexerOptions,
  ) {
    this.o = {
      leaseMs: 30_000,
      maxChunk: 2_000,
      minChunk: 1,
      pollMs: 6_000,
      headerRetention: 512,
      backoffBaseMs: 1_000,
      backoffMaxMs: 120_000,
      maxChunksPerClaim: 20,
      random: Math.random,
      ...options,
    };
  }

  /** Claim one runnable source (if any) and advance it. */
  async runOnce(): Promise<RunResult[]> {
    const claim = await this.claim();
    if (!claim) return [{ kind: 'idle' }];
    const results: RunResult[] = [];
    try {
      for (let i = 0; i < this.o.maxChunksPerClaim; i++) {
        const r = await this.step(claim);
        results.push(r);
        if (r.kind !== 'progress') break;
      }
    } finally {
      await this.release(claim);
    }
    return results;
  }

  /** Run until idle (useful for tests and backfills). */
  async drain(maxRounds = 1000): Promise<RunResult[]> {
    const all: RunResult[] = [];
    for (let i = 0; i < maxRounds; i++) {
      const r = await this.runOnce();
      all.push(...r);
      if (r.every((x) => x.kind === 'idle')) break;
    }
    return all;
  }

  async claim(): Promise<Claim | null> {
    const r = await this.pool.query(
      `WITH candidate AS (
         SELECT j.source_id FROM indexer_jobs j
           JOIN indexer_sources s ON s.id=j.source_id
           JOIN projects p ON p.id=s.project_id
          WHERE s.desired_state='running' AND p.archived_at IS NULL
            AND s.status NOT IN ('recovery_required','completed','stopped')
            AND j.next_run_at <= now()
            AND (j.lease_expires_at IS NULL OR j.lease_expires_at < now())
            AND ($2::uuid[] IS NULL OR j.source_id = ANY($2::uuid[]))
          ORDER BY j.next_run_at, j.source_id
          LIMIT 1
          FOR UPDATE OF j SKIP LOCKED)
       UPDATE indexer_jobs j
          SET lease_owner=$1, lease_token=gen_random_uuid(), lease_expires_at=now() + ($3::int * interval '1 millisecond'),
              lease_generation=s.generation, updated_at=now()
         FROM candidate, indexer_sources s
        WHERE j.source_id=candidate.source_id AND s.id=j.source_id
       RETURNING j.source_id, j.lease_token, j.lease_generation::text AS generation, j.chunk_size, j.attempts`,
      [this.o.workerId, this.o.onlySourceIds ?? null, this.o.leaseMs],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return { sourceId: row.source_id, leaseToken: row.lease_token, generation: row.generation, chunkSize: row.chunk_size, attempts: row.attempts };
  }

  private async release(claim: Claim): Promise<void> {
    await this.pool.query(
      `UPDATE indexer_jobs SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=now() WHERE source_id=$1 AND lease_token=$2`,
      [claim.sourceId, claim.leaseToken],
    );
  }

  private async loadSource(sourceId: string): Promise<SourceRow> {
    const r = await this.pool.query(
      `SELECT s.id,s.project_id,s.fingerprint_id,s.abi_version_id,s.contract_address,s.event_topics,s.start_block::text,s.end_block::text,s.status,
              a.abi,
              (SELECT f.id FROM network_fingerprints f WHERE f.network_id='portaldot-v3-testnet' AND f.status='active') AS active_fingerprint,
              c.block_number::text AS checkpoint_block, c.block_hash AS checkpoint_hash
         FROM indexer_sources s
         JOIN abi_versions a ON a.id=s.abi_version_id
         LEFT JOIN indexer_checkpoints c ON c.source_id=s.id
        WHERE s.id=$1`,
      [sourceId],
    );
    return r.rows[0];
  }

  /** Lock the job+source rows and verify the lease/generation still belong to this claim. */
  private async fence(c: pg.PoolClient, claim: Claim): Promise<void> {
    const r = await c.query(
      `SELECT 1 FROM indexer_jobs j JOIN indexer_sources s ON s.id=j.source_id JOIN projects p ON p.id=s.project_id
        WHERE j.source_id=$1 AND j.lease_token=$2 AND j.lease_expires_at > now()
          AND s.generation=$3::bigint AND s.desired_state='running' AND p.archived_at IS NULL
        FOR UPDATE OF j, s`,
      [claim.sourceId, claim.leaseToken, claim.generation],
    );
    if (!r.rowCount) throw new FencedError();
  }

  private async tx<T>(claim: Claim, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await this.fence(c, claim);
      const out = await fn(c);
      await c.query(
        `UPDATE indexer_jobs SET lease_expires_at=now() + ($3::int * interval '1 millisecond'), updated_at=now() WHERE source_id=$1 AND lease_token=$2`,
        [claim.sourceId, claim.leaseToken, this.o.leaseMs],
      );
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  private async opsLog(projectId: string | null, sourceId: string | null, level: 'INFO' | 'WARN' | 'ERROR', message: string, detail: unknown, client?: pg.PoolClient) {
    await (client ?? this.pool).query(
      `INSERT INTO ops_logs(project_id,source,level,message,detail,indexer_source_id) VALUES ($1,'indexer',$2,$3,$4,$5)`,
      [projectId, level, message.slice(0, 500), detail === undefined ? null : JSON.stringify(detail), sourceId],
    );
  }

  async step(claim: Claim): Promise<RunResult> {
    const src = await this.loadSource(claim.sourceId);
    if (!src.active_fingerprint || src.active_fingerprint !== src.fingerprint_id) {
      const reason = src.active_fingerprint
        ? 'The active network fingerprint differs from the one this source was created on. Records are not reused across a network reset; an explicit migration is required.'
        : 'No verified network fingerprint is active. Indexing waits for a verified network identity.';
      if (src.active_fingerprint) return this.markRecovery(claim, src, reason);
      return this.backoff(claim, src, new Error(reason));
    }
    try {
      return await this.advance(claim, src);
    } catch (e) {
      if (e instanceof FencedError) {
        await this.opsLog(src.project_id, src.id, 'WARN', 'Indexer commit discarded: lease or generation changed (paused, archived, or reclaimed).', { generation: claim.generation });
        return { kind: 'fenced', sourceId: src.id };
      }
      if (e instanceof InconsistentRangeError) {
        // Chain moved during the fetch; retry soon without counting as an RPC failure.
        await this.pool.query(`UPDATE indexer_jobs SET next_run_at=now() + interval '1 second' WHERE source_id=$1`, [src.id]);
        return { kind: 'backoff', sourceId: src.id, error: e.message, retryInMs: 1000 };
      }
      return this.backoff(claim, src, e as Error);
    }
  }

  private async advance(claim: Claim, src: SourceRow): Promise<RunResult> {
    const head = BigInt(await this.evm.blockNumber());
    const startBlock = BigInt(src.start_block);
    const endBlock = src.end_block === null ? null : BigInt(src.end_block);
    const target = endBlock === null ? head : endBlock < head ? endBlock : head;

    // 1. Verify the checkpoint is still canonical; otherwise roll back to a common ancestor.
    if (src.checkpoint_block !== null) {
      const cpHeader = await this.evm.blockHeader(BigInt(src.checkpoint_block));
      if (!cpHeader || cpHeader.hash.toLowerCase() !== src.checkpoint_hash!.toLowerCase()) {
        return this.handleReorg(claim, src);
      }
    }

    const from = src.checkpoint_block === null ? startBlock : BigInt(src.checkpoint_block) + 1n;
    if (from > target) {
      const done = endBlock !== null && from > endBlock;
      await this.tx(claim, async (c) => {
        await c.query(
          `UPDATE indexer_sources SET status=$2, latest_observed_block=$3, latest_observed_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`,
          [src.id, done ? 'completed' : 'following', head.toString()],
        );
        await c.query(`UPDATE indexer_jobs SET attempts=0, next_run_at=now() + ($2::int * interval '1 millisecond') WHERE source_id=$1`, [src.id, this.o.pollMs]);
      });
      return { kind: 'caught_up', sourceId: src.id };
    }

    let chunk = BigInt(Math.max(this.o.minChunk, Math.min(claim.chunkSize, this.o.maxChunk)));
    let to = from + chunk - 1n;
    if (to > target) to = target;

    // 2. Fetch logs, shrinking the range when the node rejects it.
    let logs: EvmLog[];
    for (;;) {
      try {
        logs = await this.evm.logs({ address: src.contract_address, fromBlock: from, toBlock: to, topics: [src.event_topics as `0x${string}`[]] });
        break;
      } catch (e) {
        if (isRangeTooLarge(e) && to > from) {
          chunk = (to - from + 1n) / 2n;
          if (chunk < BigInt(this.o.minChunk)) chunk = BigInt(this.o.minChunk);
          to = from + chunk - 1n;
          claim.chunkSize = Number(chunk);
          continue;
        }
        throw e;
      }
    }

    // 3. Headers: range boundaries and every block that produced a log.
    const numbers = new Set<bigint>([from, to]);
    for (const l of logs) numbers.add(BigInt(l.blockNumber));
    const headers = new Map<string, EvmBlockHeader>();
    for (const n of [...numbers].sort((a, b) => (a < b ? -1 : 1))) {
      const h = await this.evm.blockHeader(n);
      if (!h) throw new InconsistentRangeError(`Block ${n} is not available yet.`);
      headers.set(n.toString(), h);
    }
    const fromHeader = headers.get(from.toString())!;
    if (src.checkpoint_block !== null && fromHeader.parentHash.toLowerCase() !== src.checkpoint_hash!.toLowerCase()) {
      // Parent link broken: the checkpoint was reorganized away after we checked it.
      return this.handleReorg(claim, src);
    }
    for (const l of logs) {
      const h = headers.get(l.blockNumber)!;
      if (h.hash.toLowerCase() !== l.blockHash.toLowerCase()) throw new InconsistentRangeError(`Log block hash ${l.blockHash} is no longer canonical at ${l.blockNumber}.`);
      if (l.address.toLowerCase() !== src.contract_address.toLowerCase()) throw new Error('RPC returned a log for an unrequested address.');
    }
    // Re-read the range end after fetching logs to detect a reorg during the fetch.
    const toAgain = await this.evm.blockHeader(to);
    if (!toAgain || toAgain.hash.toLowerCase() !== headers.get(to.toString())!.hash.toLowerCase()) {
      throw new InconsistentRangeError('Chain head changed during the fetch.');
    }

    await this.o.beforeCommit?.({ sourceId: src.id, fromBlock: from, toBlock: to });

    // 4. Atomic commit: logs + decoded rows + headers + checkpoint + status, fenced.
    const toHeader = headers.get(to.toString())!;
    const inserted = await this.tx(claim, async (c) => {
      const cp = await c.query('SELECT block_number::text FROM indexer_checkpoints WHERE source_id=$1 FOR UPDATE', [src.id]);
      const current = cp.rowCount ? cp.rows[0].block_number : null;
      if (current !== src.checkpoint_block) throw new FencedError('Checkpoint moved concurrently; commit discarded.');
      let n = 0;
      for (const l of logs) {
        const ins = await c.query(
          `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (source_id,fingerprint_id,block_hash,transaction_hash,log_index) DO NOTHING
           RETURNING id`,
          [src.id, src.project_id, src.fingerprint_id, l.address.toLowerCase(), l.blockNumber, l.blockHash.toLowerCase(), l.transactionHash.toLowerCase(), l.transactionIndex, l.logIndex, l.topics.map((t) => t.toLowerCase()), l.data.toLowerCase()],
        );
        if (!ins.rowCount) continue;
        n++;
        const d = decodeLog(src.abi, l.topics, l.data);
        await c.query(
          `INSERT INTO decoded_events(raw_log_id,abi_version_id,status,event_name,event_signature,args,decode_error) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ins.rows[0].id, src.abi_version_id, d.status, d.eventName, d.eventSignature, d.args === null ? null : JSON.stringify(d.args), 'error' in d ? d.error : null],
        );
      }
      for (const h of headers.values()) {
        await c.query(
          `INSERT INTO block_headers(fingerprint_id,source_id,block_number,block_hash,parent_hash,block_timestamp) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (source_id,block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,parent_hash=EXCLUDED.parent_hash,block_timestamp=EXCLUDED.block_timestamp,observed_at=now()`,
          [src.fingerprint_id, src.id, h.number, h.hash.toLowerCase(), h.parentHash.toLowerCase(), h.timestamp],
        );
      }
      await c.query(
        `DELETE FROM block_headers WHERE source_id=$1 AND block_number NOT IN (SELECT block_number FROM block_headers WHERE source_id=$1 ORDER BY block_number DESC LIMIT $2)`,
        [src.id, this.o.headerRetention],
      );
      await c.query(
        `INSERT INTO indexer_checkpoints(source_id,block_number,block_hash,committed_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (source_id) DO UPDATE SET block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, committed_at=now()`,
        [src.id, to.toString(), toHeader.hash.toLowerCase()],
      );
      const caughtUp = to >= target;
      const done = endBlock !== null && to >= endBlock;
      await c.query(
        `UPDATE indexer_sources SET status=$2, latest_observed_block=$3, latest_observed_at=now(), last_error=NULL, updated_at=now() WHERE id=$1`,
        [src.id, done ? 'completed' : caughtUp ? 'following' : 'backfilling', head.toString()],
      );
      // Grow the chunk again after a successful fetch (adaptive).
      const nextChunk = Math.min(this.o.maxChunk, Math.max(this.o.minChunk, claim.chunkSize * 2));
      claim.chunkSize = nextChunk;
      await c.query(
        `UPDATE indexer_jobs SET attempts=0, chunk_size=$2, next_run_at=now() + ($3::int * interval '1 millisecond') WHERE source_id=$1`,
        [src.id, nextChunk, caughtUp ? this.o.pollMs : 0],
      );
      if (logs.length) {
        await c.query(
          `UPDATE transactions SET indexing_status='indexed', updated_at=now()
            WHERE project_id=$1 AND fingerprint_id=$2 AND lower(hash) = ANY($3::text[])`,
          [src.project_id, src.fingerprint_id, logs.map((l) => l.transactionHash.toLowerCase())],
        );
      }
      if (claim.attempts > 0) {
        await this.opsLog(src.project_id, src.id, 'INFO', `Recovered after ${claim.attempts} failed attempt(s); resumed from stored checkpoint.`, { fromBlock: from.toString(), toBlock: to.toString() }, c);
      }
      await this.opsLog(src.project_id, src.id, 'INFO', `Checkpoint committed at ${to.toString()}`, { fromBlock: from.toString(), toBlock: to.toString(), head: head.toString(), logs: logs.length, inserted: n }, c);
      return n;
    });
    claim.attempts = 0;
    return { kind: 'progress', sourceId: src.id, committedTo: to.toString(), logs: inserted };
  }

  private async handleReorg(claim: Claim, src: SourceRow): Promise<RunResult> {
    const stored = await this.pool.query(
      `SELECT block_number::text, block_hash FROM block_headers WHERE source_id=$1 AND block_number <= $2 ORDER BY block_number DESC`,
      [src.id, src.checkpoint_block],
    );
    let ancestor: { number: string; hash: string } | null = null;
    for (const row of stored.rows) {
      const h = await this.evm.blockHeader(BigInt(row.block_number));
      if (h && h.hash.toLowerCase() === row.block_hash.toLowerCase()) {
        ancestor = { number: row.block_number, hash: row.block_hash };
        break;
      }
    }
    if (!ancestor) {
      return this.markRecovery(
        claim,
        src,
        `Reorganization deeper than retained header ancestry (checkpoint ${src.checkpoint_block}). Stored records may not be canonical; reindex from the start block is required.`,
      );
    }
    const orphaned = await this.tx(claim, async (c) => {
      const o = await c.query(
        `UPDATE raw_logs SET canonical=false, orphaned_at=now() WHERE source_id=$1 AND canonical=true AND block_number > $2::bigint RETURNING transaction_hash`,
        [src.id, ancestor!.number],
      );
      await c.query(`DELETE FROM block_headers WHERE source_id=$1 AND block_number > $2::bigint`, [src.id, ancestor!.number]);
      await c.query(`UPDATE indexer_checkpoints SET block_number=$2, block_hash=$3, committed_at=now() WHERE source_id=$1`, [src.id, ancestor!.number, ancestor!.hash]);
      await c.query(`UPDATE indexer_sources SET reorg_epoch=reorg_epoch+1, status='backfilling', updated_at=now() WHERE id=$1`, [src.id]);
      await c.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [src.id]);
      if (o.rowCount) {
        await c.query(
          `UPDATE transactions SET indexing_status='pending', updated_at=now() WHERE project_id=$1 AND lower(hash) = ANY($2::text[])`,
          [src.project_id, o.rows.map((r) => r.transaction_hash)],
        );
      }
      await this.opsLog(src.project_id, src.id, 'WARN', `Reorganization detected; rolled back to common ancestor ${ancestor!.number}.`, { previousCheckpoint: src.checkpoint_block, ancestor, orphanedLogs: o.rowCount }, c);
      return o.rowCount ?? 0;
    });
    return { kind: 'reorg', sourceId: src.id, ancestor: ancestor.number, orphaned };
  }

  private async markRecovery(claim: Claim, src: SourceRow, reason: string): Promise<RunResult> {
    await this.tx(claim, async (c) => {
      await c.query(`UPDATE indexer_sources SET status='recovery_required', last_error=$2, last_error_at=now(), updated_at=now() WHERE id=$1`, [src.id, reason]);
      await this.opsLog(src.project_id, src.id, 'ERROR', 'Indexer needs recovery', { reason }, c);
    }).catch((e) => {
      if (!(e instanceof FencedError)) throw e;
    });
    return { kind: 'recovery_required', sourceId: src.id, reason };
  }

  private async backoff(claim: Claim, src: SourceRow, error: Error): Promise<RunResult> {
    const attempts = claim.attempts + 1;
    claim.attempts = attempts;
    const exp = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** Math.min(attempts - 1, 16));
    const retryInMs = Math.round(exp / 2 + this.o.random() * (exp / 2)); // "equal jitter"
    const message = error.message.slice(0, 1000);
    await this.pool.query(
      `UPDATE indexer_jobs SET attempts=$2, next_run_at=now() + ($3::int * interval '1 millisecond'), updated_at=now() WHERE source_id=$1 AND lease_token=$4`,
      [src.id, attempts, retryInMs, claim.leaseToken],
    );
    await this.pool.query(
      `UPDATE indexer_sources SET status='error', last_error=$2, last_error_at=now(), updated_at=now() WHERE id=$1 AND generation=$3::bigint AND desired_state='running'`,
      [src.id, message, claim.generation],
    );
    await this.opsLog(src.project_id, src.id, 'ERROR', `RPC request failed; retrying in ${Math.round(retryInMs / 1000)} s`, {
      error: message,
      kind: error instanceof RpcTransportError ? error.kind : error instanceof RpcResponseError ? `rpc_${error.code}` : 'error',
      attempts,
    });
    return { kind: 'backoff', sourceId: src.id, error: message, retryInMs };
  }
}
