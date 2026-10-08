import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { acceptNetworkReset } from '../src/network.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

describe('network reset migration', () => {
  it('does nothing without an observed mismatch, dry-runs by default, and fences old sources on apply', async () => {
    const ws = await seedWorkspace(db.pool);
    expect((await acceptNetworkReset(db.pool, true)).next).toBeNull();

    const c = await db.pool.query(`INSERT INTO contracts(project_id,fingerprint_id,name,address,source) VALUES ($1,$2,'S','0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402','imported') RETURNING id`, [ws.projectId, ws.fingerprintId]);
    const a = await db.pool.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,'[]','x','import') RETURNING id`, [c.rows[0].id]);
    const s = await db.pool.query(
      `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,status)
       VALUES ($1,$2,$3,$4,'0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402','{E}','{0x00}',0,'following') RETURNING id, generation::text, reorg_epoch::text`,
      [ws.projectId, c.rows[0].id, ws.fingerprintId, a.rows[0].id],
    );
    await db.pool.query(
      `INSERT INTO account_mappings(fingerprint_id,direction,evm_address,native_account_hex,native_ss58,method,block_hash,spec_version) VALUES ($1,'evm_to_native','0xab','0x00','5x','reviveApi.accountId','0x01',1)`,
      [ws.fingerprintId],
    );
    const newGenesis = '0x' + 'ef'.repeat(32);
    await db.pool.query(`INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id) VALUES ('portaldot-v3-testnet','mismatch',$1,420420777)`, [newGenesis]);

    const dry = await acceptNetworkReset(db.pool, false);
    expect(dry).toMatchObject({ applied: false, sourcesToStop: 1 });
    expect((await db.pool.query(`SELECT status FROM network_fingerprints WHERE id=$1`, [ws.fingerprintId])).rows[0].status).toBe('active');

    const applied = await acceptNetworkReset(db.pool, true);
    expect(applied.applied).toBe(true);
    const fps = (await db.pool.query(`SELECT genesis_hash, status FROM network_fingerprints ORDER BY first_seen_at`)).rows;
    expect(fps.find((f) => f.genesis_hash === newGenesis)?.status).toBe('active');
    expect(fps.filter((f) => f.status === 'active')).toHaveLength(1);
    const src = (await db.pool.query(`SELECT status, desired_state, generation::text, reorg_epoch::text FROM indexer_sources WHERE id=$1`, [s.rows[0].id])).rows[0];
    expect(src).toMatchObject({ status: 'recovery_required', desired_state: 'paused' });
    expect(BigInt(src.generation)).toBeGreaterThan(BigInt(s.rows[0].generation));
    expect(BigInt(src.reorg_epoch)).toBeGreaterThan(BigInt(s.rows[0].reorg_epoch));
    expect((await db.pool.query(`SELECT invalidated_at FROM account_mappings`)).rows[0].invalidated_at).not.toBeNull();
  });
});
