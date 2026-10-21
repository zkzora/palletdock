import type pg from 'pg';
import type { EvmAdapter } from '@palletdock/chain';
import { stringifyLossless } from '@palletdock/shared';
import { isPrunedStateError } from './indexer/engine.js';

/**
 * Repair for transactions that an earlier tracker marked 'reorged_out' only
 * because the node stopped returning a pruned receipt. The last inclusion
 * snapshot is rebuilt from the transaction's own observation log and restored
 * only when nothing contradicts it:
 *   - the disappearance names the same block hash as the last receipt observation;
 *   - indexed raw logs and the contract's deploy block (if any) agree;
 *   - the node reports that block as pruned, or as canonical with the same hash.
 * A different canonical hash at that height is a real reorg and is left alone.
 * The receipt body itself was cleared and cannot be recovered.
 */
export interface RestoreResult {
  transactionId: string;
  hash: string;
  action: 'restore' | 'skip';
  reason: string;
  restored?: { blockNumber: string; blockHash: string; execution: 'success' | 'reverted' | 'unknown'; trackingStatus: 'history_pruned' | 'active' };
  provenance?: Record<string, unknown>;
}

const OBSERVED_RE = /Receipt observed in block (\d+) \((0x[0-9a-fA-F]{64})\)/;
const DISAPPEARED_RE = /Receipt previously seen in (0x[0-9a-fA-F]{64})/;

export async function restorePrunedFromObservations(pool: pg.Pool, evm: EvmAdapter, opts: { apply: boolean }): Promise<RestoreResult[]> {
  const candidates = (
    await pool.query(
      `SELECT t.id, t.hash FROM transactions t
        WHERE t.inclusion_status='reorged_out' AND t.block_number IS NULL AND t.hash IS NOT NULL
          AND EXISTS (SELECT 1 FROM transaction_observations o WHERE o.transaction_id=t.id AND o.stage='receipt_disappeared')
        ORDER BY t.created_at`,
    )
  ).rows;
  const results: RestoreResult[] = [];
  for (const t of candidates) results.push(await planOne(pool, evm, t.id, t.hash, opts.apply));
  return results;
}

async function planOne(pool: pg.Pool, evm: EvmAdapter, txId: string, hash: string, apply: boolean): Promise<RestoreResult> {
  const skip = (reason: string, provenance?: Record<string, unknown>): RestoreResult => ({ transactionId: txId, hash, action: 'skip', reason, provenance });
  const obs = (await pool.query(`SELECT id::text, stage, detail, data, source, observed_at FROM transaction_observations WHERE transaction_id=$1 ORDER BY id`, [txId])).rows;
  const disappearance = [...obs].reverse().find((o) => o.stage === 'receipt_disappeared');
  if (!disappearance) return skip('No disappearance observation.');
  if (disappearance.data?.canonicalBlockHash) return skip('The disappearance records a different canonical block hash: a real reorganization.');
  const lostHash = (disappearance.data?.previousBlockHash ?? disappearance.detail?.match(DISAPPEARED_RE)?.[1] ?? '').toLowerCase();
  if (!lostHash) return skip('The disappearance observation does not name the block hash.');

  const before = obs.filter((o) => BigInt(o.id) < BigInt(disappearance.id));
  const receiptObs = [...before].reverse().find((o) => o.stage === 'receipt_observed' || o.stage === 'receipt_moved');
  if (!receiptObs) return skip('No receipt observation precedes the disappearance.');
  const parsed = receiptObs.data?.blockNumber && receiptObs.data?.blockHash ? [null, String(receiptObs.data.blockNumber), String(receiptObs.data.blockHash)] : receiptObs.detail?.match(OBSERVED_RE);
  if (!parsed) return skip('The receipt observation does not state a block number and hash.');
  const blockNumber = String(parsed[1]);
  const blockHash = String(parsed[2]).toLowerCase();
  if (blockHash !== lostHash) return skip(`The last receipt observation (${blockHash}) and the disappearance (${lostHash}) disagree.`);
  const execObs = [...before].reverse().find((o) => BigInt(o.id) > BigInt(receiptObs.id) && /^execution_/.test(o.stage));
  const execution = execObs?.stage === 'execution_succeeded' ? 'success' : execObs?.stage === 'execution_reverted' ? 'reverted' : 'unknown';

  // Independent records in the database must not contradict the snapshot.
  const logs = (await pool.query(`SELECT DISTINCT lower(block_hash) AS h, block_number::text AS n FROM raw_logs WHERE lower(transaction_hash)=lower($1)`, [hash])).rows;
  if (logs.some((l) => l.h !== blockHash || l.n !== blockNumber)) return skip('Indexed raw logs place this transaction in a different block.', { rawLogs: logs });
  const deploy = (await pool.query(`SELECT deploy_block::text AS n FROM contracts WHERE lower(deploy_tx_hash)=lower($1)`, [hash])).rows;
  if (deploy.some((d) => d.n !== null && d.n !== blockNumber)) return skip('The deployed contract records a different deployment block.', { contracts: deploy });

  // The node decides between pruned history and a reorganization.
  let chainCheck: 'pruned' | 'canonical';
  let nodeEvidence: string;
  try {
    const header = await evm.blockHeader(BigInt(blockNumber));
    if (header === null) return skip(`The node returned no block at height ${blockNumber}; ambiguous.`);
    if (header.hash.toLowerCase() !== blockHash) return skip(`Block ${blockNumber} is now ${header.hash}: a real reorganization.`);
    chainCheck = 'canonical';
    nodeEvidence = `eth_getBlockByNumber(${blockNumber}) returned the same hash`;
  } catch (e) {
    if (!isPrunedStateError(e)) return skip(`Could not check block ${blockNumber}: ${(e as Error).message.slice(0, 200)}`);
    chainCheck = 'pruned';
    nodeEvidence = `eth_getBlockByNumber(${blockNumber}): ${(e as Error).message.split('\n')[0].slice(0, 200)}`;
  }

  const trackingStatus = chainCheck === 'pruned' ? 'history_pruned' : 'active';
  const provenance = {
    method: 'restore from observation log',
    sourceObservations: {
      receipt: { id: receiptObs.id, stage: receiptObs.stage, observedAt: receiptObs.observed_at, detail: receiptObs.detail },
      execution: execObs ? { id: execObs.id, stage: execObs.stage, observedAt: execObs.observed_at } : null,
      disappearance: { id: disappearance.id, observedAt: disappearance.observed_at, detail: disappearance.detail },
    },
    corroboration: { rawLogs: logs, contractDeployBlock: deploy.map((d) => d.n) },
    chainCheck,
    nodeEvidence,
    receiptBody: 'not recoverable: cleared by the earlier tracker, and the node no longer serves it',
  };
  const result: RestoreResult = { transactionId: txId, hash, action: 'restore', reason: `Snapshot rebuilt from observations ${receiptObs.id}/${execObs?.id ?? '-'}/${disappearance.id}; node: ${chainCheck}.`, restored: { blockNumber, blockHash, execution, trackingStatus }, provenance };
  if (!apply) return result;

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const upd = await c.query(
      `UPDATE transactions SET inclusion_status='included', execution_status=$2, block_number=$3, block_hash=$4, tracking_status=$5,
              check_failures=0, next_check_at=NULL, updated_at=now()
        WHERE id=$1 AND inclusion_status='reorged_out' AND block_number IS NULL`,
      [txId, execution, blockNumber, blockHash, trackingStatus],
    );
    if (upd.rowCount !== 1) {
      await c.query('ROLLBACK');
      return skip('The transaction changed while planning; nothing written.');
    }
    await c.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source,data) VALUES ($1,'restored_from_observations',$2,'restore:observation-log',$3)`, [
      txId,
      `Restored inclusion in block ${blockNumber} (${blockHash}) and execution ${execution} from observations ${receiptObs.id}, ${execObs?.id ?? '-'}, ${disappearance.id}. The earlier "receipt disappeared" came from pruned node history (${chainCheck}), not a reorganization. The receipt body is not recoverable.`,
      stringifyLossless(provenance),
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  return result;
}
