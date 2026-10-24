import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { EvmAdapter } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { createTestDatabase, testServerUrl, type TestDatabase } from '@palletdock/db/testing';
import { DEFAULT_INDEXER_OPTIONS, processLease, runIndexerTick, type IndexerOptions } from '../src/indexer/indexer.js';
import { claimNextLease } from '../src/indexer/lease.js';
import { CONTRACT, FakeChain, STORAGE_ABI, VALUE_STORED_TOPIC, valueStored } from './fake-chain.js';

const serverUrl = testServerUrl();
if (!serverUrl) console.warn('[indexer.test] skipped: set PALLETDOCK_TEST_DATABASE_URL or DATABASE_URL to a PostgreSQL server with CREATEDB.');

const options = (workerId = 'test-worker', extra: Partial<IndexerOptions> = {}): IndexerOptions => ({
  ...DEFAULT_INDEXER_OPTIONS,
  workerId,
  random: () => 0,
  followIntervalMs: 0,
  backoffBaseMs: 1_000,
  ...extra,
});

describe.skipIf(!serverUrl)('event indexer', () => {
  let db: TestDatabase;
  let ownerId: string;
  let fingerprintId: string;

  beforeAll(async () => {
    db = await createTestDatabase(serverUrl!);
    ownerId = (await db.pool.query(`INSERT INTO owners(email,password_hash) VALUES ('owner@test.local','x') RETURNING id`)).rows[0].id;
    fingerprintId = (
      await db.pool.query(
        `INSERT INTO network_fingerprints(network_id,status,genesis_hash,evm_chain_id) VALUES ($1,'active',$2,$3) RETURNING id`,
        [PORTALDOT_V3_TESTNET.networkId, `0x${'ab'.repeat(32)}`, PORTALDOT_V3_TESTNET.evmChainId],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function seedSource(opts: { startBlock?: number; endBlock?: number | null; chunkSize?: number; topics?: string[] } = {}) {
    const q = db.pool;
    const projectId = (await q.query(`INSERT INTO projects(owner_id,name,network_id) VALUES ($1,$2,$3) RETURNING id`, [ownerId, `p-${randomBytes(4).toString('hex')}`, PORTALDOT_V3_TESTNET.networkId])).rows[0].id;
    const contractId = (await q.query(`INSERT INTO contracts(project_id,fingerprint_id,name,address,source) VALUES ($1,$2,'Storage',$3,'imported') RETURNING id`, [projectId, fingerprintId, CONTRACT])).rows[0].id;
    const abiVersionId = (await q.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,'test','import') RETURNING id`, [contractId, JSON.stringify(STORAGE_ABI)])).rows[0].id;
    const sourceId = (
      await q.query(
        `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,end_block)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [projectId, contractId, fingerprintId, abiVersionId, CONTRACT, opts.topics ? ['ValueStored'] : [], opts.topics ?? [], opts.startBlock ?? 0, opts.endBlock ?? null],
      )
    ).rows[0].id;
    await q.query(`INSERT INTO indexer_jobs(source_id,chunk_size) VALUES ($1,$2)`, [sourceId, opts.chunkSize ?? 500]);
    return { projectId, sourceId };
  }

  async function runUntilIdle(chain: FakeChain, sourceId: string, opts = options()) {
    const outcomes = [];
    for (let i = 0; i < 200; i++) {
      await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [sourceId]);
      const lease = await claimNextLease(db.pool, opts.workerId, opts.leaseTtlMs, sourceId);
      if (!lease) break;
      const outcome = await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), lease, opts);
      outcomes.push(outcome);
      if (['caught_up', 'completed', 'recovery_required', 'error', 'fenced'].includes(outcome.kind)) break;
    }
    return outcomes;
  }

  async function state(sourceId: string) {
    const [source, checkpoint, logs, coverage, job] = await Promise.all([
      db.pool.query(`SELECT status,last_error,reorg_epoch::text,generation::text,last_reorg_ancestor::text FROM indexer_sources WHERE id=$1`, [sourceId]),
      db.pool.query(`SELECT block_number::text,block_hash FROM indexer_checkpoints WHERE source_id=$1`, [sourceId]),
      db.pool.query(
        `SELECT r.block_number::text,r.block_hash,r.canonical,r.log_index,d.status AS decode_status,d.event_name,d.args,d.decode_error
           FROM raw_logs r LEFT JOIN decoded_events d ON d.raw_log_id=r.id WHERE r.source_id=$1 ORDER BY r.seq`,
        [sourceId],
      ),
      db.pool.query(`SELECT from_block::text,to_block::text,log_count FROM indexer_coverage WHERE source_id=$1 ORDER BY indexer_coverage.from_block`, [sourceId]),
      db.pool.query(`SELECT attempts,chunk_size,lease_token,next_run_at > now() AS deferred, extract(epoch FROM next_run_at - now()) AS delay_s FROM indexer_jobs WHERE source_id=$1`, [sourceId]),
    ]);
    return { source: source.rows[0], checkpoint: checkpoint.rows[0] ?? null, logs: logs.rows, coverage: coverage.rows, job: job.rows[0] };
  }

  /** Coverage must tile [start, checkpoint] exactly: no gaps, no overlaps. */
  function expectContiguous(coverage: Array<{ from_block: string; to_block: string }>, start: number, end: number) {
    let next = BigInt(start);
    for (const range of coverage) {
      expect(range.from_block).toBe(next.toString());
      next = BigInt(range.to_block) + 1n;
    }
    expect(next - 1n).toBe(BigInt(end));
  }

  it('backfills to head, records empty ranges as coverage, and decodes against the pinned ABI', async () => {
    const chain = new FakeChain(40, { 3: [valueStored(7n)], 25: [valueStored(2n ** 200n)] });
    const { sourceId } = await seedSource({ chunkSize: 10 });
    const outcomes = await runUntilIdle(chain, sourceId);
    expect(outcomes.at(-1)?.kind).toBe('caught_up');
    const s = await state(sourceId);
    expect(s.source.status).toBe('following');
    expect(s.checkpoint).toEqual({ block_number: '40', block_hash: chain.hashAt(40) });
    expectContiguous(s.coverage, 0, 40);
    expect(s.coverage.filter((c) => c.log_count === 0).length).toBeGreaterThan(0);
    expect(s.logs).toHaveLength(2);
    expect(s.logs[1]).toMatchObject({ block_number: '25', canonical: true, decode_status: 'decoded', event_name: 'ValueStored' });
    // uint256 above 2^53 stays an exact decimal string.
    expect(s.logs[1].args).toEqual({ setter: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', value: (2n ** 200n).toString() });
    // Adaptive window grew after full-size ranges succeeded.
    expect(s.job.chunk_size).toBeGreaterThan(10);
  });

  it('retains unknown and malformed logs instead of dropping them', async () => {
    const unknownTopic = keccak256(toHex('SomethingElse(uint256)'));
    const malformed = { topics: encodeEventTopics({ abi: STORAGE_ABI, eventName: 'ValueStored', args: { setter: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' } }) as Hex[], data: '0x1234' as Hex };
    const chain = new FakeChain(5, { 1: [{ topics: [unknownTopic], data: '0x' }], 2: [malformed] });
    const { sourceId } = await seedSource();
    await runUntilIdle(chain, sourceId);
    const s = await state(sourceId);
    expect(s.logs.map((l) => l.decode_status)).toEqual(['unknown_event', 'decode_error']);
    expect(s.logs[1].event_name).toBe('ValueStored');
    expect(s.logs[1].decode_error).toBeTruthy();
  });

  it('filters by configured topic0 when event topics are set', async () => {
    const other = { topics: [keccak256(toHex('Other()'))], data: '0x' as Hex };
    const chain = new FakeChain(5, { 1: [other, valueStored(1n)] });
    const { sourceId } = await seedSource({ topics: [VALUE_STORED_TOPIC] });
    await runUntilIdle(chain, sourceId);
    expect((await state(sourceId)).logs.map((l) => l.decode_status)).toEqual(['decoded']);
  });

  it('never duplicates logs when a range is ingested twice', async () => {
    const chain = new FakeChain(20, { 4: [valueStored(1n), valueStored(2n)], 15: [valueStored(3n)] });
    const { sourceId } = await seedSource({ chunkSize: 5 });
    await runUntilIdle(chain, sourceId);
    // Simulate a replay of the whole range (e.g. after an operator rewind).
    await db.pool.query(`DELETE FROM indexer_checkpoints WHERE source_id=$1`, [sourceId]);
    await db.pool.query(`DELETE FROM indexer_coverage WHERE source_id=$1`, [sourceId]);
    await runUntilIdle(chain, sourceId);
    const s = await state(sourceId);
    expect(s.logs).toHaveLength(3);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM decoded_events d JOIN raw_logs r ON r.id=d.raw_log_id WHERE r.source_id=$1`, [sourceId])).rows[0].n).toBe(3);
    expectContiguous(s.coverage, 0, 20);
  });

  it('resumes from the committed checkpoint after a worker restart', async () => {
    const chain = new FakeChain(60, { 10: [valueStored(1n)], 45: [valueStored(2n)] });
    const { sourceId } = await seedSource({ chunkSize: 8 });
    // First worker commits two ranges, then "crashes" (its process and adapter are discarded).
    for (let i = 0; i < 2; i++) {
      const lease = await claimNextLease(db.pool, 'worker-a', 60_000, sourceId);
      await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), lease!, options('worker-a'));
    }
    const mid = await state(sourceId);
    expect(mid.checkpoint.block_number).toBe('23'); // 0-7, then a doubled window 8-23
    // A fresh worker continues without re-reading the committed range.
    const restarted = new FakeChain(0);
    restarted.blocks = chain.blocks;
    await runUntilIdle(restarted, sourceId, options('worker-b'));
    const firstScan = restarted.calls.find((c) => c.method === 'eth_getLogs')!.params[0] as { fromBlock: Hex };
    expect(BigInt(firstScan.fromBlock)).toBe(24n);
    const s = await state(sourceId);
    expectContiguous(s.coverage, 0, 60);
    expect(s.logs).toHaveLength(2);
  });

  it('backs off on RPC failure, surfaces the error, and recovers', async () => {
    const chain = new FakeChain(10, { 2: [valueStored(5n)] });
    const { sourceId } = await seedSource();
    chain.failNext = 1;
    const [failed] = await runUntilIdle(chain, sourceId);
    expect(failed).toMatchObject({ kind: 'error', retryInMs: 500 }); // base 1000, attempt 0, zero jitter
    let s = await state(sourceId);
    expect(s.source.status).toBe('error');
    expect(s.source.last_error).toContain('HTTP 502');
    expect(s.job).toMatchObject({ attempts: 1, deferred: true, lease_token: null });
    // Not due yet: no worker may claim it before the backoff elapses.
    expect(await claimNextLease(db.pool, 'other', 60_000, sourceId)).toBeNull();

    chain.failNext = 1;
    await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [sourceId]);
    const second = await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), (await claimNextLease(db.pool, 'w', 60_000, sourceId))!, options());
    expect(second).toMatchObject({ kind: 'error', retryInMs: 1000 }); // doubled
    const logs = await db.pool.query(`SELECT level FROM ops_logs WHERE indexer_source_id=$1`, [sourceId]);
    expect(logs.rows.length).toBe(2);

    await runUntilIdle(chain, sourceId);
    s = await state(sourceId);
    expect(s.source).toMatchObject({ status: 'following', last_error: null });
    expect(s.job.attempts).toBe(0);
    expect(s.logs).toHaveLength(1);
  });

  it('splits the range when the RPC refuses a wide eth_getLogs window', async () => {
    const chain = new FakeChain(100, { 99: [valueStored(1n)] });
    chain.maxLogRange = 30n;
    const { sourceId } = await seedSource({ chunkSize: 500 });
    const outcomes = await runUntilIdle(chain, sourceId);
    expect(outcomes.filter((o) => o.kind === 'range_split').length).toBeGreaterThan(0);
    const s = await state(sourceId);
    expect(s.source.status).toBe('following');
    expect(s.job.attempts).toBe(0);
    expectContiguous(s.coverage, 0, 100);
    expect(s.logs).toHaveLength(1);
  });

  it('fences out a worker whose project is archived mid-fetch', async () => {
    const chain = new FakeChain(10, { 3: [valueStored(1n)] });
    const { sourceId, projectId } = await seedSource();
    const opts = options('worker-a', {
      beforeCommit: async () => {
        // Same statements as POST /workspace/projects/:id/archive.
        await db.pool.query(`UPDATE projects SET archived_at=now() WHERE id=$1`, [projectId]);
        await db.pool.query(`UPDATE indexer_sources SET desired_state='archived',status='stopped',generation=generation+1 WHERE project_id=$1`, [projectId]);
      },
    });
    const lease = await claimNextLease(db.pool, 'worker-a', 60_000, sourceId);
    const outcome = await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), lease!, opts);
    expect(outcome.kind).toBe('fenced');
    const s = await state(sourceId);
    expect(s.logs).toHaveLength(0);
    expect(s.checkpoint).toBeNull();
    expect(s.coverage).toHaveLength(0);
    expect(s.source).toMatchObject({ status: 'stopped', generation: '2' });
    // Archived sources are never claimed again, even once due.
    await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [sourceId]);
    expect(await claimNextLease(db.pool, 'worker-b', 60_000, sourceId)).toBeNull();
  });

  it('lets a second worker take over an expired lease and fences the stale holder', async () => {
    const chain = new FakeChain(10, { 3: [valueStored(1n)] });
    const { sourceId } = await seedSource();
    const leaseA = (await claimNextLease(db.pool, 'worker-a', 60_000, sourceId))!;
    // Held and unexpired: no one else can claim it.
    expect(await claimNextLease(db.pool, 'worker-b', 60_000, sourceId)).toBeNull();

    let leaseB: Awaited<ReturnType<typeof claimNextLease>> = null;
    const opts = options('worker-a', {
      beforeCommit: async () => {
        // Worker A stalls past its TTL; B takes over and commits first.
        await db.pool.query(`UPDATE indexer_jobs SET lease_expires_at=now() - interval '1 second' WHERE source_id=$1`, [sourceId]);
        leaseB = await claimNextLease(db.pool, 'worker-b', 60_000, sourceId);
        expect(leaseB).not.toBeNull();
        await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), leaseB!, options('worker-b'));
      },
    });
    const outcomeA = await processLease(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), leaseA, opts);
    expect(outcomeA).toMatchObject({ kind: 'fenced' });
    const s = await state(sourceId);
    expect(s.logs).toHaveLength(1);
    expect(s.coverage).toHaveLength(1);
    expect(s.checkpoint.block_number).toBe('10');
  });

  it('replaces a one-block reorg at the tip and keeps the orphaned log for audit', async () => {
    const chain = new FakeChain(12, { 12: [valueStored(1n)] });
    const { sourceId } = await seedSource();
    await runUntilIdle(chain, sourceId);
    const oldHash = chain.hashAt(12);
    chain.reorg(12, { 12: [valueStored(99n)] });
    const outcomes = await runUntilIdle(chain, sourceId);
    expect(outcomes[0]).toEqual({ kind: 'reorg', from: '12', ancestor: '11' });
    const s = await state(sourceId);
    expect(s.source).toMatchObject({ status: 'following', reorg_epoch: '1', last_reorg_ancestor: '11' });
    expect(s.checkpoint).toEqual({ block_number: '12', block_hash: chain.hashAt(12) });
    expect(s.logs.map((l) => [l.block_hash, l.canonical, (l.args as { value: string }).value])).toEqual([
      [oldHash, false, '1'],
      [chain.hashAt(12), true, '99'],
    ]);
    expectContiguous(s.coverage, 0, 12);
    const warn = await db.pool.query(`SELECT level,detail FROM ops_logs WHERE indexer_source_id=$1 AND level='WARN'`, [sourceId]);
    expect(warn.rows[0].detail).toMatchObject({ ancestor: '11', orphanedLogs: 1 });
  });

  it('finds the common ancestor of a multi-block fork using retained headers', async () => {
    const chain = new FakeChain(30, { 5: [valueStored(1n)], 22: [valueStored(2n)], 28: [valueStored(3n)] });
    const { sourceId } = await seedSource({ chunkSize: 10 });
    await runUntilIdle(chain, sourceId);
    chain.reorg(21, { 26: [valueStored(4n)] }, 32);
    const outcomes = await runUntilIdle(chain, sourceId);
    // Retained headers: 5, 9, 22, 28, 29(+). The newest still canonical is block 9.
    expect(outcomes[0]).toMatchObject({ kind: 'reorg', ancestor: '9' });
    const s = await state(sourceId);
    expect(s.logs.filter((l) => l.canonical).map((l) => l.block_number)).toEqual(['5', '26']);
    expect(s.logs.filter((l) => !l.canonical).map((l) => l.block_number)).toEqual(['22', '28']);
    expect(s.checkpoint).toEqual({ block_number: '32', block_hash: chain.hashAt(32) });
    expectContiguous(s.coverage, 0, 32);
  });

  it('requires recovery instead of guessing when a fork is deeper than the limit', async () => {
    const chain = new FakeChain(50, { 1: [valueStored(1n)] });
    const { sourceId } = await seedSource();
    await runUntilIdle(chain, sourceId);
    chain.reorg(1);
    const outcomes = await runUntilIdle(chain, sourceId, options('w', { maxReorgDepth: 10n }));
    expect(outcomes[0].kind).toBe('recovery_required');
    const s = await state(sourceId);
    expect(s.source.status).toBe('recovery_required');
    expect(s.logs.every((l) => l.canonical)).toBe(true); // nothing rolled back automatically
    await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [sourceId]);
    expect(await claimNextLease(db.pool, 'w', 60_000, sourceId)).toBeNull();
  });

  it('does not commit a range when the chain moves during the scan', async () => {
    const chain = new FakeChain(10, { 8: [valueStored(1n)] });
    const { sourceId } = await seedSource();
    let reorged = false;
    chain.onGetLogs = () => {
      if (!reorged) {
        reorged = true;
        chain.reorg(8, { 9: [valueStored(2n)] });
      }
    };
    const outcomes = await runUntilIdle(chain, sourceId);
    expect(outcomes[0].kind).toBe('chain_moved');
    const s = await state(sourceId);
    expect(s.logs.map((l) => [l.block_number, l.block_hash])).toEqual([['9', chain.hashAt(9)]]);
    expect(s.checkpoint.block_hash).toBe(chain.hashAt(10));
  });

  it('waits for a lagging node instead of treating it as a fork', async () => {
    const chain = new FakeChain(10, { 9: [valueStored(1n)] });
    const { sourceId } = await seedSource();
    await runUntilIdle(chain, sourceId);
    chain.reportedHead = 5n;
    const [outcome] = await runUntilIdle(chain, sourceId);
    expect(outcome.kind).toBe('error');
    const s = await state(sourceId);
    expect(s.source.reorg_epoch).toBe('0');
    expect(s.logs[0].canonical).toBe(true);
  });

  it('stops at end_block and marks the source completed', async () => {
    const chain = new FakeChain(30, { 12: [valueStored(1n)], 25: [valueStored(2n)] });
    const { sourceId } = await seedSource({ startBlock: 10, endBlock: 20 });
    const outcomes = await runUntilIdle(chain, sourceId);
    expect(outcomes.at(-1)).toMatchObject({ kind: 'committed', completed: true });
    const s = await state(sourceId);
    expect(s.source.status).toBe('completed');
    expectContiguous(s.coverage, 10, 20);
    expect(s.logs).toHaveLength(1);
    await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() WHERE source_id=$1`, [sourceId]);
    expect(await claimNextLease(db.pool, 'w', 60_000, sourceId)).toBeNull();
  });

  it('runIndexerTick drives every due source', async () => {
    const chain = new FakeChain(5, { 2: [valueStored(1n)] });
    const a = await seedSource();
    const b = await seedSource();
    await db.pool.query(`UPDATE indexer_jobs SET next_run_at=now() + interval '1 hour' WHERE source_id NOT IN ($1,$2)`, [a.sourceId, b.sourceId]);
    await runIndexerTick(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, chain), options('tick'), 100);
    for (const { sourceId } of [a, b]) expect((await state(sourceId)).checkpoint?.block_number).toBe('5');
  });
});
