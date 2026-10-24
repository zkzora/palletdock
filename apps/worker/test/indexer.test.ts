import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Abi } from 'viem';
import { EvmAdapter } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET, eventTopic0, eventsOf } from '@palletdock/shared';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { IndexerEngine, type IndexerOptions } from '../src/indexer/engine.js';
import { FakeChain, type FakeLog } from './fake-chain.js';

const ABI = [
  { type: 'function', name: 'store', stateMutability: 'nonpayable', inputs: [{ name: 'newValue', type: 'uint256' }], outputs: [] },
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
const CALLER = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const TOPIC0 = eventTopic0(eventsOf(ABI as unknown as Abi)[0]);

function numberChanged(prev: bigint, next: bigint): FakeLog {
  return {
    address: ADDR,
    topics: encodeEventTopics({ abi: ABI, eventName: 'NumberChanged', args: { caller: CALLER } }) as string[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [prev, next]),
  };
}

let db: TestDatabase;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

async function setupSource(opts: { start?: number; end?: number | null; chain: FakeChain; engine?: Partial<IndexerOptions> }) {
  const ws = await seedWorkspace(db.pool);
  const c = await db.pool.query(
    `INSERT INTO contracts(project_id,fingerprint_id,name,address,source) VALUES ($1,$2,'PalletDockStorage',$3,'imported') RETURNING id`,
    [ws.projectId, ws.fingerprintId, ADDR],
  );
  const a = await db.pool.query(
    `INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,'test','import') RETURNING id`,
    [c.rows[0].id, JSON.stringify(ABI)],
  );
  const s = await db.pool.query(
    `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,end_block,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING id`,
    [ws.projectId, c.rows[0].id, ws.fingerprintId, a.rows[0].id, ADDR, ['NumberChanged'], [TOPIC0], opts.start ?? 0, opts.end ?? null],
  );
  await db.pool.query(`INSERT INTO indexer_jobs(source_id) VALUES ($1)`, [s.rows[0].id]);
  const make = (extra: Partial<IndexerOptions> = {}) =>
    new IndexerEngine(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, opts.chain), {
      workerId: `test-${++seq}`,
      pollMs: 0,
      backoffBaseMs: 10,
      backoffMaxMs: 20,
      random: () => 0,
      onlySourceIds: [s.rows[0].id],
      ...opts.engine,
      ...extra,
    });
  return { ...ws, sourceId: s.rows[0].id as string, contractId: c.rows[0].id as string, make };
}

async function canonicalLogs(sourceId: string) {
  return (
    await db.pool.query(
      `SELECT r.block_number::text, r.block_hash, r.transaction_hash, r.log_index, r.canonical, d.status, d.event_name, d.args, d.decode_error
         FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id WHERE r.source_id=$1 AND r.canonical ORDER BY r.block_number, r.log_index`,
      [sourceId],
    )
  ).rows;
}

async function checkpoint(sourceId: string) {
  return (await db.pool.query('SELECT block_number::text, block_hash FROM indexer_checkpoints WHERE source_id=$1', [sourceId])).rows[0];
}

async function makeRunnable(sourceId: string) {
  await db.pool.query('UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1', [sourceId]);
}

describe('IndexerEngine', () => {
  let chain: FakeChain;
  beforeEach(() => {
    chain = new FakeChain(5);
  });

  it('backfills empty and non-empty ranges atomically and decodes with lossless values', async () => {
    chain.mine([numberChanged(0n, 42n)]);
    chain.mineEmpty(3);
    chain.mine([numberChanged(42n, 2n ** 200n)]);
    chain.mineEmpty(2);
    const src = await setupSource({ chain });
    await src.make().drain();
    const cp = await checkpoint(src.sourceId);
    expect(cp.block_number).toBe(String(chain.head));
    expect(cp.block_hash).toBe(chain.blocks[chain.head].hash);
    const logs = await canonicalLogs(src.sourceId);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ status: 'decoded', event_name: 'NumberChanged', block_number: '6' });
    expect(logs[1].args.newValue).toBe((2n ** 200n).toString());
    expect(logs[1].block_hash).toBe(chain.blocks[10].hash);
    const s = (await db.pool.query('SELECT status FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(s.status).toBe('following');
  });

  it('covers a requested range with no events and completes a bounded end block', async () => {
    chain.mineEmpty(20);
    const src = await setupSource({ chain, start: 3, end: 15 });
    await src.make().drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe('15');
    expect(await canonicalLogs(src.sourceId)).toHaveLength(0);
    const s = (await db.pool.query('SELECT status FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(s.status).toBe('completed');
  });

  it('shrinks the eth_getLogs range when the node rejects it', async () => {
    chain.mineEmpty(40);
    chain.mine([numberChanged(1n, 2n)]);
    chain.maxLogRange = 4;
    const src = await setupSource({ chain });
    await src.make().drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(chain.head));
    expect(await canonicalLogs(src.sourceId)).toHaveLength(1);
  });

  it('keeps unknown and malformed logs with explicit decode status', async () => {
    const good = numberChanged(0n, 1n);
    chain.mine([
      { address: ADDR, topics: [TOPIC0, good.topics[1]], data: '0x1234' }, // malformed data for the ABI
      { address: ADDR, topics: ['0x' + 'ee'.repeat(32)], data: '0x' }, // unknown topic0, empty data
    ]);
    const src = await setupSource({ chain });
    // Index all topics for this test by clearing the topic filter list.
    await db.pool.query(`UPDATE indexer_sources SET event_topics=$2 WHERE id=$1`, [src.sourceId, [TOPIC0, '0x' + 'ee'.repeat(32)]]);
    await src.make().drain();
    const logs = await canonicalLogs(src.sourceId);
    expect(logs.map((l) => l.status).sort()).toEqual(['decode_error', 'unknown_event']);
    expect(logs.find((l) => l.status === 'decode_error')!.decode_error).toBeTruthy();
  });

  it('does not duplicate canonical records when a range is re-ingested', async () => {
    chain.mine([numberChanged(0n, 7n), numberChanged(7n, 8n)]);
    const src = await setupSource({ chain });
    await src.make().drain();
    expect(await canonicalLogs(src.sourceId)).toHaveLength(2);
    // Simulate a crash that lost the checkpoint advance (overlap re-read).
    await db.pool.query(`UPDATE indexer_checkpoints SET block_number=2, block_hash=$2 WHERE source_id=$1`, [src.sourceId, chain.blocks[2].hash]);
    await makeRunnable(src.sourceId);
    await src.make().drain();
    expect(await canonicalLogs(src.sourceId)).toHaveLength(2);
    const total = (await db.pool.query('SELECT count(*)::int AS n FROM raw_logs WHERE source_id=$1', [src.sourceId])).rows[0].n;
    expect(total).toBe(2);
  });

  it('two concurrent workers never commit conflicting data', async () => {
    for (let i = 0; i < 10; i++) chain.mine([numberChanged(BigInt(i), BigInt(i + 1))]);
    const src = await setupSource({ chain, engine: { maxChunk: 2, maxChunksPerClaim: 1 } });
    const a = src.make();
    const b = src.make();
    for (let i = 0; i < 30; i++) await Promise.all([a.runOnce(), b.runOnce()]);
    await makeRunnable(src.sourceId);
    await a.drain();
    const logs = await canonicalLogs(src.sourceId);
    expect(logs).toHaveLength(10);
    expect(new Set(logs.map((l) => l.transaction_hash + ':' + l.log_index)).size).toBe(10);
  });

  it('backs off on RPC interruption and resumes from the persisted checkpoint', async () => {
    chain.mine([numberChanged(0n, 5n)]);
    const src = await setupSource({ chain });
    chain.failNext(1);
    const first = await src.make().runOnce();
    expect(first[0].kind).toBe('backoff');
    const job = (await db.pool.query('SELECT attempts FROM indexer_jobs WHERE source_id=$1', [src.sourceId])).rows[0];
    expect(job.attempts).toBe(1);
    const st = (await db.pool.query('SELECT status,last_error FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(st.status).toBe('error');
    expect(st.last_error).toMatch(/connection closed/);
    await makeRunnable(src.sourceId);
    await src.make().drain(); // new engine instance = worker restart
    expect(await canonicalLogs(src.sourceId)).toHaveLength(1);
    const recovered = await db.pool.query(`SELECT 1 FROM ops_logs WHERE indexer_source_id=$1 AND message LIKE 'Recovered after%'`, [src.sourceId]);
    expect(recovered.rowCount).toBe(1);
  });

  it('resumes after restart without reprocessing committed ranges', async () => {
    chain.mineEmpty(30);
    const src = await setupSource({ chain, engine: { maxChunk: 5, maxChunksPerClaim: 1 } });
    await src.make().runOnce();
    const cp1 = await checkpoint(src.sourceId);
    expect(Number(cp1.block_number)).toBeGreaterThanOrEqual(0);
    await makeRunnable(src.sourceId);
    await src.make({ maxChunksPerClaim: 100 }).drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(chain.head));
  });

  it('rolls back orphaned records on a reorg and indexes the replacement branch', async () => {
    chain.mine([numberChanged(0n, 1n)]); // 6
    chain.mine([numberChanged(1n, 2n)]); // 7
    chain.mineEmpty(2); // 8,9
    const src = await setupSource({ chain });
    await src.make().drain();
    expect(await canonicalLogs(src.sourceId)).toHaveLength(2);
    // Replace blocks 7..10 with a branch where block 8 holds a different event.
    chain.reorg(7, [[], [numberChanged(1n, 99n)], [], []]);
    await makeRunnable(src.sourceId);
    const results = await src.make().drain();
    expect(results.some((r) => r.kind === 'reorg')).toBe(true);
    const logs = await canonicalLogs(src.sourceId);
    expect(logs.map((l) => [l.block_number, l.args.newValue])).toEqual([
      ['6', '1'],
      ['8', '99'],
    ]);
    expect(logs[1].block_hash).toBe(chain.blocks[8].hash);
    const orphan = await db.pool.query(`SELECT block_number::text FROM raw_logs WHERE source_id=$1 AND canonical=false`, [src.sourceId]);
    expect(orphan.rows.map((r) => r.block_number)).toEqual(['7']);
    const s = (await db.pool.query('SELECT reorg_epoch::text FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(s.reorg_epoch).toBe('1');
    expect((await checkpoint(src.sourceId)).block_hash).toBe(chain.blocks[chain.head].hash);
  });

  it('enters recovery_required when a reorg exceeds retained ancestry', async () => {
    chain.mineEmpty(10);
    const src = await setupSource({ chain, engine: { headerRetention: 2, maxChunk: 3 } });
    await src.make().drain();
    chain.reorg(1, Array.from({ length: 16 }, () => []));
    await makeRunnable(src.sourceId);
    const r = await src.make().drain();
    expect(r.some((x) => x.kind === 'recovery_required')).toBe(true);
    const s = (await db.pool.query('SELECT status,last_error FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(s.status).toBe('recovery_required');
    expect(s.last_error).toMatch(/deeper than retained/);
  });

  it('fences a stale lease so the old holder cannot commit', async () => {
    chain.mine([numberChanged(0n, 3n)]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = await setupSource({ chain });
    const stale = src.make({
      beforeCommit: async () => {
        // Lease expires and another worker takes over while this one is "paused".
        await db.pool.query(`UPDATE indexer_jobs SET lease_expires_at=now() - interval '1 second' WHERE source_id=$1`, [src.sourceId]);
        const fresh = src.make();
        await fresh.drain();
        release();
      },
    });
    const r = await stale.runOnce();
    await gate;
    expect(r[0].kind).toBe('fenced');
    expect(await canonicalLogs(src.sourceId)).toHaveLength(1);
  });

  it('discards an in-flight fetch when the project is archived mid-fetch', async () => {
    chain.mine([numberChanged(0n, 4n)]);
    const src = await setupSource({ chain });
    const engine = src.make({
      beforeCommit: async () => {
        await db.pool.query(`UPDATE projects SET archived_at=now() WHERE id=$1`, [src.projectId]);
        await db.pool.query(`UPDATE indexer_sources SET desired_state='archived', generation=generation+1 WHERE project_id=$1`, [src.projectId]);
      },
    });
    const r = await engine.runOnce();
    expect(r[0].kind).toBe('fenced');
    expect(await canonicalLogs(src.sourceId)).toHaveLength(0);
    expect(await checkpoint(src.sourceId)).toBeUndefined();
    // Archived sources are not claimed again.
    expect((await src.make().runOnce())[0].kind).toBe('idle');
  });

  it('refuses to continue on a different network fingerprint', async () => {
    const src = await setupSource({ chain });
    await db.pool.query(`UPDATE network_fingerprints SET status='superseded' WHERE status='active'`);
    await db.pool.query(
      `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id) VALUES ('portaldot-v3-testnet','active',$1,420420777)`,
      ['0x' + 'cd'.repeat(32)],
    );
    try {
      const r = await src.make().runOnce();
      expect(r[0].kind).toBe('recovery_required');
    } finally {
      await db.pool.query(`DELETE FROM network_fingerprints WHERE genesis_hash=$1`, ['0x' + 'cd'.repeat(32)]);
      await db.pool.query(`UPDATE network_fingerprints SET status='active' WHERE status='superseded'`);
    }
  });

  it('stops with recovery_required (not endless retries) when the node pruned the checkpoint block', async () => {
    chain.mine([numberChanged(0n, 1n)]);
    const src = await setupSource({ chain });
    await src.make().drain();
    // Worker was offline longer than the node's retained window.
    chain.mineEmpty(30);
    chain.prunedBelow = chain.head - 5;
    await makeRunnable(src.sourceId);
    const r = await src.make().drain();
    expect(r.some((x) => x.kind === 'recovery_required')).toBe(true);
    expect(r.some((x) => x.kind === 'backoff')).toBe(false);
    const s = (await db.pool.query('SELECT status,last_error FROM indexer_sources WHERE id=$1', [src.sourceId])).rows[0];
    expect(s.status).toBe('recovery_required');
    expect(s.last_error).toMatch(/state pruned/);
    expect(await canonicalLogs(src.sourceId)).toHaveLength(1);
  });
});

describe('logs that the node serves later than its head (tip log-index lag)', () => {
  let chain: FakeChain;
  beforeEach(() => {
    chain = new FakeChain(5);
  });

  async function status(sourceId: string) {
    return (await db.pool.query('SELECT status FROM indexer_sources WHERE id=$1', [sourceId])).rows[0].status as string;
  }

  it('does not commit past a block whose logs bloom matches while eth_getLogs is still empty, and indexes the log once it appears', async () => {
    // Live 2026-10-24: block 168958 held store(45); eth_getLogs at the tip returned nothing and the checkpoint moved past it.
    const src = await setupSource({ chain });
    await src.make().drain();
    const block = chain.mine([numberChanged(44n, 45n)]);
    chain.delayLogs(block, 2);
    const engine = src.make();

    await makeRunnable(src.sourceId);
    await engine.runOnce();
    expect(BigInt((await checkpoint(src.sourceId)).block_number)).toBeLessThan(BigInt(block));
    expect(await canonicalLogs(src.sourceId)).toHaveLength(0);
    expect(await status(src.sourceId)).not.toBe('error'); // waiting for the node, not an RPC failure

    await makeRunnable(src.sourceId);
    await engine.runOnce();
    expect(BigInt((await checkpoint(src.sourceId)).block_number)).toBeLessThan(BigInt(block));

    await makeRunnable(src.sourceId);
    await engine.drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(chain.head));
    const logs = await canonicalLogs(src.sourceId);
    expect(logs.map((l) => [l.block_number, l.args.newValue])).toEqual([[String(block), '45']]);

    await makeRunnable(src.sourceId);
    await engine.drain();
    expect(await canonicalLogs(src.sourceId)).toHaveLength(1);
  });

  it('a bloom false positive delays the checkpoint briefly but does not stall the source', async () => {
    const src = await setupSource({ chain, engine: { bloomRetries: 2 } });
    await src.make().drain();
    const block = chain.mine([]);
    chain.bloomOnly.set(block, [numberChanged(0n, 1n)]);
    const engine = src.make();
    for (let i = 0; i < 5; i++) {
      await makeRunnable(src.sourceId);
      await engine.runOnce();
    }
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(block));
    expect(await canonicalLogs(src.sourceId)).toHaveLength(0);
    const warn = await db.pool.query(`SELECT message FROM ops_logs WHERE indexer_source_id=$1 AND level='WARN' AND message ILIKE '%bloom%'`, [src.sourceId]);
    expect(warn.rowCount).toBe(1);
  });

  it('with confirmations it stays that many blocks behind the head and indexes each log once', async () => {
    const src = await setupSource({ chain, engine: { confirmations: 3 } });
    const block = chain.mine([numberChanged(0n, 7n)]);
    await src.make().drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(chain.head - 3));
    expect(await canonicalLogs(src.sourceId)).toHaveLength(0);
    chain.mineEmpty(3);
    await makeRunnable(src.sourceId);
    await src.make().drain();
    expect((await checkpoint(src.sourceId)).block_number).toBe(String(chain.head - 3));
    expect((await canonicalLogs(src.sourceId)).map((l) => l.block_number)).toEqual([String(block)]);
  });
});
