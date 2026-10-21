import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvmAdapter, RpcResponseError, RpcTransportError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { TransactionTracker, type TrackerOptions } from '../src/tx-tracker.js';
import { restorePrunedFromObservations } from '../src/restore-pruned.js';
import { Backoff } from '../src/backoff.js';

const FROM = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const TO = '0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402';
const H = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/**
 * Chain double for the tracker (fixture only). Receipts, canonical block hashes
 * per height (or 'pruned', answered like the Portaldot V3 node does), the head,
 * and an outage switch are set per test. Every call is recorded.
 */
class ChainRpc implements RpcCaller {
  receipts = new Map<string, Record<string, unknown> | null>();
  blocks = new Map<number, string | 'pruned'>();
  head = 1000;
  down = false;
  calls: Array<{ method: string; param: unknown }> = [];
  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, param: params[0] });
    if (this.down) throw new RpcTransportError(`RPC ${method} returned HTTP 502`, 'http', method, 502);
    if (method === 'eth_getTransactionReceipt') return (this.receipts.get(String(params[0])) ?? null) as T;
    if (method === 'eth_blockNumber') return ('0x' + this.head.toString(16)) as T;
    if (method === 'eth_getBlockByNumber') {
      const n = Number(BigInt(String(params[0])));
      const b = this.blocks.get(n);
      if (b === 'pruned') {
        throw new RpcResponseError(`Cannot construct OnlineClientAtBlock: failed to obtain spec version for block ${H(n).slice(2)}: Backend error: State already discarded for ${H(n)}`, -32000, null, method);
      }
      return (b === undefined ? null : { number: '0x' + n.toString(16), hash: b, parentHash: H(0), timestamp: '0x1' }) as T;
    }
    throw new Error(`unexpected ${method}`);
  }
  receiptCalls(hash: string) {
    return this.calls.filter((c) => c.method === 'eth_getTransactionReceipt' && c.param === hash).length;
  }
}

function receipt(hash: string, block: number, blockHash: string, over: Record<string, unknown> = {}) {
  return {
    transactionHash: hash,
    blockNumber: '0x' + block.toString(16),
    blockHash,
    from: FROM,
    to: TO,
    contractAddress: null,
    status: '0x1',
    gasUsed: '0x5208',
    effectiveGasPrice: '0x3b9aca00',
    logs: [],
    ...over,
  };
}

let db: TestDatabase;
let ws: Awaited<ReturnType<typeof seedWorkspace>>;
const rpc = new ChainRpc();
const evm = new EvmAdapter(PORTALDOT_V3_TESTNET, rpc);
const OPTS: TrackerOptions = { confirmations: 5, retryBaseMs: 60_000, maxCheckFailures: 3, pendingMaxAgeMs: 24 * 60 * 60_000 };
let tracker: TransactionTracker;

beforeAll(async () => {
  db = await createTestDatabase();
  ws = await seedWorkspace(db.pool);
  tracker = new TransactionTracker(db.pool, evm, OPTS);
});
afterAll(async () => {
  await db?.drop();
});

async function insertTx(hash: string, over: Record<string, unknown> = {}) {
  const cols = { project_id: ws.projectId, fingerprint_id: ws.fingerprintId, origin: 'palletdock', kind: 'call', hash, from_address: FROM, to_address: TO, submission_status: 'submitted', inclusion_status: 'pending', ...over };
  const keys = Object.keys(cols);
  const r = await db.pool.query(`INSERT INTO transactions(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(cols));
  return r.rows[0].id as string;
}

/** Make every active transaction due now, then run one tracker pass. Terminal ones stay untouched. */
async function run(t: TransactionTracker = tracker) {
  await db.pool.query(`UPDATE transactions SET next_check_at=NULL WHERE tracking_status='active'`);
  return t.runOnce();
}

async function tx(id: string) {
  return (
    await db.pool.query(
      `SELECT inclusion_status, execution_status, block_number::text, block_hash, fee_raw::text, error_message, indexing_status, tracking_status, check_failures, next_check_at, receipt IS NOT NULL AS has_receipt FROM transactions WHERE id=$1`,
      [id],
    )
  ).rows[0];
}

async function stages(id: string) {
  return (await db.pool.query(`SELECT stage FROM transaction_observations WHERE transaction_id=$1 ORDER BY id`, [id])).rows.map((r) => r.stage);
}

async function observation(id: string, stage: string) {
  return (await db.pool.query(`SELECT id::text, detail, data, source FROM transaction_observations WHERE transaction_id=$1 AND stage=$2 ORDER BY id DESC LIMIT 1`, [id, stage])).rows[0];
}

describe('TransactionTracker', () => {
  it('records inclusion, a real reorg (different canonical hash at that height), then re-inclusion', async () => {
    const hash = H(1);
    const id = await insertTx(hash);
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'pending', execution_status: 'unknown', block_number: null });

    rpc.receipts.set(hash, receipt(hash, 10, H(1010)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '10', block_hash: H(1010), fee_raw: (21000n * 1_000_000_000n).toString(), indexing_status: 'no_events' });

    // Receipt gone and height 10 now has another hash: a real reorganization.
    rpc.receipts.set(hash, null);
    rpc.blocks.set(10, H(2010));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'reorged_out', execution_status: 'unknown', block_number: null, block_hash: null, tracking_status: 'active' });
    const gone = await observation(id, 'receipt_disappeared');
    expect(gone.data).toMatchObject({ previousBlockNumber: '10', previousBlockHash: H(1010), canonicalBlockHash: H(2010) });
    expect(gone.data.previousReceipt).not.toBeNull();

    // Re-included in a different block.
    rpc.receipts.set(hash, receipt(hash, 11, H(1011)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '11', block_hash: H(1011) });
    expect(await stages(id)).toEqual(['receipt_observed', 'execution_succeeded', 'receipt_disappeared', 'receipt_moved', 'execution_succeeded']);
  });

  it('treats a missing receipt in pruned history as history_pruned: snapshot kept, no reorg, checks stop', async () => {
    const hash = H(21);
    const id = await insertTx(hash);
    rpc.head = 25;
    rpc.receipts.set(hash, receipt(hash, 20, H(2000)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', block_number: '20', has_receipt: true, tracking_status: 'active' });

    // The node pruned it: no receipt, and the block lookup fails with "State already discarded".
    rpc.receipts.set(hash, null);
    rpc.blocks.set(20, 'pruned');
    rpc.head = 300;
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '20', block_hash: H(2000), has_receipt: true, tracking_status: 'history_pruned', next_check_at: null });
    const pruned = await observation(id, 'history_pruned');
    expect(pruned.detail).toMatch(/not a failure or a reorganization/);
    expect(pruned.data).toMatchObject({ blockNumber: '20', blockHash: H(2000), depth: '280', receiptKept: true });
    expect(await stages(id)).not.toContain('receipt_disappeared');

    // Terminal: no further receipt polling.
    const before = rpc.receiptCalls(hash);
    for (let i = 0; i < 3; i++) await run();
    expect(rpc.receiptCalls(hash)).toBe(before);
  });

  it('treats a still-canonical block with a missing receipt as pruned, not reorged', async () => {
    const hash = H(22);
    const id = await insertTx(hash);
    rpc.head = 33;
    rpc.receipts.set(hash, receipt(hash, 30, H(3000)));
    await run();
    rpc.receipts.set(hash, null);
    rpc.blocks.set(30, H(3000));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', block_number: '30', block_hash: H(3000), tracking_status: 'history_pruned' });
    expect((await observation(id, 'history_pruned')).detail).toMatch(/still canonical/);
  });

  it('keeps data on transient RPC failures, backs off, and stops after the failure limit', async () => {
    const hash = H(23);
    const id = await insertTx(hash);
    rpc.head = 42;
    rpc.receipts.set(hash, receipt(hash, 40, H(4000)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', block_number: '40' });

    rpc.down = true;
    const r = await run();
    expect(r.failed).toBeGreaterThan(0);
    let t = await tx(id);
    expect(t).toMatchObject({ inclusion_status: 'included', block_number: '40', block_hash: H(4000), has_receipt: true, check_failures: 1, tracking_status: 'active' });
    expect(new Date(t.next_check_at).getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Backoff is honoured: a pass before next_check_at does not touch it.
    const calls = rpc.receiptCalls(hash);
    await tracker.runOnce();
    expect(rpc.receiptCalls(hash)).toBe(calls);

    await run();
    await run();
    t = await tx(id);
    expect(t).toMatchObject({ inclusion_status: 'included', block_number: '40', block_hash: H(4000), has_receipt: true, tracking_status: 'gave_up', check_failures: 3 });
    expect((await observation(id, 'tracking_stopped')).data).toMatchObject({ failures: 3 });
    rpc.down = false;
    const stopped = rpc.receiptCalls(hash);
    await run();
    expect(rpc.receiptCalls(hash)).toBe(stopped);
  });

  it('keeps data when the block lookup fails transiently after a missing receipt', async () => {
    const hash = H(24);
    const id = await insertTx(hash);
    rpc.head = 52;
    rpc.receipts.set(hash, receipt(hash, 50, H(5000)));
    await run();
    rpc.receipts.set(hash, null);
    const original = rpc.call.bind(rpc);
    rpc.call = async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      if (method === 'eth_getBlockByNumber') throw new RpcTransportError('RPC eth_getBlockByNumber timed out', 'timeout', method);
      return original<T>(method, params);
    };
    try {
      await run();
    } finally {
      rpc.call = original;
    }
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', block_number: '50', block_hash: H(5000), has_receipt: true, tracking_status: 'active', check_failures: 1 });
    expect(await stages(id)).not.toContain('receipt_disappeared');
  });

  it('settles at the confirmation depth and stops polling', async () => {
    const hash = H(25);
    const id = await insertTx(hash);
    rpc.head = 62;
    rpc.receipts.set(hash, receipt(hash, 60, H(6000)));
    await run();
    await run();
    expect(await tx(id)).toMatchObject({ tracking_status: 'active' });
    expect((await tx(id)).next_check_at).not.toBeNull();

    rpc.head = 65;
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', tracking_status: 'settled', next_check_at: null });
    expect((await observation(id, 'tracking_settled')).data).toMatchObject({ depth: '5', confirmations: '5' });
    const calls = rpc.receiptCalls(hash);
    for (let i = 0; i < 3; i++) await run();
    expect(rpc.receiptCalls(hash)).toBe(calls);
  });

  it('caps the confirmation depth below the pruning depth it has observed (no hard-coded retention)', async () => {
    const t = new TransactionTracker(db.pool, evm, { ...OPTS, confirmations: 500 });
    expect(t.effectiveConfirmations).toBe(500n);
    const hash = H(26);
    const id = await insertTx(hash);
    rpc.head = 71;
    rpc.receipts.set(hash, receipt(hash, 70, H(7000)));
    await run(t);
    rpc.receipts.set(hash, null);
    rpc.blocks.set(70, 'pruned');
    rpc.head = 370;
    await run(t);
    expect((await tx(id)).tracking_status).toBe('history_pruned');
    expect(t.effectiveConfirmations).toBe(150n); // half of the 300-block depth at which pruning was seen
  });

  it('gives up waiting for inclusion after the pending window', async () => {
    const hash = H(27);
    const id = await insertTx(hash, { created_at: new Date(Date.now() - 3 * 60 * 60_000) });
    const t = new TransactionTracker(db.pool, evm, { ...OPTS, pendingMaxAgeMs: 60 * 60_000 });
    await run(t);
    expect(await tx(id)).toMatchObject({ inclusion_status: 'pending', tracking_status: 'gave_up', next_check_at: null });
    expect((await observation(id, 'tracking_stopped')).detail).toMatch(/not proof the transaction failed/);
  });

  it('records a revert as an included execution failure', async () => {
    const hash = H(2);
    const id = await insertTx(hash);
    rpc.receipts.set(hash, receipt(hash, 12, H(1012), { status: '0x0' }));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'reverted' });
    expect(await stages(id)).toContain('execution_reverted');
  });

  it('does not apply a receipt that does not match the reviewed sender', async () => {
    const hash = H(3);
    const id = await insertTx(hash);
    rpc.receipts.set(hash, receipt(hash, 13, H(1013), { from: '0x' + '22'.repeat(20) }));
    await run();
    await run();
    const t = await tx(id);
    expect(t).toMatchObject({ inclusion_status: 'pending', execution_status: 'unknown', block_number: null });
    expect(t.error_message).toMatch(/does not match/);
    expect(await stages(id)).toEqual(['receipt_mismatch']);
  });

  it('marks logs as not covered when no indexer source covers the emitting contract', async () => {
    const hash = H(4);
    const id = await insertTx(hash);
    rpc.receipts.set(hash, receipt(hash, 14, H(1014), { logs: [{ address: TO, topics: [H(9)], data: '0x', blockNumber: '0xe', blockHash: H(1014), transactionHash: hash, transactionIndex: '0x0', logIndex: '0x0' }] }));
    await run();
    expect((await tx(id)).indexing_status).toBe('not_covered');
  });

  it('adds a deployed contract from a successful deployment receipt', async () => {
    const art = await db.pool.query(
      `INSERT INTO artifacts(project_id,name,contract_name,abi,creation_bytecode,bytecode_kind,checksum_sha256,provenance) VALUES ($1,'Storage','PalletDockStorage','[]','0x6080','evm','abc','bundled-sample') RETURNING id`,
      [ws.projectId],
    );
    const hash = H(5);
    const id = await insertTx(hash, { kind: 'deploy', to_address: null, artifact_id: art.rows[0].id });
    const created = '0x' + '33'.repeat(20);
    rpc.receipts.set(hash, receipt(hash, 15, H(1015), { to: null, contractAddress: created }));
    await run();
    const c = await db.pool.query(`SELECT c.address, c.source, c.deploy_block::text, a.version FROM contracts c JOIN abi_versions a ON a.contract_id=c.id WHERE c.project_id=$1 AND c.address=$2`, [ws.projectId, created]);
    expect(c.rows[0]).toMatchObject({ source: 'deployed', deploy_block: '15', version: 1 });
    expect(await stages(id)).toContain('contract_tracked');
  });

  it('reports RPC failures so the worker can back off', async () => {
    const hash = H(6);
    await insertTx(hash);
    rpc.down = true;
    const r = await run();
    rpc.down = false;
    expect(r.checked).toBeGreaterThan(0);
    expect(r.failed).toBe(r.checked);
  });
});

describe('restorePrunedFromObservations', () => {
  /** A transaction as the earlier tracker left it: reorged_out with its snapshot cleared. */
  async function legacyClearedTx(hash: string, block: number, blockHash: string, opts: { disappearedHash?: string } = {}) {
    const id = await insertTx(hash, { inclusion_status: 'reorged_out', execution_status: 'unknown', tracking_status: 'active', gas_used: 21000, fee_raw: 21000 });
    const obs = async (stage: string, detail: string) =>
      (await db.pool.query(`INSERT INTO transaction_observations(transaction_id,stage,detail,source) VALUES ($1,$2,$3,'worker:eth_getTransactionReceipt') RETURNING id::text`, [id, stage, detail])).rows[0].id as string;
    const receiptObs = await obs('receipt_observed', `Receipt observed in block ${block} (${blockHash}). Inclusion only; finality not confirmed.`);
    const execObs = await obs('execution_succeeded', 'Receipt status 0x1.');
    const goneObs = await obs('receipt_disappeared', `Receipt previously seen in ${opts.disappearedHash ?? blockHash} is no longer returned (possible reorganization). The transaction may be re-included.`);
    return { id, receiptObs, execObs, goneObs };
  }

  it('restores a pruned snapshot with provenance only on --apply, and skips real reorgs and inconsistent logs', async () => {
    const pruned = await legacyClearedTx(H(31), 133023, H(133023));
    const reorged = await legacyClearedTx(H(32), 133024, H(133024));
    const inconsistent = await legacyClearedTx(H(33), 133025, H(133025), { disappearedHash: H(999) });
    rpc.blocks.set(133023, 'pruned');
    rpc.blocks.set(133024, H(424242)); // a different canonical hash: real reorganization

    const dry = await restorePrunedFromObservations(db.pool, evm, { apply: false });
    const byHash = (rs: typeof dry, h: string) => rs.find((r) => r.hash === h)!;
    expect(byHash(dry, H(31))).toMatchObject({ action: 'restore', restored: { blockNumber: '133023', blockHash: H(133023), execution: 'success', trackingStatus: 'history_pruned' } });
    expect(byHash(dry, H(32))).toMatchObject({ action: 'skip' });
    expect(byHash(dry, H(32)).reason).toMatch(/real reorganization/);
    expect(byHash(dry, H(33)).reason).toMatch(/disagree/);
    expect(await tx(pruned.id)).toMatchObject({ inclusion_status: 'reorged_out', block_number: null }); // dry run wrote nothing

    await restorePrunedFromObservations(db.pool, evm, { apply: true });
    expect(await tx(pruned.id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '133023', block_hash: H(133023), tracking_status: 'history_pruned', has_receipt: false });
    const restored = await observation(pruned.id, 'restored_from_observations');
    expect(restored.source).toBe('restore:observation-log');
    expect(restored.data.sourceObservations).toMatchObject({ receipt: { id: pruned.receiptObs }, execution: { id: pruned.execObs }, disappearance: { id: pruned.goneObs } });
    expect(restored.data).toMatchObject({ chainCheck: 'pruned' });
    expect(restored.data.nodeEvidence).toMatch(/State already discarded/);
    expect(await tx(reorged.id)).toMatchObject({ inclusion_status: 'reorged_out', block_number: null });
    expect(await tx(inconsistent.id)).toMatchObject({ inclusion_status: 'reorged_out', block_number: null });

    // Idempotent: nothing left to restore for that transaction.
    const again = await restorePrunedFromObservations(db.pool, evm, { apply: true });
    expect(again.find((r) => r.hash === H(31))).toBeUndefined();
    // And the tracker leaves the restored, pruned transaction alone.
    const calls = rpc.receiptCalls(H(31));
    await run();
    expect(rpc.receiptCalls(H(31))).toBe(calls);
  });
});

describe('Backoff', () => {
  it('grows exponentially with jitter, is bounded, and resets on success', () => {
    const b = new Backoff({ baseMs: 1000, maxMs: 8000, healthyMs: 500, random: () => 1 });
    const t = 0;
    expect(b.failure(t)).toBe(1000);
    expect(b.failure(t)).toBe(2000);
    expect(b.failure(t)).toBe(4000);
    expect(b.failure(t)).toBe(8000);
    expect(b.failure(t)).toBe(8000);
    expect(b.ready(7999)).toBe(false);
    expect(b.ready(8000)).toBe(true);
    expect(b.success(t)).toBe(500);
    expect(b.consecutiveFailures).toBe(0);
    const low = new Backoff({ baseMs: 1000, maxMs: 8000, healthyMs: 500, random: () => 0 });
    expect(low.failure(0)).toBe(500);
  });
});

describe('Backoff.attempt', () => {
  it('skips overlapping attempts while one is in flight and records the failure once', async () => {
    let clock = 0;
    const b = new Backoff({ baseMs: 60_000, maxMs: 1_800_000, healthyMs: 60_000, random: () => 1 });
    let release!: (v: boolean) => void;
    let calls = 0;
    const slow = b.attempt(() => { calls++; return new Promise<boolean>((r) => (release = r)); }, (v) => v, () => clock);
    clock = 5_000;
    expect((await b.attempt(async () => { calls++; return true; }, (v) => v, () => clock)).ran).toBe(false);
    release(false);
    const r = await slow;
    expect(r).toMatchObject({ ran: true, nextInMs: 60_000 });
    expect(calls).toBe(1);
    expect(b.consecutiveFailures).toBe(1);
    clock = 30_000;
    expect(b.ready(clock)).toBe(false);
  });
});
