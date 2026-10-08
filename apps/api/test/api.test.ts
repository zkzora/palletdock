import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encodeErrorResult, encodeFunctionResult, type Abi } from 'viem';
import { EvmAdapter, RpcResponseError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { buildServer } from '../src/server.js';

const ADDR = '0x5fb2e1c4a0d93b7e8c61f4a2b9d07e35c8a1f402';
const EMPTY = '0x1111111111111111111111111111111111111111';
const FROM = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const ABI = [
  { type: 'function', name: 'store', stateMutability: 'nonpayable', inputs: [{ name: 'newValue', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'retrieve', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'error', name: 'TooLarge', inputs: [{ name: 'limit', type: 'uint256' }] },
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

class FakeRpc implements RpcCaller {
  revertStore = false;
  async call<T>(method: string, params: readonly any[] = []): Promise<T> {
    switch (method) {
      case 'eth_blockNumber':
        return '0x64' as T;
      case 'eth_getCode':
        return (String(params[0]).toLowerCase() === ADDR ? '0x6080604052' : '0x') as T;
      case 'eth_call':
        return encodeFunctionResult({ abi: ABI, functionName: 'retrieve', result: 2n ** 255n + 7n }) as T;
      case 'eth_estimateGas':
        if (this.revertStore) throw new RpcResponseError('execution reverted', 3, encodeErrorResult({ abi: ABI, errorName: 'TooLarge', args: [100n] }), method);
        return '0x5208' as T;
      case 'eth_gasPrice':
        return '0x3b9aca00' as T;
      default:
        throw new RpcResponseError(`Method ${method} not found`, -32601, null, method);
    }
  }
}

let db: TestDatabase;
let app: FastifyInstance;
const rpc = new FakeRpc();
let A: Awaited<ReturnType<typeof seedWorkspace>>;
let B: Awaited<ReturnType<typeof seedWorkspace>>;
let sessionA: { cookie: string; csrf: string };
let sessionB: { cookie: string; csrf: string };

async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'correct horse battery staple' } });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  return { cookie, csrf: r.json().csrfToken as string };
}

const ws = (s: { cookie: string; csrf: string }, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { 'x-csrf-token': s.csrf }) } });

beforeAll(async () => {
  process.env.API_RATE_LIMIT_PER_MINUTE = '10000';
  db = await createTestDatabase();
  A = await seedWorkspace(db.pool, { email: 'a@example.test', projectName: 'Alpha' });
  B = await seedWorkspace(db.pool, { email: 'b@example.test', projectName: 'Beta' });
  app = await buildServer(db.pool, { evm: new EvmAdapter(PORTALDOT_V3_TESTNET, rpc), substrate: null, devControls: false });
  sessionA = await login('a@example.test');
  sessionB = await login('b@example.test');
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('session protections', () => {
  it('rejects workspace access without a session and mutations without CSRF', async () => {
    expect((await app.inject({ method: 'GET', url: '/workspace/projects' })).statusCode).toBe(401);
    const noCsrf = await app.inject({ method: 'POST', url: '/workspace/projects', payload: { name: 'X' }, headers: { cookie: sessionA.cookie } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_REJECTED');
  });

  it('rejects wrong passwords without revealing whether the account exists', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@example.test', password: 'wrong password!!' } });
    const r2 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nobody@example.test', password: 'wrong password!!' } });
    expect(r1.statusCode).toBe(401);
    expect(r1.json().error.message).toBe(r2.json().error.message);
  });
});

describe('project isolation', () => {
  it('hides another owner’s project from every workspace route', async () => {
    for (const path of ['overview', 'contracts', 'transactions', 'indexer', 'monitoring', 'keys', 'export']) {
      const r = await ws(sessionB, 'GET', `/workspace/projects/${A.projectId}/${path}`);
      expect(r.statusCode, path).toBe(404);
      expect(r.body).not.toContain('Alpha');
    }
    const mut = await ws(sessionB, 'POST', `/workspace/projects/${A.projectId}/contracts/import`, { name: 'x', address: ADDR, abi: ABI });
    expect(mut.statusCode).toBe(404);
    const list = await ws(sessionB, 'GET', '/workspace/projects');
    expect(list.json().data.map((p: { name: string }) => p.name)).toEqual(['Beta']);
  });

  it('returns 409 (not 500) when renaming a project to an existing name', async () => {
    const other = (await ws(sessionA, 'POST', '/workspace/projects', { name: 'Alpha Two' })).json().data;
    const r = await ws(sessionA, 'PATCH', `/workspace/projects/${other.id}`, { name: 'Alpha' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('CONFLICT');
  });

  it('returns 404 for malformed ids instead of a server error', async () => {
    expect((await ws(sessionA, 'GET', `/workspace/projects/not-a-uuid/contracts`)).statusCode).toBe(404);
    expect((await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/contracts/not-a-uuid`)).statusCode).toBe(404);
  });
});

describe('contracts', () => {
  let contractId: string;

  it('validates address, ABI, and runtime code presence on import', async () => {
    const badAbi = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/import`, { name: 'S', address: ADDR, abi: '[{"type":"function","name":"1bad"}]' });
    expect(badAbi.statusCode).toBe(400);
    const noCode = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/import`, { name: 'S', address: EMPTY, abi: ABI });
    expect(noCode.statusCode).toBe(400);
    expect(noCode.json().error.message).toMatch(/No runtime code/);
    const ok = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/import`, { name: 'Storage', address: ADDR, abi: ABI, deployBlock: '10' });
    expect(ok.statusCode).toBe(201);
    contractId = ok.json().data.id;
    const dup = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/import`, { name: 'Storage', address: ADDR, abi: ABI });
    expect(dup.statusCode).toBe(409);
  });

  it('reads through eth_call and renders large integers losslessly', async () => {
    const r = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/read`, { function: 'retrieve', args: [] });
    expect(r.statusCode).toBe(200);
    expect(r.json().data.result).toBe((2n ** 255n + 7n).toString());
  });

  it('prepares a write with estimates, rejects bad arguments, and decodes custom errors', async () => {
    const bad = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['-1'], from: FROM });
    expect(bad.statusCode).toBe(400);
    const ok = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['42'], from: FROM });
    expect(ok.statusCode).toBe(200);
    const d = ok.json().data;
    expect(d.request.chainId).toBe('0x190f1ca9');
    expect(d.review.fee.gasLimitEstimate).toBe('21000');
    expect(d.review.storageDeposit.status).toBe('unavailable');
    rpc.revertStore = true;
    const rev = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['999'], from: FROM });
    rpc.revertStore = false;
    expect(rev.json().data.review.simulatedRevert).toMatchObject({ name: 'TooLarge', args: ['100'] });
  });

  it('records wallet rejection, unknown submission, and refuses to rewrite a submitted record', async () => {
    const prep = async () =>
      (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['1'], from: FROM })).json().data.transactionId;
    const t1 = await prep();
    expect((await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/transactions/${t1}/submission`, { outcome: 'rejected', error: 'User rejected' })).statusCode).toBe(200);
    const t2 = await prep();
    await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/transactions/${t2}/submission`, { outcome: 'unknown', error: 'timeout' });
    const t3 = await prep();
    const hash = '0x' + 'ab'.repeat(32);
    expect((await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/transactions/${t3}/submission`, { outcome: 'submitted', hash })).statusCode).toBe(200);
    const back = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/transactions/${t3}/submission`, { outcome: 'rejected' });
    expect(back.statusCode).toBe(409);
    const detail = (await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/transactions/${t2}`)).json().data;
    expect(detail.status).toMatchObject({ submission: 'unknown', inclusion: 'not_observed', execution: 'unknown', finality: 'unknown' });
    const rejected = (await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/transactions?filter=rejected`)).json().data;
    expect(rejected.map((t: { id: string }) => t.id)).toContain(t1);
  });

  it('validates uploaded artifacts and refuses runtime-only or unlinked bytecode', async () => {
    const runtimeOnly = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts`, { artifact: { abi: ABI, deployedBytecode: '0x6080' } });
    expect(runtimeOnly.json().error.message).toMatch(/runtime/);
    const unlinked = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts`, {
      artifact: { abi: ABI, bytecode: '0x6080__$1234567890abcdef1234567890abcdef12$__6080' },
    });
    expect(unlinked.json().error.message).toMatch(/placeholder/);
    const sample = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts/samples/storage`);
    expect(sample.statusCode).toBe(201);
    const prep = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts/${sample.json().data.id}/prepare-deploy`, { args: [], from: FROM });
    expect(prep.statusCode).toBe(200);
    expect(prep.json().data.request.data.startsWith('0x')).toBe(true);
  });
});

describe('read API keys and v1 routes', () => {
  let secret: string;
  let keyId: string;

  it('creates a key whose secret is shown once and stored only as a hash', async () => {
    const r = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys`, { name: 'events', scopes: ['events:read', 'contracts:read'], expiresInDays: 7 });
    expect(r.statusCode).toBe(201);
    secret = r.json().secret;
    keyId = r.json().data.id;
    const row = (await db.pool.query('SELECT secret_hash FROM api_keys WHERE id=$1', [keyId])).rows[0];
    expect(row.secret_hash).not.toContain(secret);
    const list = await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/keys`);
    expect(list.body).not.toContain(secret.split('.')[1]);
  });

  it('enforces project scope and permissions', async () => {
    const bearer = { authorization: `Bearer ${secret}` };
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts`, headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/transactions`, headers: bearer })).json().error.code).toBe('FORBIDDEN_SCOPE');
    expect((await app.inject({ url: `/v1/projects/${B.projectId}/contracts`, headers: bearer })).statusCode).toBe(404);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts` })).statusCode).toBe(401);
    // A read key never authorizes workspace mutations.
    expect((await app.inject({ method: 'POST', url: `/workspace/projects/${A.projectId}/contracts/import`, headers: bearer, payload: {} })).statusCode).toBe(401);
  });

  it('validates filters and returns explicit unknown finality', async () => {
    const bearer = { authorization: `Bearer ${secret}` };
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/events?fromBlock=10&toBlock=5`, headers: bearer })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/events?limit=1000`, headers: bearer })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/events?bogus=1`, headers: bearer })).statusCode).toBe(400);
    const r = await app.inject({ url: `/v1/projects/${A.projectId}/events?finality=finalized`, headers: bearer });
    expect(r.json()).toMatchObject({ data: [], nextCursor: null, meta: { finality: 'unknown', networkId: 'portaldot-v3-testnet' } });
    expect(r.json().requestId).toMatch(/^req_/);
  });

  it('paginates events in chain order and requires a restart after a rollback', async () => {
    const bearer = { authorization: `Bearer ${secret}` };
    const c = (await db.pool.query(`SELECT id FROM contracts WHERE project_id=$1`, [A.projectId])).rows[0];
    const av = (await db.pool.query(`SELECT id FROM abi_versions WHERE contract_id=$1`, [c.id])).rows[0];
    const src = (
      await db.pool.query(
        `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,desired_state,status)
         VALUES ($1,$2,$3,$4,$5,'{NumberChanged}','{0x00}',0,'paused','paused') RETURNING id`,
        [A.projectId, c.id, A.fingerprintId, av.id, ADDR],
      )
    ).rows[0].id;
    for (let i = 0; i < 5; i++) {
      await db.pool.query(
        `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,'{}','0x')`,
        [src, A.projectId, A.fingerprintId, ADDR, 100 - i * 10, '0x' + String(i).repeat(64), '0x' + String(i + 5).repeat(64)],
      );
    }
    const p1 = (await app.inject({ url: `/v1/projects/${A.projectId}/events?limit=2`, headers: bearer })).json();
    expect(p1.data.map((e: { blockNumber: string }) => e.blockNumber)).toEqual(['60', '70']);
    const p2 = (await app.inject({ url: `/v1/projects/${A.projectId}/events?limit=2&cursor=${p1.nextCursor}`, headers: bearer })).json();
    expect(p2.data.map((e: { blockNumber: string }) => e.blockNumber)).toEqual(['80', '90']);
    // Cursor bound to filters.
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/events?limit=3&cursor=${p1.nextCursor}`, headers: bearer })).json().error.code).toBe('CURSOR_RESTART_REQUIRED');
    await db.pool.query(`UPDATE indexer_sources SET reorg_epoch=reorg_epoch+1 WHERE id=$1`, [src]);
    const p3 = await app.inject({ url: `/v1/projects/${A.projectId}/events?limit=2&cursor=${p2.nextCursor}`, headers: bearer });
    expect(p3.statusCode).toBe(409);
    expect(p3.json().error.code).toBe('CURSOR_RESTART_REQUIRED');
  });

  it('rejects revoked and expired keys and records requests without secrets', async () => {
    const bearer = { authorization: `Bearer ${secret}` };
    await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys/${keyId}/revoke`);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts`, headers: bearer })).statusCode).toBe(401);
    const k2 = (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys`, { name: 'short', scopes: ['contracts:read'], expiresInDays: 7 })).json();
    await db.pool.query(`UPDATE api_keys SET expires_at=now() - interval '1 minute' WHERE id=$1`, [k2.data.id]);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts`, headers: { authorization: `Bearer ${k2.secret}` } })).statusCode).toBe(401);
    const logs = await db.pool.query(`SELECT * FROM request_logs WHERE project_id=$1`, [A.projectId]);
    expect(logs.rowCount).toBeGreaterThan(3);
    expect(JSON.stringify(logs.rows)).not.toContain(secret.split('.')[1]);
    const mon = (await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/monitoring?range=1h&source=api`)).json().data;
    expect(mon.apiErrors.some((e: { code: string }) => e.code === 'UNAUTHORIZED')).toBe(true);
  });

  it('replaces a key: old secret stops working, new one is shown once', async () => {
    const k = (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys`, { name: 'rot', scopes: ['contracts:read'], expiresInDays: 30 })).json();
    const r = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys/${k.data.id}/replace`);
    expect(r.statusCode).toBe(201);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts`, headers: { authorization: `Bearer ${k.secret}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/v1/projects/${A.projectId}/contracts`, headers: { authorization: `Bearer ${r.json().secret}` } })).statusCode).toBe(200);
  });
});

describe('archive', () => {
  it('makes the project read-only and fences indexer sources without resuming on restore', async () => {
    const proj = (await ws(sessionB, 'POST', '/workspace/projects', { name: 'Gamma' })).json().data;
    expect((await ws(sessionB, 'POST', `/workspace/projects/${proj.id}/archive`)).statusCode).toBe(200);
    const blocked = await ws(sessionB, 'POST', `/workspace/projects/${proj.id}/contracts/import`, { name: 'S', address: ADDR, abi: ABI });
    expect(blocked.json().error.code).toBe('PROJECT_ARCHIVED');
    expect((await ws(sessionB, 'GET', `/workspace/projects/${proj.id}/contracts`)).statusCode).toBe(200);
    const restored = await ws(sessionB, 'POST', `/workspace/projects/${proj.id}/restore`);
    expect(restored.json().data.indexersResumed).toBe(false);
  });

  it('exports configuration without secrets', async () => {
    const r = await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/export`);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/secret_hash|pd_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}/);
    expect(r.json().contracts[0].abi_versions[0].abi).toBeTruthy();
  });
});
