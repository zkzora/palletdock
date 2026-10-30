import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { EvmAdapter, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET, eventTopic0, eventsOf } from '@palletdock/shared';
import { createTestDatabase, expireGuest, seedGuest, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { IndexerEngine } from '../src/indexer/engine.js';
import { TransactionTracker } from '../src/tx-tracker.js';
import { closeExpiredGuests } from '../src/guest-expiry.js';
import { FakeChain } from './fake-chain.js';

/**
 * Expired temporary playground workspaces stop indexing and receipt polling at
 * selection time, before (and independently of) the maintenance pass.
 * Fixture chain only.
 */
const ABI = [
  {
    type: 'event',
    name: 'NumberChanged',
    anonymous: false,
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'previousValue', type: 'uint256', indexed: false },
      { name: 'newValue', type: 'uint256', indexed: false },
    ],
  },
] as const satisfies Abi;
const ADDR = '0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402';
const TOPIC0 = eventTopic0(eventsOf(ABI as unknown as Abi)[0]);

let db: TestDatabase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function sourceFor(ws: { projectId: string; fingerprintId: string }) {
  const c = await db.pool.query(`INSERT INTO contracts(project_id,fingerprint_id,name,address,source) VALUES ($1,$2,'PalletDockStorage',$3,'imported') RETURNING id`, [
    ws.projectId,
    ws.fingerprintId,
    ADDR,
  ]);
  const a = await db.pool.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,'test','import') RETURNING id`, [c.rows[0].id, JSON.stringify(ABI)]);
  const s = await db.pool.query(
    `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,'pending') RETURNING id`,
    [ws.projectId, c.rows[0].id, ws.fingerprintId, a.rows[0].id, ADDR, ['NumberChanged'], [TOPIC0]],
  );
  await db.pool.query(`INSERT INTO indexer_jobs(source_id) VALUES ($1)`, [s.rows[0].id]);
  return s.rows[0].id as string;
}

const engine = (chain: FakeChain, onlySourceIds: string[], beforeCommit?: () => Promise<void>) =>
  new IndexerEngine(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), {
    workerId: `guest-test-${++seq}`,
    pollMs: 60_000,
    backoffBaseMs: 10,
    backoffMaxMs: 20,
    random: () => 0,
    onlySourceIds,
    beforeCommit: beforeCommit ? async () => beforeCommit() : undefined,
  });

describe('expired guest workspaces', () => {
  it('are not claimed by the indexer, while unexpired guests and accounts still are', async () => {
    const chain = new FakeChain(5);
    const account = await seedWorkspace(db.pool);
    const live = await seedGuest(db.pool);
    const expired = await seedGuest(db.pool);
    const [accountSource, liveSource, expiredSource] = [await sourceFor(account), await sourceFor(live), await sourceFor(expired)];
    await expireGuest(db.pool, expired.ownerId);

    expect(await engine(chain, [expiredSource]).claim()).toBeNull();
    const claimedLive = await engine(chain, [liveSource]).claim();
    expect(claimedLive?.sourceId).toBe(liveSource);
    const claimedAccount = await engine(chain, [accountSource]).claim();
    expect(claimedAccount?.sourceId).toBe(accountSource);
  });

  it('fences an in-flight commit when the guest expires mid-claim, before maintenance runs', async () => {
    const chain = new FakeChain(5);
    chain.mine([
      {
        address: ADDR,
        topics: encodeEventTopics({ abi: ABI, eventName: 'NumberChanged', args: { caller: ADDR } }) as string[],
        data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [0n, 42n]),
      },
    ]);
    const guest = await seedGuest(db.pool);
    const sourceId = await sourceFor(guest);
    const results = await engine(chain, [sourceId], () => expireGuest(db.pool, guest.ownerId)).runOnce();
    expect(results.map((r) => r.kind)).toContain('fenced');
    const stored = await db.pool.query(`SELECT count(*)::int AS n FROM raw_logs WHERE source_id=$1`, [sourceId]);
    expect(stored.rows[0].n).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM indexer_checkpoints WHERE source_id=$1`, [sourceId])).rowCount).toBe(0);
    // The guest row is still unclosed: this was authorization at commit time, not cleanup.
    expect((await db.pool.query(`SELECT guest_closed_at FROM owners WHERE id=$1`, [guest.ownerId])).rows[0].guest_closed_at).toBeNull();
  });

  it('get no receipt polling once expired', async () => {
    const calls: string[] = [];
    const rpc: RpcCaller = {
      async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
        calls.push(`${method}:${String(params[0])}`);
        if (method === 'eth_blockNumber') return '0x10' as T;
        return null as T;
      },
    };
    const guest = await seedGuest(db.pool);
    const hash = `0x${'ab'.repeat(32)}`;
    await db.pool.query(
      `INSERT INTO transactions(project_id,fingerprint_id,origin,kind,hash,from_address,submission_status,inclusion_status) VALUES ($1,$2,'palletdock','call',$3,$4,'submitted','pending')`,
      [guest.projectId, guest.fingerprintId, hash, ADDR],
    );
    await expireGuest(db.pool, guest.ownerId);
    await new TransactionTracker(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, rpc), { batch: 500 }).runOnce();
    expect(calls.filter((c) => c.includes(hash))).toEqual([]);
  });

  it('maintenance revokes sessions and keys, stops and fences sources, once and idempotently', async () => {
    const guest = await seedGuest(db.pool);
    const keep = await seedGuest(db.pool);
    const sourceId = await sourceFor(guest);
    await db.pool.query(`INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at) VALUES ($1,'guest-hash-1','csrf',now()+interval '1 hour')`, [guest.ownerId]);
    await db.pool.query(`INSERT INTO sessions(owner_id,token_hash,csrf_token,expires_at) VALUES ($1,'guest-hash-2','csrf',now()+interval '1 hour')`, [keep.ownerId]);
    await db.pool.query(`INSERT INTO api_keys(project_id,name,prefix,secret_hash,scopes,expires_at) VALUES ($1,'k','pd_live_expiretest','h',$2,now()+interval '1 hour')`, [
      guest.projectId,
      ['events:read'],
    ]);
    const generation = (await db.pool.query(`SELECT generation::text FROM indexer_sources WHERE id=$1`, [sourceId])).rows[0].generation;
    await expireGuest(db.pool, guest.ownerId);

    // Two concurrent passes (two worker instances): each expired guest is closed exactly once.
    const [a, b] = await Promise.all([closeExpiredGuests(db.pool, 100), closeExpiredGuests(db.pool, 100)]);
    expect([...a, ...b].filter((id) => id === guest.ownerId)).toHaveLength(1);
    expect([...a, ...b]).not.toContain(keep.ownerId);

    const session = await db.pool.query(`SELECT revoked_at FROM sessions WHERE token_hash='guest-hash-1'`);
    expect(session.rows[0].revoked_at).not.toBeNull();
    expect((await db.pool.query(`SELECT revoked_at FROM sessions WHERE token_hash='guest-hash-2'`)).rows[0].revoked_at).toBeNull();
    expect((await db.pool.query(`SELECT revoked_at FROM api_keys WHERE prefix='pd_live_expiretest'`)).rows[0].revoked_at).not.toBeNull();
    const source = (await db.pool.query(`SELECT desired_state,status,generation::text FROM indexer_sources WHERE id=$1`, [sourceId])).rows[0];
    expect(source).toMatchObject({ desired_state: 'archived', status: 'stopped' });
    expect(BigInt(source.generation)).toBe(BigInt(generation) + 1n);
    const logs = await db.pool.query(`SELECT count(*)::int AS n FROM ops_logs WHERE project_id=$1 AND message LIKE 'Temporary workspace expired%'`, [guest.projectId]);
    expect(logs.rows[0].n).toBe(1);

    // Idempotent: the next pass finds nothing to do and logs nothing twice.
    expect(await closeExpiredGuests(db.pool, 100)).not.toContain(guest.ownerId);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM ops_logs WHERE project_id=$1 AND message LIKE 'Temporary workspace expired%'`, [guest.projectId])).rows[0].n).toBe(1);
    // Records are retained for the documented purge procedure.
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM projects WHERE owner_id=$1`, [guest.ownerId])).rows[0].n).toBe(1);
  });

  it('a guest cannot carry an email or password', async () => {
    await expect(db.pool.query(`INSERT INTO owners(kind,email,password_hash,guest_expires_at) VALUES ('guest','g@example.test','x',now())`)).rejects.toThrow(/owners_kind_credentials/);
    await expect(db.pool.query(`INSERT INTO owners(kind) VALUES ('guest')`)).rejects.toThrow(/owners_kind_credentials/);
    await expect(db.pool.query(`INSERT INTO owners(email,password_hash,guest_expires_at) VALUES ('a2@example.test','x',now())`)).rejects.toThrow(/owners_kind_credentials/);
  });
});
