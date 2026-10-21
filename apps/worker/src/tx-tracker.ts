import type pg from 'pg';
import { createHash } from 'node:crypto';
import type { EvmAdapter, EvmReceipt } from '@palletdock/chain';
import { stringifyLossless } from '@palletdock/shared';
import { isPrunedStateError } from './indexer/engine.js';

export interface TrackerOptions {
  batch?: number;
  /** Stop re-checking an included receipt once it is this many blocks deep (capped by observed pruning, see below). */
  confirmations?: number;
  /** Fraction of the shallowest observed pruning depth that confirmations may use (safety margin). */
  retentionSafetyFraction?: number;
  /** Bounded retry after a failed or ambiguous check. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxCheckFailures?: number;
  /** Poll interval while waiting for inclusion, and how long to wait before giving up. */
  pendingIntervalMs?: number;
  pendingMaxIntervalMs?: number;
  pendingMaxAgeMs?: number;
}

const DEFAULTS: Required<Omit<TrackerOptions, 'batch'>> = {
  confirmations: Number(process.env.PALLETDOCK_RECEIPT_CONFIRMATIONS ?? 24),
  retentionSafetyFraction: 0.5,
  retryBaseMs: 4_000,
  retryMaxMs: 10 * 60_000,
  maxCheckFailures: 8,
  pendingIntervalMs: 4_000,
  pendingMaxIntervalMs: 60_000,
  pendingMaxAgeMs: 2 * 60 * 60_000,
};

type Row = Record<string, any>;

/**
 * Polls receipts for tracked transactions. Inclusion, execution, finality and
 * indexing are recorded independently. Finality is always left 'unknown': no
 * adapter proving EVM-block-to-native-finality exists yet.
 *
 * A receipt that stops being returned is not, by itself, a reorganization:
 * the node may have pruned it. Only a different canonical block hash at the
 * recorded height is a reorg. Pruned history keeps the last snapshot and ends
 * tracking (history_pruned). RPC errors and ambiguous answers never change
 * stored data; they are retried with bounded backoff and tracking stops after
 * a fixed number of failures. Every tracked hash reaches a terminal state, so
 * nothing is polled indefinitely.
 */
export class TransactionTracker {
  private readonly o: Required<Omit<TrackerOptions, 'batch'>> & { batch: number };
  /** Shallowest depth at which this node was seen to have pruned a block (learned, not assumed). */
  private observedPrunedDepth: bigint | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly evm: EvmAdapter,
    opts: TrackerOptions = {},
  ) {
    this.o = { ...DEFAULTS, batch: 25, ...opts };
  }

  /** Confirmation depth actually used: the configured value, kept under the observed pruning depth with a margin. */
  get effectiveConfirmations(): bigint {
    const configured = BigInt(Math.max(1, Math.floor(this.o.confirmations)));
    if (this.observedPrunedDepth === null) return configured;
    const cap = BigInt(Math.max(1, Math.floor(Number(this.observedPrunedDepth) * this.o.retentionSafetyFraction)));
    return configured < cap ? configured : cap;
  }

  /** Check a batch of tracked transactions. `failed` counts RPC/DB errors (drives worker backoff). */
  async runOnce(): Promise<{ checked: number; changed: number; failed: number }> {
    const rows = (
      await this.pool.query(
        `SELECT t.id,t.project_id,t.fingerprint_id,t.hash,t.kind,t.origin,t.from_address,t.to_address,t.inclusion_status,t.execution_status,t.block_hash,t.artifact_id,t.contract_id,t.input,
                t.abi_version_id,t.created_at,t.check_failures,p.archived_at
           FROM transactions t JOIN projects p ON p.id=t.project_id
           JOIN network_fingerprints f ON f.id=t.fingerprint_id AND f.status='active'
          WHERE t.hash IS NOT NULL AND t.tracking_status='active'
            AND (t.next_check_at IS NULL OR t.next_check_at <= now())
          ORDER BY t.next_check_at NULLS FIRST, t.created_at
          LIMIT $1`,
        [this.o.batch],
      )
    ).rows;
    let changed = 0;
    let failed = 0;
    let head: Promise<bigint> | null = null;
    const latest = () => (head ??= this.evm.blockNumber().then(BigInt));
    for (const t of rows) {
      try {
        if (await this.check(t, latest)) changed++;
      } catch (e) {
        failed++;
        await this.recordFailure(t, e);
      }
    }
    return { checked: rows.length, changed, failed };
  }

  private async observe(c: pg.PoolClient | pg.Pool, txId: string, stage: string, detail: string, data: unknown = null, source = 'worker:eth_getTransactionReceipt') {
    await c.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source,data) VALUES ($1,$2,$3,$4,$5)`, [
      txId,
      stage,
      detail,
      source,
      data === null ? null : stringifyLossless(data),
    ]);
  }

  /** A failed or ambiguous check: keep all data, retry with bounded backoff, stop after maxCheckFailures. */
  private async recordFailure(t: Row, error: unknown) {
    const failures = Number(t.check_failures ?? 0) + 1;
    const message = (error as Error)?.message?.slice(0, 500) ?? String(error);
    if (failures >= this.o.maxCheckFailures) {
      await this.pool.query(`UPDATE transactions SET tracking_status='gave_up', check_failures=$2, next_check_at=NULL, last_checked_at=now() WHERE id=$1`, [t.id, failures]);
      await this.observe(this.pool, t.id, 'tracking_stopped', `Stopped after ${failures} failed checks. Stored data is unchanged; use Check account activity to recheck.`, {
        failures,
        lastError: message,
      });
    } else {
      const delay = Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** (failures - 1));
      await this.pool.query(
        `UPDATE transactions SET check_failures=$2, next_check_at=now() + ($3::int * interval '1 millisecond'), last_checked_at=now() WHERE id=$1`,
        [t.id, failures, delay],
      );
    }
    await this.pool.query(`INSERT INTO ops_logs(project_id,source,level,message,detail,transaction_id) VALUES ($1,'transaction','WARN',$2,$3,$4)`, [
      t.project_id,
      failures >= this.o.maxCheckFailures ? `Receipt check failed ${failures} times; tracking stopped.` : 'Receipt check failed; will retry with backoff.',
      JSON.stringify({ error: message, failures }),
      t.id,
    ]);
  }

  private pendingDelayMs(createdAt: Date): number {
    const age = Date.now() - new Date(createdAt).getTime();
    return Math.min(this.o.pendingMaxIntervalMs, Math.max(this.o.pendingIntervalMs, Math.floor(age / 10)));
  }

  private async check(t: Row, latest: () => Promise<bigint>): Promise<boolean> {
    const receipt = await this.evm.receipt(t.hash);
    if (!receipt) return this.noReceipt(t, latest);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query('SELECT inclusion_status,block_number::text,block_hash FROM transactions WHERE id=$1 FOR UPDATE', [t.id])).rows[0];
      if (cur.inclusion_status === 'included' && cur.block_hash?.toLowerCase() === receipt.blockHash.toLowerCase()) {
        await client.query('COMMIT');
        return this.stillIncluded(t, BigInt(receipt.blockNumber), receipt.blockHash, latest);
      }
      // The hash came from the browser; make sure the receipt belongs to the reviewed request.
      const fromMismatch = t.from_address && receipt.from.toLowerCase() !== String(t.from_address).toLowerCase();
      const toMismatch = t.origin === 'palletdock' && (t.kind === 'deploy' ? receipt.to !== null : (receipt.to ?? '').toLowerCase() !== String(t.to_address ?? '').toLowerCase());
      if (fromMismatch || toMismatch) {
        const already = await client.query(`SELECT 1 FROM transaction_observations WHERE transaction_id=$1 AND stage='receipt_mismatch'`, [t.id]);
        await client.query(
          `UPDATE transactions SET last_checked_at=now(), next_check_at=now() + ($3::int * interval '1 millisecond'), error_message=$2, updated_at=now() WHERE id=$1`,
          [t.id, 'The receipt for this hash does not match the reviewed sender/recipient. The receipt was not applied.', this.pendingDelayMs(t.created_at)],
        );
        if (!already.rowCount) {
          await this.observe(client, t.id, 'receipt_mismatch', `Receipt from ${receipt.from} to ${receipt.to ?? 'contract creation'} does not match the prepared request (${t.from_address} → ${t.to_address ?? 'contract creation'}).`);
        }
        await client.query('COMMIT');
        return false;
      }
      await this.applyReceipt(client, t, receipt, cur.inclusion_status === 'included' || cur.inclusion_status === 'reorged_out');
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async applyReceipt(client: pg.PoolClient, t: Row, receipt: EvmReceipt, moved: boolean) {
    await client.query(
      `UPDATE transactions SET inclusion_status='included', execution_status=$2, block_number=$3, block_hash=$4, gas_used=$5,
              effective_gas_price=$6, fee_raw=$7, receipt=$8, contract_address=COALESCE($9, contract_address),
              from_address=COALESCE(from_address,$10), indexing_status=CASE WHEN $11::int = 0 THEN 'no_events' WHEN indexing_status='indexed' THEN 'indexed'
                WHEN EXISTS (SELECT 1 FROM indexer_sources s WHERE s.project_id=transactions.project_id AND s.desired_state <> 'deleted'
                             AND lower(s.contract_address) = ANY($12::text[])) THEN 'pending' ELSE 'not_covered' END,
              check_failures=0, next_check_at=now() + ($13::int * interval '1 millisecond'), last_checked_at=now(), updated_at=now()
        WHERE id=$1`,
      [
        t.id,
        receipt.status === 'success' ? 'success' : receipt.status === 'reverted' ? 'reverted' : 'unknown',
        receipt.blockNumber,
        receipt.blockHash.toLowerCase(),
        receipt.gasUsed,
        receipt.effectiveGasPrice,
        receipt.actualFee,
        stringifyLossless(receipt.raw),
        receipt.contractAddress?.toLowerCase() ?? null,
        receipt.from.toLowerCase(),
        receipt.logs.length,
        [...new Set(receipt.logs.map((l) => l.address.toLowerCase()))],
        this.o.pendingIntervalMs,
      ],
    );
    await this.observe(client, t.id, moved ? 'receipt_moved' : 'receipt_observed', `Receipt observed in block ${receipt.blockNumber} (${receipt.blockHash}). Inclusion only; finality not confirmed.`, {
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      status: receipt.status,
    });
    await this.observe(
      client,
      t.id,
      receipt.status === 'success' ? 'execution_succeeded' : receipt.status === 'reverted' ? 'execution_reverted' : 'execution_unknown',
      receipt.status === 'reverted' ? 'Receipt status 0x0. A reverted transaction may still be charged a fee.' : receipt.status === 'success' ? 'Receipt status 0x1.' : 'Receipt has no status field.',
      { status: receipt.status },
    );
    if (t.kind === 'deploy' && receipt.status === 'success' && receipt.contractAddress && !t.contract_id && t.artifact_id) {
      await this.trackDeployedContract(client, t, receipt.contractAddress, receipt.blockNumber);
    }
  }

  /** Receipt unchanged: settle once it is deep enough, otherwise check again later. */
  private async stillIncluded(t: Row, block: bigint, blockHash: string, latest: () => Promise<bigint>): Promise<boolean> {
    const head = await latest();
    const depth = head >= block ? head - block : 0n;
    const needed = this.effectiveConfirmations;
    if (depth >= needed) {
      await this.pool.query(`UPDATE transactions SET tracking_status='settled', check_failures=0, next_check_at=NULL, last_checked_at=now() WHERE id=$1`, [t.id]);
      await this.observe(this.pool, t.id, 'tracking_settled', `Receipt unchanged at ${depth} blocks deep (≥ ${needed} confirmations). Receipt checks stopped; finality is still not confirmed.`, {
        blockNumber: block.toString(),
        blockHash: blockHash.toLowerCase(),
        head: head.toString(),
        depth: depth.toString(),
        confirmations: needed.toString(),
      });
      return true;
    }
    await this.pool.query(`UPDATE transactions SET check_failures=0, next_check_at=now() + ($2::int * interval '1 millisecond'), last_checked_at=now() WHERE id=$1`, [
      t.id,
      this.o.pendingIntervalMs,
    ]);
    return false;
  }

  /** No receipt returned. For an included transaction, decide between pruned history, a real reorg, or an ambiguous answer. */
  private async noReceipt(t: Row, latest: () => Promise<bigint>): Promise<boolean> {
    const cur = (await this.pool.query(`SELECT inclusion_status,block_number::text,block_hash,receipt FROM transactions WHERE id=$1`, [t.id])).rows[0];
    if (cur.inclusion_status === 'included' && cur.block_number && cur.block_hash) {
      const block = BigInt(cur.block_number);
      let header: Awaited<ReturnType<EvmAdapter['blockHeader']>>;
      try {
        header = await this.evm.blockHeader(block);
      } catch (e) {
        if (isPrunedStateError(e)) return this.markPruned(t, cur, latest, 'The node discarded the state for this block', (e as Error).message);
        throw e; // transient or unknown: retried with backoff, data untouched
      }
      if (header === null) throw new Error(`No canonical block returned at height ${block}; ambiguous, will retry`);
      if (header.hash.toLowerCase() === String(cur.block_hash).toLowerCase()) {
        return this.markPruned(t, cur, latest, 'The block is still canonical but the node no longer returns this receipt', null);
      }
      return this.markReorged(t, cur, header.hash);
    }
    // Waiting for (re-)inclusion: poll with a growing interval, give up after the pending window.
    const age = Date.now() - new Date(t.created_at).getTime();
    if (age > this.o.pendingMaxAgeMs) {
      await this.pool.query(`UPDATE transactions SET tracking_status='gave_up', next_check_at=NULL, last_checked_at=now() WHERE id=$1`, [t.id]);
      await this.observe(this.pool, t.id, 'tracking_stopped', `No receipt within ${Math.round(this.o.pendingMaxAgeMs / 60_000)} minutes. This is not proof the transaction failed; use Check account activity to recheck.`, {
        ageMs: age,
      });
      return true;
    }
    await this.pool.query(
      `UPDATE transactions SET last_checked_at=now(), check_failures=0, next_check_at=now() + ($2::int * interval '1 millisecond'),
              inclusion_status=CASE WHEN inclusion_status='not_observed' THEN 'pending' ELSE inclusion_status END WHERE id=$1`,
      [t.id, this.pendingDelayMs(t.created_at)],
    );
    return false;
  }

  private async markPruned(t: Row, cur: Row, latest: () => Promise<bigint>, reason: string, nodeError: string | null): Promise<boolean> {
    let head: bigint | null = null;
    try {
      head = await latest();
    } catch {
      head = null;
    }
    const block = BigInt(cur.block_number);
    const depth = head !== null && head >= block ? head - block : null;
    if (depth !== null && nodeError !== null && (this.observedPrunedDepth === null || depth < this.observedPrunedDepth)) this.observedPrunedDepth = depth;
    await this.pool.query(`UPDATE transactions SET tracking_status='history_pruned', check_failures=0, next_check_at=NULL, last_checked_at=now() WHERE id=$1`, [t.id]);
    await this.observe(
      this.pool,
      t.id,
      'history_pruned',
      `${reason}${depth !== null ? ` (${depth} blocks deep)` : ''}. The last observed receipt, block ${cur.block_number}, and block hash are kept. This is not a failure or a reorganization.`,
      { blockNumber: cur.block_number, blockHash: cur.block_hash, head: head?.toString() ?? null, depth: depth?.toString() ?? null, receiptKept: cur.receipt !== null, nodeError },
    );
    return true;
  }

  private async markReorged(t: Row, cur: Row, canonicalHash: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE transactions SET inclusion_status='reorged_out', execution_status='unknown', block_number=NULL, block_hash=NULL, receipt=NULL,
                check_failures=0, next_check_at=now() + ($2::int * interval '1 millisecond'), last_checked_at=now(), updated_at=now() WHERE id=$1`,
        [t.id, this.o.pendingIntervalMs],
      );
      await this.observe(
        client,
        t.id,
        'receipt_disappeared',
        `Block ${cur.block_number} is now ${canonicalHash}, not ${cur.block_hash}: the block holding this transaction was reorganized out. It may be re-included.`,
        { previousBlockNumber: cur.block_number, previousBlockHash: cur.block_hash, canonicalBlockHash: canonicalHash.toLowerCase(), previousReceipt: cur.receipt },
      );
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async trackDeployedContract(c: pg.PoolClient, t: Row, address: string, block: string) {
    const art = (await c.query('SELECT name, contract_name, abi FROM artifacts WHERE id=$1 AND project_id=$2', [t.artifact_id, t.project_id])).rows[0];
    if (!art) return;
    const existing = await c.query(
      `SELECT id FROM contracts WHERE project_id=$1 AND fingerprint_id=$2 AND lower(address)=lower($3) AND removed_at IS NULL`,
      [t.project_id, t.fingerprint_id, address],
    );
    let contractId: string;
    let abiVersionId: string;
    if (existing.rowCount) {
      contractId = existing.rows[0].id;
      abiVersionId = (await c.query('SELECT id FROM abi_versions WHERE contract_id=$1 ORDER BY version DESC LIMIT 1', [contractId])).rows[0].id;
    } else {
      contractId = (
        await c.query(
          `INSERT INTO contracts(project_id,fingerprint_id,name,address,source,artifact_id,deploy_tx_hash,deploy_block,code_observed)
           VALUES ($1,$2,$3,$4,'deployed',$5,$6,$7,$8) RETURNING id`,
          [t.project_id, t.fingerprint_id, art.contract_name ?? art.name, address.toLowerCase(), t.artifact_id, t.hash, block, JSON.stringify({ source: 'deployment receipt', blockNumber: block })],
        )
      ).rows[0].id;
      const abiJson = JSON.stringify(art.abi);
      abiVersionId = (
        await c.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,$3,'artifact') RETURNING id`, [
          contractId,
          abiJson,
          createHash('sha256').update(abiJson).digest('hex'),
        ])
      ).rows[0].id;
    }
    await c.query(`UPDATE transactions SET contract_id=$2, abi_version_id=COALESCE(abi_version_id,$3) WHERE id=$1`, [t.id, contractId, abiVersionId]);
    await this.observe(c, t.id, 'contract_tracked', `Contract ${address} added to the project from the deployment receipt.`);
  }
}
