import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EvmAdapter, RpcTransportError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { TransactionTracker } from '../src/tx-tracker.js';
import { Backoff } from '../src/backoff.js';

const FROM = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const TO = '0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402';
const H = (n: number) => '0x' + n.toString(16).padStart(64, '0');

/** Receipt source whose answers the test changes between runs (fixture only). */
class ReceiptRpc implements RpcCaller {
  receipts = new Map<string, Record<string, unknown> | null>();
  down = false;
  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (this.down) throw new RpcTransportError('RPC eth_getTransactionReceipt returned HTTP 502', 'http', method, 502);
    if (method !== 'eth_getTransactionReceipt') throw new Error(`unexpected ${method}`);
    return (this.receipts.get(String(params[0])) ?? null) as T;
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
const rpc = new ReceiptRpc();
let tracker: TransactionTracker;

beforeAll(async () => {
  db = await createTestDatabase();
  ws = await seedWorkspace(db.pool);
  tracker = new TransactionTracker(db.pool, new EvmAdapter(PORTALDOT_V3_TESTNET, rpc));
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

async function run() {
  await db.pool.query(`UPDATE transactions SET last_checked_at=NULL`);
  return tracker.runOnce();
}

async function tx(id: string) {
  return (await db.pool.query(`SELECT inclusion_status, execution_status, block_number::text, block_hash, fee_raw::text, error_message, indexing_status FROM transactions WHERE id=$1`, [id])).rows[0];
}

async function stages(id: string) {
  return (await db.pool.query(`SELECT stage FROM transaction_observations WHERE transaction_id=$1 ORDER BY id`, [id])).rows.map((r) => r.stage);
}

describe('TransactionTracker', () => {
  it('records inclusion, then a disappearing receipt, then re-inclusion in another block', async () => {
    const hash = H(1);
    const id = await insertTx(hash);
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'pending', execution_status: 'unknown', block_number: null });

    rpc.receipts.set(hash, receipt(hash, 10, H(1010)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '10', block_hash: H(1010), fee_raw: (21000n * 1_000_000_000n).toString(), indexing_status: 'no_events' });

    // Receipt no longer returned: possible reorganization. Never reported as failure.
    rpc.receipts.set(hash, null);
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'reorged_out', execution_status: 'unknown', block_number: null, block_hash: null });

    // Re-included in a different block.
    rpc.receipts.set(hash, receipt(hash, 11, H(1011)));
    await run();
    expect(await tx(id)).toMatchObject({ inclusion_status: 'included', execution_status: 'success', block_number: '11', block_hash: H(1011) });
    expect(await stages(id)).toEqual(['receipt_observed', 'execution_succeeded', 'receipt_disappeared', 'receipt_moved', 'execution_succeeded']);
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
