import type pg from 'pg';
import { createHash } from 'node:crypto';
import type { EvmAdapter } from '@palletdock/chain';
import { stringifyLossless } from '@palletdock/shared';

/**
 * Polls receipts for tracked transactions. Inclusion, execution, finality and
 * indexing are recorded independently. Finality is always left 'unknown': no
 * adapter proving EVM-block-to-native-finality exists yet.
 */
export class TransactionTracker {
  constructor(
    private readonly pool: pg.Pool,
    private readonly evm: EvmAdapter,
    private readonly opts: { batch?: number; recheckIncludedBlocks?: number } = {},
  ) {}

  /** Check a batch of tracked transactions. `failed` counts RPC/DB errors (drives worker backoff). */
  async runOnce(): Promise<{ checked: number; changed: number; failed: number }> {
    const batch = this.opts.batch ?? 25;
    const rows = (
      await this.pool.query(
        `SELECT t.id,t.project_id,t.fingerprint_id,t.hash,t.kind,t.origin,t.from_address,t.to_address,t.inclusion_status,t.execution_status,t.block_hash,t.artifact_id,t.contract_id,t.input,
                t.abi_version_id,p.archived_at
           FROM transactions t JOIN projects p ON p.id=t.project_id
           JOIN network_fingerprints f ON f.id=t.fingerprint_id AND f.status='active'
          WHERE t.hash IS NOT NULL
            AND (t.inclusion_status IN ('not_observed','pending','reorged_out')
                 OR (t.inclusion_status='included' AND t.updated_at > now() - interval '30 minutes'))
            AND (t.last_checked_at IS NULL OR t.last_checked_at < now() - interval '4 seconds')
          ORDER BY t.last_checked_at NULLS FIRST
          LIMIT $1`,
        [batch],
      )
    ).rows;
    let changed = 0;
    let failed = 0;
    for (const t of rows) {
      try {
        if (await this.check(t)) changed++;
      } catch (e) {
        failed++;
        await this.pool.query(`UPDATE transactions SET last_checked_at=now() WHERE id=$1`, [t.id]);
        await this.pool.query(
          `INSERT INTO ops_logs(project_id,source,level,message,detail,transaction_id) VALUES ($1,'transaction','WARN',$2,$3,$4)`,
          [t.project_id, 'Receipt check failed; will retry.', JSON.stringify({ error: (e as Error).message.slice(0, 500) }), t.id],
        );
      }
    }
    return { checked: rows.length, changed, failed };
  }

  private async observe(c: pg.PoolClient | pg.Pool, txId: string, stage: string, detail: string) {
    await c.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,$2,$3,'worker:eth_getTransactionReceipt')`, [txId, stage, detail]);
  }

  private async check(t: Record<string, any>): Promise<boolean> {
    const receipt = await this.evm.receipt(t.hash);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query('SELECT inclusion_status,block_hash FROM transactions WHERE id=$1 FOR UPDATE', [t.id])).rows[0];
      if (!receipt) {
        if (cur.inclusion_status === 'included') {
          await client.query(
            `UPDATE transactions SET inclusion_status='reorged_out', execution_status='unknown', block_number=NULL, block_hash=NULL, receipt=NULL, last_checked_at=now(), updated_at=now() WHERE id=$1`,
            [t.id],
          );
          await this.observe(client, t.id, 'receipt_disappeared', `Receipt previously seen in ${cur.block_hash} is no longer returned (possible reorganization). The transaction may be re-included.`);
          await client.query('COMMIT');
          return true;
        }
        await client.query(`UPDATE transactions SET last_checked_at=now(), inclusion_status=CASE WHEN inclusion_status='not_observed' THEN 'pending' ELSE inclusion_status END WHERE id=$1`, [t.id]);
        await client.query('COMMIT');
        return false;
      }
      if (cur.inclusion_status === 'included' && cur.block_hash?.toLowerCase() === receipt.blockHash.toLowerCase()) {
        await client.query(`UPDATE transactions SET last_checked_at=now() WHERE id=$1`, [t.id]);
        await client.query('COMMIT');
        return false;
      }
      // The hash came from the browser; make sure the receipt belongs to the reviewed request.
      const fromMismatch = t.from_address && receipt.from.toLowerCase() !== String(t.from_address).toLowerCase();
      const toMismatch = t.origin === 'palletdock' && (t.kind === 'deploy' ? receipt.to !== null : (receipt.to ?? '').toLowerCase() !== String(t.to_address ?? '').toLowerCase());
      if (fromMismatch || toMismatch) {
        const already = await client.query(`SELECT 1 FROM transaction_observations WHERE transaction_id=$1 AND stage='receipt_mismatch'`, [t.id]);
        await client.query(`UPDATE transactions SET last_checked_at=now(), error_message=$2, updated_at=now() WHERE id=$1`, [
          t.id,
          'The receipt for this hash does not match the reviewed sender/recipient. The receipt was not applied.',
        ]);
        if (!already.rowCount) {
          await this.observe(client, t.id, 'receipt_mismatch', `Receipt from ${receipt.from} to ${receipt.to ?? 'contract creation'} does not match the prepared request (${t.from_address} → ${t.to_address ?? 'contract creation'}).`);
        }
        await client.query('COMMIT');
        return false;
      }
      const moved = cur.inclusion_status === 'included' || cur.inclusion_status === 'reorged_out';
      await client.query(
        `UPDATE transactions SET inclusion_status='included', execution_status=$2, block_number=$3, block_hash=$4, gas_used=$5,
                effective_gas_price=$6, fee_raw=$7, receipt=$8, contract_address=COALESCE($9, contract_address),
                from_address=COALESCE(from_address,$10), indexing_status=CASE WHEN $11::int = 0 THEN 'no_events' WHEN indexing_status='indexed' THEN 'indexed'
                  WHEN EXISTS (SELECT 1 FROM indexer_sources s WHERE s.project_id=transactions.project_id AND s.desired_state <> 'deleted'
                               AND lower(s.contract_address) = ANY($12::text[])) THEN 'pending' ELSE 'not_covered' END,
                last_checked_at=now(), updated_at=now()
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
        ],
      );
      await this.observe(client, t.id, moved ? 'receipt_moved' : 'receipt_observed', `Receipt observed in block ${receipt.blockNumber} (${receipt.blockHash}). Inclusion only; finality not confirmed.`);
      await this.observe(
        client,
        t.id,
        receipt.status === 'success' ? 'execution_succeeded' : receipt.status === 'reverted' ? 'execution_reverted' : 'execution_unknown',
        receipt.status === 'reverted' ? 'Receipt status 0x0. A reverted transaction may still be charged a fee.' : receipt.status === 'success' ? 'Receipt status 0x1.' : 'Receipt has no status field.',
      );
      if (t.kind === 'deploy' && receipt.status === 'success' && receipt.contractAddress && !t.contract_id && t.artifact_id) {
        await this.trackDeployedContract(client, t, receipt.contractAddress, receipt.blockNumber);
      }
      await client.query('COMMIT');
      return true;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  private async trackDeployedContract(c: pg.PoolClient, t: Record<string, any>, address: string, block: string) {
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
