import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encodeErrorResult, encodeFunctionResult, type Abi } from 'viem';
import { EvmAdapter, RpcResponseError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { sampleArtifacts } from '@palletdock/contracts';
import { createTestDatabase, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { buildServer } from '../src/server.js';
// The consumer demo's framework-free core, exercised against the real /v1 routes.
import { EMPTY_STATE, deriveView, readSnapshot, reconcile, type FetchLike } from '../../web/lib/consumer/core.js';

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
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(String(params[0])));
        if (n < 50) throw new RpcResponseError('Cannot construct OnlineClientAtBlock: UnknownBlock: State already discarded', -32000, null, method);
        return { number: String(params[0]), hash: '0x' + n.toString(16).padStart(64, '0'), parentHash: '0x' + (n - 1).toString(16).padStart(64, '0'), timestamp: '0x1' } as T;
      }
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
  process.env.PALLETDOCK_SIGNUP_MODE = 'invite';
  process.env.PALLETDOCK_SIGNUP_INVITE_CODE = 'test-registration-code-1234';
  process.env.PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES = '50';
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

describe('self-service signup', () => {
  it('publishes only signup availability, not the invite secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/signup-config' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, inviteRequired: true });
    expect(response.body).not.toContain('test-registration-code');
  });

  it('rejects weak passwords and an incorrect invite code', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'new@example.test', password: 'too-short', inviteCode: 'test-registration-code-1234' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('INVALID_REQUEST');

    const badInvite = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'new@example.test', password: 'a secure demo password', inviteCode: 'incorrect-registration-code' },
    });
    expect(badInvite.statusCode).toBe(401);
    expect((await db.pool.query(`SELECT count(1)::int AS n FROM owners WHERE email='new@example.test'`)).rows[0].n).toBe(0);
  });

  it('creates an isolated owner, hashes the password, and starts a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      headers: { 'user-agent': 'signup-test' },
      payload: { email: ' NEW@Example.Test ', password: 'a secure demo password', inviteCode: 'test-registration-code-1234' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().owner.email).toBe('new@example.test');
    expect(response.json().csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('palletdock_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const cookie = setCookie.split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().owner.email).toBe('new@example.test');
    const projects = await app.inject({ method: 'GET', url: '/workspace/projects', headers: { cookie } });
    expect(projects.json().data).toEqual([]);

    const stored = (await db.pool.query(`SELECT password_hash FROM owners WHERE email='new@example.test'`)).rows[0].password_hash;
    expect(stored).toMatch(/^scrypt\$/);
    expect(stored).not.toContain('a secure demo password');
  });

  it('does not create a second account for a case-insensitive duplicate email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email: 'New@Example.Test', password: 'another secure password', inviteCode: 'test-registration-code-1234' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
    expect((await db.pool.query(`SELECT count(1)::int AS n FROM owners WHERE lower(email)='new@example.test'`)).rows[0].n).toBe(1);
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

  it('reports a verified EVM denomination only from the active fingerprint’s runtime metadata', async () => {
    const txId = (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['42'], from: FROM })).json().data.transactionId;
    await db.pool.query(`UPDATE transactions SET fee_raw=3856912452799144200 WHERE id=$1`, [txId]);
    const detail = async () => (await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/transactions/${txId}`)).json().data;
    const original = (await db.pool.query(`SELECT token_symbol, token_decimals, spec_version, evidence FROM network_fingerprints WHERE id=$1`, [A.fingerprintId])).rows[0];

    // Seeded fingerprint has no native decimals or revive metadata: unverified, no token amounts.
    let d = await detail();
    expect(d.unitPolicy.status).toBe('unverified');
    expect(d.unitNote).toMatch(/^Fee, value and gas price are raw EVM base units\. Denomination unverified/);
    expect(d.feeTokens).toBeNull();
    expect(d.network).not.toHaveProperty('evidence');

    try {
      await db.pool.query(
        `UPDATE network_fingerprints SET token_symbol='tPOT', token_decimals=14, spec_version=3002, evidence='{"substrate":{"nativeToEthRatio":"10000"}}' WHERE id=$1`,
        [A.fingerprintId],
      );
      d = await detail();
      expect(d.unitPolicy).toMatchObject({ status: 'verified', decimals: 18, symbol: 'tPOT' });
      expect(d.unitNote).toContain('revive.nativeToEthRatio 10000');
      expect(d.feeTokens).toBe('3.8569124527991442 tPOT');
      const network = (await ws(sessionA, 'GET', '/workspace/network')).json().data;
      expect(network.evmUnitPolicy).toMatchObject({ status: 'verified', decimals: 18 });
      expect(network.fingerprint).not.toHaveProperty('evidence');

      // A fingerprint that is no longer active (e.g. after a network reset) is not trusted.
      await db.pool.query(`UPDATE network_fingerprints SET status='mismatch' WHERE id=$1`, [A.fingerprintId]);
      d = await detail();
      expect(d.unitPolicy.status).toBe('unverified');
      expect(d.feeTokens).toBeNull();
    } finally {
      await db.pool.query(`UPDATE network_fingerprints SET status='active', token_symbol=$2, token_decimals=$3, spec_version=$4, evidence=$5 WHERE id=$1`, [
        A.fingerprintId,
        original.token_symbol,
        original.token_decimals,
        original.spec_version,
        original.evidence,
      ]);
    }
  });

  it('refuses an indexer start block the RPC node has already pruned', async () => {
    const pruned = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources`, { contractId, events: ['NumberChanged'], startBlock: '12' });
    expect(pruned.statusCode).toBe(400);
    expect(pruned.json().error.message).toMatch(/older than the RPC node retains/);
    const ok = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources`, { contractId, events: ['NumberChanged'], startBlock: '60' });
    expect(ok.statusCode).toBe(201);
    await db.pool.query(`UPDATE indexer_sources SET desired_state='deleted', status='stopped' WHERE id=$1`, [ok.json().data.id]);
  });

  it('preflights reindex before changing checkpoints or canonical records', async () => {
    const created = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources`, { contractId, events: ['NumberChanged'], startBlock: '60' });
    expect(created.statusCode).toBe(201);
    const sourceId = created.json().data.id as string;
    const checkpointHash = '0x' + '6'.repeat(64);
    const transactionHash = '0x' + '7'.repeat(64);

    await db.pool.query(`UPDATE indexer_sources SET start_block=12, status='recovery_required', reorg_epoch=5, last_error='Historical state unavailable' WHERE id=$1`, [sourceId]);
    await db.pool.query(`INSERT INTO indexer_checkpoints(source_id,block_number,block_hash) VALUES ($1,60,$2)`, [sourceId, checkpointHash]);
    await db.pool.query(
      `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
       VALUES ($1,$2,$3,$4,60,$5,$6,0,0,'{}','0x')`,
      [sourceId, A.projectId, A.fingerprintId, ADDR, checkpointHash, transactionHash],
    );

    const refused = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources/${sourceId}/reindex`);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toMatch(/Nothing was changed.*Edit the source configuration/);
    expect((await db.pool.query(`SELECT status,reorg_epoch::text,generation::text,last_error FROM indexer_sources WHERE id=$1`, [sourceId])).rows[0]).toMatchObject({
      status: 'recovery_required',
      reorg_epoch: '5',
      generation: '1',
      last_error: 'Historical state unavailable',
    });
    expect((await db.pool.query(`SELECT block_number::text,block_hash FROM indexer_checkpoints WHERE source_id=$1`, [sourceId])).rows[0]).toEqual({ block_number: '60', block_hash: checkpointHash });
    expect((await db.pool.query(`SELECT canonical FROM raw_logs WHERE source_id=$1`, [sourceId])).rows[0].canonical).toBe(true);

    await db.pool.query(`UPDATE indexer_sources SET start_block=60 WHERE id=$1`, [sourceId]);
    const accepted = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources/${sourceId}/reindex`);
    expect(accepted.statusCode).toBe(200);
    expect((await db.pool.query(`SELECT status,reorg_epoch::text,generation::text,last_error FROM indexer_sources WHERE id=$1`, [sourceId])).rows[0]).toMatchObject({
      status: 'pending',
      reorg_epoch: '6',
      generation: '2',
      last_error: null,
    });
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM indexer_checkpoints WHERE source_id=$1`, [sourceId])).rows[0].count).toBe(0);
    expect((await db.pool.query(`SELECT canonical FROM raw_logs WHERE source_id=$1`, [sourceId])).rows[0].canonical).toBe(false);
    await db.pool.query(`UPDATE indexer_sources SET desired_state='deleted', status='stopped' WHERE id=$1`, [sourceId]);
  });

  it('tells the UI whether an indexer covers a transaction’s contract before its receipt is recorded', async () => {
    const txId = (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/contracts/${contractId}/prepare-write`, { function: 'store', args: ['5'], from: FROM })).json().data.transactionId;
    const configured = async () => (await ws(sessionA, 'GET', `/workspace/projects/${A.projectId}/transactions/${txId}`)).json().data.indexerConfigured;
    expect(await configured()).toBe(false);
    const src = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/indexer/sources`, { contractId, events: ['NumberChanged'], startBlock: '60' });
    expect(src.statusCode).toBe(201);
    expect(await configured()).toBe(true);
    await db.pool.query(`UPDATE indexer_sources SET desired_state='deleted', status='stopped' WHERE id=$1`, [src.json().data.id]);
    expect(await configured()).toBe(false);
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

  it('the payments sample deploys, sends value to its payable pay(orderRef), and refuses value for withdraw', async () => {
    const sample = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts/samples/payments`);
    expect(sample.statusCode).toBe(201);
    const deploy = await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/artifacts/${sample.json().data.id}/prepare-deploy`, { args: [], from: FROM });
    expect(deploy.statusCode).toBe(200);

    const project = (await ws(sessionA, 'POST', '/workspace/projects', { name: 'Payments demo' })).json().data;
    const payAbi = sampleArtifacts().find((s) => s.id === 'payments')!.artifact.abi;
    const imported = await ws(sessionA, 'POST', `/workspace/projects/${project.id}/contracts/import`, { name: 'Payments', address: ADDR, abi: payAbi });
    expect(imported.statusCode).toBe(201);
    const contractId = imported.json().data.id;
    const detail = (await ws(sessionA, 'GET', `/workspace/projects/${project.id}/contracts/${contractId}`)).json().data;
    expect(detail.writeFunctions.find((f: { name: string }) => f.name === 'pay').payable).toBe(true);
    expect(detail.writeFunctions.find((f: { name: string }) => f.name === 'withdraw').payable).toBe(false);

    const orderRef = '0x' + '0'.repeat(62) + '7b'; // order #123
    const oneTpot = '1000000000000000000';
    const pay = await ws(sessionA, 'POST', `/workspace/projects/${project.id}/contracts/${contractId}/prepare-write`, { function: 'pay', args: [orderRef], value: oneTpot, from: FROM });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().data.request.value).toBe('0xde0b6b3a7640000');
    expect(pay.json().data.review.valueRaw).toBe(oneTpot);

    const withdraw = await ws(sessionA, 'POST', `/workspace/projects/${project.id}/contracts/${contractId}/prepare-write`, { function: 'withdraw', args: [FROM], value: '1', from: FROM });
    expect(withdraw.statusCode).toBe(400);
    expect(withdraw.json().error.message).toMatch(/not payable/);
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

  it('the consumer demo core reads the real /v1 API, restarts on CURSOR_RESTART_REQUIRED, and shows each event once', async () => {
    const k = (await ws(sessionA, 'POST', `/workspace/projects/${A.projectId}/keys`, { name: 'consumer', scopes: ['events:read', 'indexer:read', 'transactions:read'], expiresInDays: 7 })).json();
    let rollBackAfterFirstPage = true;
    const viaApi: FetchLike = async (url, init) => {
      const u = new URL(url);
      const r = await app.inject({ url: u.pathname + u.search, headers: init.headers });
      if (rollBackAfterFirstPage && u.pathname.endsWith('/events') && !u.searchParams.get('cursor')) {
        // A rollback lands between page 1 and page 2 of this read.
        rollBackAfterFirstPage = false;
        await db.pool.query(`UPDATE indexer_sources SET reorg_epoch=reorg_epoch+1 WHERE project_id=$1`, [A.projectId]);
      }
      return { status: r.statusCode, json: async () => r.json() };
    };
    const read = (readKey: string) => readSnapshot({ apiUrl: 'http://palletdock.test', projectId: A.projectId, readKey, fetch: viaApi, pageLimit: 2 });
    const s = await read(k.secret);
    expect(s.restarts).toBe(1);
    expect(s.events.map((e) => e.blockNumber)).toEqual(['60', '70', '80', '90', '100']);
    expect(s.duplicatesDropped).toBe(0);
    expect(s.meta?.networkFingerprint?.id).toBe(A.fingerprintId);
    expect(s.sources?.length).toBeGreaterThan(0);
    const view = deriveView(reconcile(EMPTY_STATE, { ok: true, snapshot: s }), Date.now());
    expect(view.level).not.toBe('fresh'); // paused source without a checkpoint: not a healthy view
    expect(view.finality).toMatch(/^Unknown/);
    await expect(read('pd_live_nope.nope')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('the consumer claims absence only for the coverage of the events snapshot it read, not a newer /indexer checkpoint', async () => {
    const D = await seedWorkspace(db.pool, { email: 'd@example.test', projectName: 'Delta' });
    const sessionD = await login('d@example.test');
    expect((await ws(sessionD, 'POST', `/workspace/projects/${D.projectId}/contracts/import`, { name: 'Storage', address: ADDR, abi: ABI })).statusCode).toBe(201);
    const c = (await db.pool.query(`SELECT id FROM contracts WHERE project_id=$1`, [D.projectId])).rows[0];
    const av = (await db.pool.query(`SELECT id FROM abi_versions WHERE contract_id=$1`, [c.id])).rows[0];
    const src = (
      await db.pool.query(
        `INSERT INTO indexer_sources(project_id,contract_id,fingerprint_id,abi_version_id,contract_address,event_names,event_topics,start_block,desired_state,status,latest_observed_block,latest_observed_at)
         VALUES ($1,$2,$3,$4,$5,'{NumberChanged}','{0x00}',90,'running','following',100,now()) RETURNING id`,
        [D.projectId, c.id, D.fingerprintId, av.id, ADDR],
      )
    ).rows[0].id;
    await db.pool.query(`INSERT INTO indexer_checkpoints(source_id,block_number,block_hash) VALUES ($1,100,$2)`, [src, '0x' + 'a'.repeat(64)]);
    const k = (await ws(sessionD, 'POST', `/workspace/projects/${D.projectId}/keys`, { name: 'consumer', scopes: ['events:read', 'indexer:read', 'transactions:read'], expiresInDays: 7 })).json();

    // Between /events and /indexer of the first read, the worker indexes an event at 101 and commits checkpoint 101.
    let between: (() => Promise<unknown>) | null = async () => {
      await db.pool.query(
        `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
         VALUES ($1,$2,$3,$4,101,$5,$6,0,0,'{}','0x')`,
        [src, D.projectId, D.fingerprintId, ADDR, '0x' + 'b'.repeat(64), '0x' + 'c'.repeat(64)],
      );
      await db.pool.query(`UPDATE indexer_checkpoints SET block_number=101, block_hash=$2, committed_at=now() WHERE source_id=$1`, [src, '0x' + 'b'.repeat(64)]);
      await db.pool.query(`UPDATE indexer_sources SET latest_observed_block=101, latest_observed_at=now() WHERE id=$1`, [src]);
    };
    let eventsCalls = 0;
    const viaApi: FetchLike = async (url, init) => {
      const u = new URL(url);
      const r = await app.inject({ url: u.pathname + u.search, headers: init.headers });
      if (u.pathname.endsWith('/events')) {
        eventsCalls++;
        const run = between;
        between = null;
        await run?.();
      }
      return { status: r.statusCode, json: async () => r.json() };
    };
    const read = () => readSnapshot({ apiUrl: 'http://palletdock.test', projectId: D.projectId, readKey: k.secret, fetch: viaApi });

    const first = await read();
    expect(first.events).toEqual([]);
    expect(first.meta?.coverage[0]).toMatchObject({ sourceId: src, completed: { fromBlock: '90', toBlock: '100' }, reorgEpoch: '0' });
    expect(first.sources?.[0].checkpoint?.blockNumber).toBe('101'); // liveness is already newer
    let state = reconcile(EMPTY_STATE, { ok: true, snapshot: first });
    let view = deriveView(state, Date.now());
    expect(view.coverage?.toBlock).toBe('100');
    expect(view.emptyMessage).toMatch(/No matching event in blocks 90–100\b/);
    expect(view.emptyMessage).not.toMatch(/101/);
    expect(view.level).toBe('fresh'); // a one-block difference is noted (below), not treated as stale
    expect(view.reasons.join(' ')).toMatch(/advanced to block 101 since this snapshot, which covers up to 100/);

    state = reconcile(state, { ok: true, snapshot: await read() });
    view = deriveView(state, Date.now());
    expect(state.events.map((e) => e.blockNumber)).toEqual(['101']);
    expect(view.coverage?.toBlock).toBe('101');
    expect(view.level).toBe('fresh');

    // A rollback between /events and /indexer: the read is repeated as a whole, not stitched across generations.
    between = () => db.pool.query(`UPDATE indexer_sources SET reorg_epoch=reorg_epoch+1 WHERE id=$1`, [src]);
    const callsBefore = eventsCalls;
    const third = await read();
    expect(third.generationRestarts).toBe(1);
    expect(eventsCalls - callsBefore).toBe(2);
    expect(third.meta?.coverage[0].reorgEpoch).toBe('1');
    state = reconcile(state, { ok: true, snapshot: third });
    expect(state.events.map((e) => e.blockNumber)).toEqual(['101']); // once, no duplicate
    expect(state.notes.map((n) => n.text).join(' ')).toMatch(/generation changed between requests/);
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
