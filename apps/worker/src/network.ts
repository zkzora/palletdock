import type pg from 'pg';
import { probeEvm, probeSubstrate, type ProbeResult, type EvmIdentity, type SubstrateIdentity } from '@palletdock/chain';
import { resolveNetwork } from '@palletdock/shared';
import { withTx } from '@palletdock/db';

export interface NetworkVerification {
  status: 'verified' | 'unavailable' | 'mismatch';
  fingerprintId: string | null;
  evm: ProbeResult<EvmIdentity>;
  substrate: ProbeResult<SubstrateIdentity>;
}

export async function verifyAndRecordNetwork(pool: pg.Pool): Promise<NetworkVerification> {
  const network = resolveNetwork();
  const nativeDisabled = process.env.PALLETDOCK_NATIVE_ADAPTER === 'disabled';
  const [evm, substrate] = await Promise.all([
    probeEvm(network),
    nativeDisabled
      ? Promise.resolve<ProbeResult<SubstrateIdentity>>({ status: 'failed', latencyMs: 0, observedAt: new Date().toISOString(), value: null, error: 'Native adapter disabled by configuration (fixture mode).' })
      : probeSubstrate(network),
  ]);
  let fingerprintId: string | null = null;
  let status: NetworkVerification['status'] = 'unavailable';

  await withTx(pool, async (client) => {
    for (const [target, probe, method] of [
      ['evm', evm, 'identity bundle'],
      ['substrate', substrate, 'identity bundle'],
    ] as const) {
      await client.query(
        `INSERT INTO rpc_probes(network_id,target,method,status,latency_ms,result,error,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [network.networkId, target, method, probe.status, probe.latencyMs, probe.value, probe.error?.slice(0, 2000) ?? null, probe.observedAt],
      );
    }
    if (!evm.value || !substrate.value) return;
    const active = await client.query('SELECT id,genesis_hash,evm_chain_id::text FROM network_fingerprints WHERE network_id=$1 AND status=$2 LIMIT 1 FOR UPDATE', [network.networkId, 'active']);
    const identityMatches = !active.rowCount || (active.rows[0].genesis_hash === substrate.value.genesisHash && active.rows[0].evm_chain_id === String(evm.value.chainId));
    status = identityMatches ? 'verified' : 'mismatch';
    const desiredStatus = identityMatches && !active.rowCount ? 'active' : identityMatches ? 'active' : 'mismatch';
    const result = await client.query(
      `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id,evm_genesis_hash,spec_name,spec_version,ss58_format,token_symbol,token_decimals,evidence,last_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (network_id,genesis_hash,evm_chain_id) DO UPDATE SET
         evm_genesis_hash=EXCLUDED.evm_genesis_hash,spec_name=EXCLUDED.spec_name,spec_version=EXCLUDED.spec_version,
         ss58_format=EXCLUDED.ss58_format,token_symbol=EXCLUDED.token_symbol,token_decimals=EXCLUDED.token_decimals,
         evidence=EXCLUDED.evidence,last_verified_at=now()
       RETURNING id,status`,
      [
        network.networkId,
        desiredStatus,
        substrate.value.genesisHash,
        evm.value.chainId,
        evm.value.genesisHash,
        substrate.value.specName,
        substrate.value.specVersion,
        substrate.value.ss58Format,
        substrate.value.tokenSymbols[0] ?? null,
        substrate.value.tokenDecimals[0] ?? null,
        { evm: evm.value, substrate: substrate.value },
      ],
    );
    fingerprintId = result.rows[0].id;
  });
  return { status, fingerprintId, evm, substrate };
}

export interface ResetPlan {
  previous: { id: string; genesis_hash: string; evm_chain_id: string } | null;
  next: { id: string; genesis_hash: string; evm_chain_id: string; last_verified_at: Date } | null;
  sourcesToStop: number;
  applied: boolean;
}

/**
 * Explicit operator migration after a network reset (changed genesis). Never
 * called automatically. With apply=false it only reports the plan.
 */
export async function acceptNetworkReset(pool: pg.Pool, apply: boolean): Promise<ResetPlan> {
  const [active, mismatch] = await Promise.all([
    pool.query(`SELECT id, genesis_hash, evm_chain_id::text FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='active'`),
    pool.query(`SELECT id, genesis_hash, evm_chain_id::text, last_verified_at FROM network_fingerprints WHERE network_id='portaldot-v3-testnet' AND status='mismatch' ORDER BY last_verified_at DESC LIMIT 1`),
  ]);
  const previous = active.rows[0] ?? null;
  const next = mismatch.rows[0] ?? null;
  const sourcesToStop = previous ? (await pool.query(`SELECT count(*)::int AS n FROM indexer_sources WHERE fingerprint_id=$1 AND desired_state <> 'deleted'`, [previous.id])).rows[0].n : 0;
  if (!next || !apply) return { previous, next, sourcesToStop, applied: false };
  await withTx(pool, async (c) => {
    if (previous) {
      await c.query(`UPDATE network_fingerprints SET status='superseded', superseded_at=now() WHERE id=$1`, [previous.id]);
      await c.query(
        `UPDATE indexer_sources SET status='recovery_required', desired_state='paused', generation=generation+1, reorg_epoch=reorg_epoch+1,
                last_error='Network reset accepted: this source belongs to a superseded network identity.', last_error_at=now(), updated_at=now()
          WHERE fingerprint_id=$1 AND desired_state <> 'deleted'`,
        [previous.id],
      );
      await c.query(`UPDATE account_mappings SET invalidated_at=now() WHERE fingerprint_id=$1 AND invalidated_at IS NULL`, [previous.id]);
    }
    await c.query(`UPDATE network_fingerprints SET status='active' WHERE id=$1`, [next.id]);
    await c.query(`INSERT INTO ops_logs(source,level,message,detail) VALUES ('network','WARN','Network reset accepted by operator',$1)`, [
      JSON.stringify({ previous: previous?.genesis_hash ?? null, current: next.genesis_hash, sourcesStopped: sourcesToStop }),
    ]);
  });
  return { previous, next, sourcesToStop, applied: true };
}
