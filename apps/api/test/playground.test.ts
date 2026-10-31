import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { encodeFunctionResult, type Abi } from 'viem';
import { EvmAdapter, RpcResponseError, type RpcCaller } from '@palletdock/chain';
import { PORTALDOT_V3_TESTNET } from '@palletdock/shared';
import { codeMatchesArtifact, sampleArtifacts, sampleOrderRef } from '@palletdock/contracts';
import { createTestDatabase, expireGuest, seedWorkspace, type TestDatabase } from '../../../test-support/db.js';
import { buildServer } from '../src/server.js';
import { resolveGuestConfig } from '../src/guest-config.js';

/**
 * Temporary playground workspaces: creation, isolation, quotas, expiry, the guided
 * checklist, and conversion into an account. Fake RPC only (no chain traffic).
 */
const PROXY_SECRET = 'playground-test-proxy-secret-0123456789abcdef';
const INTENT = { 'x-palletdock-intent': 'start-playground' };
const FROM = '0x7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315';
const STORAGE = sampleArtifacts().find((s) => s.id === 'storage')!.artifact;
const TOKEN = sampleArtifacts().find((s) => s.id === 'erc20')!.artifact;
// Operator-shared template contracts on the fake chain (runtime code per address).
const SHARED_STORAGE = '0x5ba7ed00000000000000000000000000000000aa';
const SHARED_TOKEN = '0x5ba7ed00000000000000000000000000000000bb';
const NOT_THE_ARTIFACT = '0x5ba7ed00000000000000000000000000000000cc';
const CODE: Record<string, string> = {
  [SHARED_STORAGE]: STORAGE.deployedBytecode,
  [SHARED_TOKEN]: TOKEN.deployedBytecode,
  [NOT_THE_ARTIFACT]: '0x6080604052600080fd',
};

class FakeRpc implements RpcCaller {
  async call<T>(method: string, params: readonly any[] = []): Promise<T> {
    switch (method) {
      case 'eth_blockNumber':
        return '0x64' as T;
      case 'eth_call':
        return encodeFunctionResult({ abi: STORAGE.abi as Abi, functionName: 'retrieve', result: 0n }) as T;
      case 'eth_estimateGas':
        return '0x5208' as T;
      case 'eth_gasPrice':
        return '0x3b9aca00' as T;
      case 'eth_getCode':
        return (CODE[String(params[0]).toLowerCase()] ?? '0x') as T;
      case 'eth_getBlockByNumber': {
        const n = Number(BigInt(String(params[0])));
        // Like the Portaldot node: older state is discarded.
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
let ipSeq = 0;
type Guest = { cookie: string; csrf: string; projectId: string; token: string };

/** A visitor address forwarded by the web proxy (trusted only with the shared secret). */
const visitor = () => ({ 'x-palletdock-client-ip': `198.51.100.${++ipSeq}`, 'x-palletdock-proxy-secret': PROXY_SECRET });

async function startGuest(headers: Record<string, string> = visitor(), payload: unknown = { template: 'storage' }): Promise<Guest> {
  const r = await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...headers }, payload: payload as never });
  expect(r.statusCode, r.body).toBe(201);
  const setCookie = String(r.headers['set-cookie']);
  const token = setCookie.split(';')[0].split('=')[1];
  return { cookie: setCookie.split(';')[0], csrf: r.json().csrfToken, projectId: r.json().projectId, token };
}

const call = (s: { cookie: string; csrf?: string }, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, headers: { cookie: s.cookie, ...(method === 'GET' || !s.csrf ? {} : { 'x-csrf-token': s.csrf }), ...extra } });

const owners = async () => (await db.pool.query(`SELECT count(*)::int AS n FROM owners`)).rows[0].n as number;

beforeAll(async () => {
  process.env.API_RATE_LIMIT_PER_MINUTE = '10000';
  process.env.PALLETDOCK_PROXY_SECRET = PROXY_SECRET;
  process.env.PALLETDOCK_PLAYGROUND_ENABLED = '1';
  process.env.PALLETDOCK_PLAYGROUND_STARTS_PER_HOUR = '3';
  process.env.PALLETDOCK_SIGNUP_MODE = 'invite';
  process.env.PALLETDOCK_SIGNUP_INVITE_CODE = 'test-registration-code-1234';
  process.env.PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES = '50';
  db = await createTestDatabase();
  await seedWorkspace(db.pool, { email: 'owner@example.test', projectName: 'Owner project' });
  app = await buildServer(db.pool, { evm: new EvmAdapter(PORTALDOT_V3_TESTNET, new FakeRpc()), substrate: null, devControls: false });
});
afterAll(async () => {
  await app?.close();
  await db?.drop();
  delete process.env.PALLETDOCK_PROXY_SECRET;
  delete process.env.PALLETDOCK_PLAYGROUND_ENABLED;
});

describe('starting a playground', () => {
  it('publishes config and templates without creating anything', async () => {
    const before = await owners();
    const r = await app.inject({ method: 'GET', url: '/auth/playground-config' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ enabled: true, lifetimeMinutes: 360, limits: { projects: 1, contracts: 2, indexerSources: 1, readKeys: 1 } });
    expect(r.json().templates.map((t: { id: string }) => t.id)).toEqual(['storage', 'payments', 'erc20', 'erc721']);
    // GET/HEAD to the start route never creates a guest either.
    expect((await app.inject({ method: 'GET', url: '/auth/playground' })).statusCode).toBe(404);
    expect(await owners()).toBe(before);
  });

  it('requires the explicit intent header (no cross-site form posts) and creates nothing otherwise', async () => {
    const before = await owners();
    const r = await app.inject({ method: 'POST', url: '/auth/playground', headers: visitor(), payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await owners()).toBe(before);
  });

  it('starts without email, password, or wallet, with a hashed random session token', async () => {
    const g = await startGuest();
    const raw = await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor() }, payload: {} });
    const setCookie = String(raw.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toMatch(/Expires=/);
    const owner = (await db.pool.query(`SELECT o.kind,o.email,o.password_hash,o.guest_expires_at FROM owners o JOIN projects p ON p.owner_id=o.id WHERE p.id=$1`, [g.projectId])).rows[0];
    expect(owner).toMatchObject({ kind: 'guest', email: null, password_hash: null });
    expect(new Date(owner.guest_expires_at).getTime() - Date.now()).toBeGreaterThan(355 * 60_000);
    const session = (await db.pool.query(`SELECT token_hash FROM sessions s JOIN projects p ON p.owner_id=s.owner_id WHERE p.id=$1`, [g.projectId])).rows[0];
    expect(session.token_hash).not.toBe(g.token);
    expect(session.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const me = await call(g, 'GET', '/auth/me');
    expect(me.json()).toMatchObject({ owner: { email: null, kind: 'guest', displayName: 'Temporary workspace' }, session: { kind: 'guest' }, playground: { limits: { contracts: 2 } } });
    expect(me.json().session.expiresAt).toBe(new Date(owner.guest_expires_at).toISOString());
    expect(me.body).not.toContain(g.token);
    expect(me.body).not.toContain(session.token_hash);

    const projects = await call(g, 'GET', '/workspace/projects');
    expect(projects.json().data).toHaveLength(1);
    expect(projects.json().data[0].id).toBe(g.projectId);
  });

  it('never replaces an existing account session, and reuses a still-valid guest', async () => {
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
    const accountCookie = String(login.headers['set-cookie']).split(';')[0];
    const before = await owners();
    const r = await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor(), cookie: accountCookie }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: false, session: { kind: 'account' } });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await owners()).toBe(before);
    expect((await call({ cookie: accountCookie }, 'GET', '/auth/me')).json().session.kind).toBe('account');

    const g = await startGuest();
    const again = await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor(), cookie: g.cookie }, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, projectId: g.projectId });
  });

  it('limits starts per trusted visitor address, persistently and under concurrency', async () => {
    const ip = { 'x-palletdock-client-ip': '203.0.113.7', 'x-palletdock-proxy-secret': PROXY_SECRET };
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...ip }, payload: {} })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect(results.filter((r) => r.statusCode === 429).every((r) => r.json().error.code === 'RATE_LIMITED')).toBe(true);
    // Another forwarded address is a different visitor...
    expect((await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor() }, payload: {} })).statusCode).toBe(201);
    // ...but a forwarded address without the proxy secret is ignored (connection address used),
    // so rotating spoofed headers does not escape the limit.
    const spoofed = await Promise.all(
      Array.from({ length: 5 }, (_, i) => app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, 'x-palletdock-client-ip': `192.0.2.${i}`, 'x-forwarded-for': `192.0.2.${i}` }, payload: {} })),
    );
    expect(spoofed.filter((r) => r.statusCode === 201).length).toBeLessThanOrEqual(3);
  });

  it('enforces the global capacity atomically', async () => {
    const active = (await db.pool.query(`SELECT count(*)::int AS n FROM owners WHERE kind='guest' AND guest_expires_at > now()`)).rows[0].n;
    process.env.PALLETDOCK_PLAYGROUND_CAPACITY = String(active + 2);
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor() }, payload: {} })));
      expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
      expect(results.filter((r) => r.statusCode === 503).every((r) => r.json().error.code === 'PLAYGROUND_FULL')).toBe(true);
    } finally {
      delete process.env.PALLETDOCK_PLAYGROUND_CAPACITY;
    }
  });

  it('is off unless explicitly enabled', async () => {
    process.env.PALLETDOCK_PLAYGROUND_ENABLED = '0';
    try {
      const before = await owners();
      const r = await app.inject({ method: 'POST', url: '/auth/playground', headers: { ...INTENT, ...visitor() }, payload: {} });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('PLAYGROUND_DISABLED');
      expect((await app.inject({ method: 'GET', url: '/auth/playground-config' })).json().enabled).toBe(false);
      expect(await owners()).toBe(before);
    } finally {
      process.env.PALLETDOCK_PLAYGROUND_ENABLED = '1';
    }
  });
});

describe('guest isolation and restrictions', () => {
  it('guest A cannot read or mutate guest B, and mutations need CSRF', async () => {
    const a = await startGuest();
    const b = await startGuest();
    for (const url of [`/workspace/projects/${b.projectId}/overview`, `/workspace/projects/${b.projectId}/contracts`, `/workspace/projects/${b.projectId}/playground`, `/workspace/projects/${b.projectId}/keys`]) {
      expect((await call(a, 'GET', url)).statusCode, url).toBe(404);
    }
    expect((await call(a, 'POST', `/workspace/projects/${b.projectId}/playground/template`, { template: 'erc20' })).statusCode).toBe(404);
    expect((await call(a, 'POST', `/workspace/projects/${b.projectId}/keys`, { name: 'x', scopes: ['events:read'], expiresInDays: 7 })).statusCode).toBe(404);
    const noCsrf = await call({ cookie: a.cookie }, 'POST', `/workspace/projects/${a.projectId}/playground/template`, { template: 'erc20' });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('CSRF_REJECTED');
    const badCsrf = await call({ cookie: a.cookie, csrf: b.csrf }, 'POST', `/workspace/projects/${a.projectId}/playground/template`, { template: 'erc20' });
    expect(badCsrf.statusCode).toBe(403);
  });

  it('refuses extra projects, uploads, and archive with a clear reason', async () => {
    const g = await startGuest();
    const project = await call(g, 'POST', '/workspace/projects', { name: 'Second' });
    expect(project.statusCode).toBe(403);
    expect(project.json().error.code).toBe('GUEST_RESTRICTED');
    const upload = await call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts`, { name: 'x', artifact: JSON.stringify(STORAGE) });
    expect(upload.json().error.code).toBe('GUEST_RESTRICTED');
    expect((await call(g, 'POST', `/workspace/projects/${g.projectId}/archive`)).json().error.code).toBe('GUEST_RESTRICTED');
  });
});

describe('guest quotas under concurrency', () => {
  it('allows one active read key, capped at the workspace expiry', async () => {
    const g = await startGuest();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call(g, 'POST', `/workspace/projects/${g.projectId}/keys`, { name: `k${i}`, scopes: ['events:read'], expiresInDays: 365 })),
    );
    const created = results.filter((r) => r.statusCode === 201);
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'LIMIT_REACHED')).toBe(true);
    const expiry = (await call(g, 'GET', '/auth/me')).json().session.expiresAt;
    expect(new Date(created[0].json().data.expires_at).getTime()).toBeLessThanOrEqual(new Date(expiry).getTime());
    // Replacing keeps the cap too.
    const replaced = await call(g, 'POST', `/workspace/projects/${g.projectId}/keys/${created[0].json().data.id}/replace`);
    expect(replaced.statusCode).toBe(201);
    expect(new Date(replaced.json().data.expires_at).getTime()).toBeLessThanOrEqual(new Date(expiry).getTime());
  });

  it('allows two contracts, counting prepared deployments, even with parallel requests', async () => {
    const g = await startGuest();
    const sample = await call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts/samples/storage`);
    const artifactId = sample.json().data.id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts/${artifactId}/prepare-deploy`, { args: [], from: FROM })),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'LIMIT_REACHED')).toBe(true);
  });

  it('allows one indexer source; repeated playground setup returns the same source', async () => {
    const g = await startGuest();
    const { contractId } = await trackedStorage(g, 80);
    const results = await Promise.all(Array.from({ length: 4 }, () => call(g, 'POST', `/workspace/projects/${g.projectId}/playground/indexer-source`, { contractId })));
    expect(results.every((r) => [200, 201].includes(r.statusCode)), results.map((r) => r.body).join('\n')).toBe(true);
    expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM indexer_sources WHERE project_id=$1`, [g.projectId])).rows[0].n).toBe(1);
    // A second, different source is over the guest quota.
    const second = await call(g, 'POST', `/workspace/projects/${g.projectId}/indexer/sources`, { contractId, events: ['NumberChanged'], startBlock: '90' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('LIMIT_REACHED');
  });

  it('bounds the workspace action budget atomically', async () => {
    process.env.PALLETDOCK_PLAYGROUND_MAX_ACTIONS = '10';
    try {
      const g = await startGuest();
      const results = await Promise.all(Array.from({ length: 14 }, () => call(g, 'POST', `/workspace/projects/${g.projectId}/playground/template`, { template: 'storage' })));
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
      expect(results.filter((r) => r.statusCode === 409).every((r) => r.json().error.code === 'LIMIT_REACHED')).toBe(true);
    } finally {
      delete process.env.PALLETDOCK_PLAYGROUND_MAX_ACTIONS;
    }
  });
});

/** A deployed PalletDockStorage contract as the worker records it from a deployment receipt. */
async function trackedStorage(g: Guest, deployBlock: number) {
  const sample = await call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts/samples/storage`);
  const artifactId = sample.json().data.id;
  const fp = (await db.pool.query(`SELECT id FROM network_fingerprints WHERE status='active'`)).rows[0].id;
  const address = `0x${(deployBlock + 1000).toString(16).padStart(40, '0')}`;
  const deployHash = `0x${deployBlock.toString(16).padStart(64, 'd')}`;
  const c = await db.pool.query(
    `INSERT INTO contracts(project_id,fingerprint_id,name,address,source,artifact_id,deploy_tx_hash,deploy_block) VALUES ($1,$2,'PalletDockStorage',$3,'deployed',$4,$5,$6) RETURNING id`,
    [g.projectId, fp, address, artifactId, deployHash, deployBlock],
  );
  const av = await db.pool.query(`INSERT INTO abi_versions(contract_id,version,abi,abi_sha256,provenance) VALUES ($1,1,$2,'x','artifact') RETURNING id`, [c.rows[0].id, JSON.stringify(STORAGE.abi)]);
  await db.pool.query(
    `INSERT INTO transactions(project_id,fingerprint_id,artifact_id,contract_id,origin,kind,hash,from_address,submission_status,inclusion_status,execution_status,block_number,function_name)
     VALUES ($1,$2,$3,$4,'palletdock','deploy',$5,$6,'submitted','included','success',$7,'constructor')`,
    [g.projectId, fp, artifactId, c.rows[0].id, deployHash, FROM, deployBlock],
  );
  return { contractId: c.rows[0].id as string, address, abiVersionId: av.rows[0].id as string, fingerprintId: fp as string };
}

describe('guided Storage checklist', () => {
  it('derives every step from observed records and survives a refresh', async () => {
    const g = await startGuest();
    const guide = async () => (await call(g, 'GET', `/workspace/projects/${g.projectId}/playground`)).json().data;
    const states = async () => Object.fromEntries((await guide()).steps.map((s: { id: string; state: string }) => [s.id, s.state]));
    expect(await states()).toEqual({ template: 'done', deploy: 'todo', read: 'todo', write: 'todo', event: 'todo', api: 'todo' });

    // Preparing a deployment is not a deployment.
    const sample = await call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts/samples/storage`);
    await call(g, 'POST', `/workspace/projects/${g.projectId}/artifacts/${sample.json().data.id}/prepare-deploy`, { args: [], from: FROM });
    expect((await states()).deploy).toBe('todo');

    const { contractId, address, abiVersionId, fingerprintId } = await trackedStorage(g, 80);
    expect(await states()).toMatchObject({ deploy: 'done', read: 'todo' });

    const read = await call(g, 'POST', `/workspace/projects/${g.projectId}/contracts/${contractId}/read`, { function: 'retrieve()', args: [] });
    expect(read.json().data.ok).toBe(true);
    expect(await states()).toMatchObject({ read: 'done', write: 'todo' });

    // Preparing the write and an unconfirmed submission do not complete it.
    const prepared = await call(g, 'POST', `/workspace/projects/${g.projectId}/contracts/${contractId}/prepare-write`, { function: 'store(uint256)', args: ['42'], from: FROM });
    const txId = prepared.json().data.transactionId;
    expect((await states()).write).toBe('todo');
    const hash = `0x${'42'.repeat(32)}`;
    await call(g, 'POST', `/workspace/projects/${g.projectId}/transactions/${txId}/submission`, { outcome: 'submitted', hash });
    expect((await states()).write).toBe('in_progress');

    // Source from the deployment block, created explicitly.
    const source = await call(g, 'POST', `/workspace/projects/${g.projectId}/playground/indexer-source`, { contractId });
    expect(source.statusCode).toBe(201);
    expect(source.json().data).toMatchObject({ existing: false, startBlock: '80', uncovered: null });
    const sourceId = source.json().data.id;

    // The worker records the receipt; the event is not yet indexed.
    await db.pool.query(`UPDATE transactions SET inclusion_status='included', execution_status='success', block_number=85 WHERE id=$1`, [txId]);
    expect(await states()).toMatchObject({ write: 'done', event: 'in_progress', api: 'todo' });

    // The worker indexes NumberChanged.
    const log = await db.pool.query(
      `INSERT INTO raw_logs(source_id,project_id,fingerprint_id,contract_address,block_number,block_hash,transaction_hash,transaction_index,log_index,topics,data)
       VALUES ($1,$2,$3,$4,85,$5,$6,0,0,$7,'0x') RETURNING id`,
      [sourceId, g.projectId, fingerprintId, address, `0x${'85'.repeat(32)}`, hash, ['0x01']],
    );
    await db.pool.query(`INSERT INTO decoded_events(raw_log_id,abi_version_id,status,event_name,args) VALUES ($1,$2,'decoded','NumberChanged',$3)`, [
      log.rows[0].id,
      abiVersionId,
      JSON.stringify({ caller: FROM, previousValue: '0', newValue: '42' }),
    ]);
    const data = await guide();
    expect(data.event.args).toEqual({ caller: FROM, previousValue: '0', newValue: '42' });
    expect(data.steps.find((s: { id: string }) => s.id === 'event').state).toBe('done');
    expect(data.finality).toBe('unknown');

    // Creating a key alone does not complete the API step; a successful /v1 events read does.
    const key = await call(g, 'POST', `/workspace/projects/${g.projectId}/keys`, { name: 'guide', scopes: ['events:read'], expiresInDays: 7 });
    expect((await states()).api).toBe('todo');
    const v1 = await app.inject({ method: 'GET', url: `/v1/projects/${g.projectId}/events?event=NumberChanged`, headers: { authorization: `Bearer ${key.json().secret}` } });
    expect(v1.statusCode).toBe(200);
    expect(v1.json().data[0].event.args).toMatchObject({ newValue: '42' });
    await new Promise((r) => setTimeout(r, 200)); // onResponse request log
    expect(await states()).toEqual({ template: 'done', deploy: 'done', read: 'done', write: 'done', event: 'done', api: 'done' });

    // Refresh (a new request) returns the same journey.
    expect(await states()).toEqual({ template: 'done', deploy: 'done', read: 'done', write: 'done', event: 'done', api: 'done' });
  });

  it('explains unavailable history and accepts a later start block only as an explicit choice', async () => {
    const g = await startGuest();
    const { contractId } = await trackedStorage(g, 20); // the fake node discards blocks below 50
    const r = await call(g, 'POST', `/workspace/projects/${g.projectId}/playground/indexer-source`, { contractId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('HISTORY_UNAVAILABLE');
    expect(r.json().recovery).toMatchObject({ deployBlock: '20', head: '100', suggestedStartBlock: '100' });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM indexer_sources WHERE project_id=$1`, [g.projectId])).rows[0].n).toBe(0);

    const chosen = await call(g, 'POST', `/workspace/projects/${g.projectId}/playground/indexer-source`, { contractId, startBlock: '100' });
    expect(chosen.statusCode).toBe(201);
    expect(chosen.json().data.uncovered).toEqual({ fromBlock: '20', toBlock: '99' });
    const warn = await db.pool.query(`SELECT message FROM ops_logs WHERE project_id=$1 AND level='WARN'`, [g.projectId]);
    expect(warn.rows[0].message).toMatch(/blocks 20–99 are not covered/);
  });

  it('resolves template placeholders on the server (payments sample order reference)', async () => {
    const g = await startGuest(visitor(), { template: 'payments' });
    const data = (await call(g, 'GET', `/workspace/projects/${g.projectId}/playground`)).json().data;
    expect(data.template.write.args).toEqual([sampleOrderRef(g.projectId)]);
    expect(Buffer.from(data.template.write.args[0].slice(2), 'hex').toString('ascii')).toMatch(/^pd-sample-order-[0-9a-f]{8}\0+$/);
    expect(data.template.write.explicitValue).toBe(true);
  });
});

describe('shared template contracts (no deployment)', () => {
  const base = (projectId: string) => `/workspace/projects/${projectId}/playground`;
  beforeAll(() => {
    process.env.PALLETDOCK_PLAYGROUND_SHARED_STORAGE = `${SHARED_STORAGE}:60:0x${'ab'.repeat(32)}`;
    process.env.PALLETDOCK_PLAYGROUND_SHARED_ERC20 = `${SHARED_TOKEN}:60`;
    process.env.PALLETDOCK_PLAYGROUND_SHARED_ERC721 = `${NOT_THE_ARTIFACT}:60`;
  });
  afterAll(() => {
    delete process.env.PALLETDOCK_PLAYGROUND_SHARED_STORAGE;
    delete process.env.PALLETDOCK_PLAYGROUND_SHARED_ERC20;
    delete process.env.PALLETDOCK_PLAYGROUND_SHARED_ERC721;
  });

  it('publishes which templates have a shared copy', async () => {
    const cfg = (await app.inject({ method: 'GET', url: '/auth/playground-config' })).json();
    const byId = Object.fromEntries(cfg.templates.map((t: { id: string; sharedContract: unknown }) => [t.id, t.sharedContract]));
    expect(byId.storage).toEqual({ address: SHARED_STORAGE, deployBlock: '60', deployTxHash: `0x${'ab'.repeat(32)}` });
    expect(byId.payments).toBeNull();
  });

  it('adds the shared copy only after its code matches the artifact, idempotently and outside the contract quota', async () => {
    const g = await startGuest();
    const first = await call(g, 'POST', `${base(g.projectId)}/shared-contract`);
    expect(first.statusCode, first.body).toBe(201);
    const again = await call(g, 'POST', `${base(g.projectId)}/shared-contract`);
    expect(again.statusCode).toBe(200);
    expect(again.json().data).toEqual({ id: first.json().data.id, existing: true });

    const guide = (await call(g, 'GET', base(g.projectId))).json().data;
    expect(guide.contract).toMatchObject({ address: SHARED_STORAGE, shared: true, attached_block: '100', deploy_block: '60' });
    const step = guide.steps.find((s: { id: string }) => s.id === 'deploy');
    expect(step).toMatchObject({ title: 'Use the contract', state: 'done' });
    expect(step.detail).toContain('matched the bundled artifact at block 100');
    // Not counted: the visitor can still deploy or import their own two contracts.
    expect((await call(g, 'GET', '/auth/me')).json().playground.used.contracts).toBe(0);

    // Indexing starts where this workspace added the contract, and says what it does not cover.
    const src = await call(g, 'POST', `${base(g.projectId)}/indexer-source`, { contractId: first.json().data.id });
    expect(src.statusCode, src.body).toBe(201);
    expect(src.json().data).toMatchObject({ startBlock: '100', shared: true, uncovered: { fromBlock: '60', toBlock: '99' } });
    const log = await db.pool.query(`SELECT level, message FROM ops_logs WHERE project_id=$1 AND source='indexer'`, [g.projectId]);
    expect(log.rows).toContainEqual({ level: 'INFO', message: expect.stringContaining('Blocks 60–99') });
  });

  it('refuses a configured address whose code is not the artifact', async () => {
    const g = await startGuest(visitor(), { template: 'erc721' });
    const r = await call(g, 'POST', `${base(g.projectId)}/shared-contract`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("does not have the bundled artifact's runtime code");
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM contracts WHERE project_id=$1`, [g.projectId])).rows[0].n).toBe(0);
    // Without a shared copy configured the action is unavailable.
    await call(g, 'POST', `${base(g.projectId)}/template`, { template: 'payments' });
    expect((await call(g, 'POST', `${base(g.projectId)}/shared-contract`)).statusCode).toBe(404);
  });

  it('switching template adds the shared copy; on the shared ERC-20 the guided write is approve', async () => {
    const g = await startGuest();
    const sw = await call(g, 'POST', `${base(g.projectId)}/template`, { template: 'erc20' });
    expect(sw.json().data.shared).toEqual({ contractId: expect.any(String) });
    const tpl = (await call(g, 'GET', base(g.projectId))).json().data.template;
    expect(tpl.write.function).toBe('approve(address,uint256)');
    expect(tpl.event.name).toBe('Approval');
  });

  it('matches runtime code exactly or with filled-in immutables only', () => {
    const artifact = '0x6080' + '00'.repeat(32) + 'fe';
    const filled = '0x6080' + '00'.repeat(12) + '7a3f09c2d4e81b6a5f3c90e7d12b48a6e0f9c315' + 'fe';
    expect(codeMatchesArtifact(artifact, artifact)).toEqual({ match: true, immutablesFilled: false });
    expect(codeMatchesArtifact(filled, artifact)).toEqual({ match: true, immutablesFilled: true });
    expect(codeMatchesArtifact('0x6081' + '00'.repeat(32) + 'fe', artifact).match).toBe(false);
    expect(codeMatchesArtifact(artifact + '00', artifact).match).toBe(false);
    expect(codeMatchesArtifact('0x', artifact).match).toBe(false);
  });

  it('rejects a malformed shared contract setting', () => {
    expect(() => resolveGuestConfig({ PALLETDOCK_PLAYGROUND_SHARED_STORAGE: '0x1234' })).toThrow(/PALLETDOCK_PLAYGROUND_SHARED_STORAGE/);
    expect(resolveGuestConfig({ PALLETDOCK_PLAYGROUND_SHARED_STORAGE: `${SHARED_STORAGE.toUpperCase().replace('0X', '0x')}:7` }).shared.storage).toEqual({ address: SHARED_STORAGE, deployBlock: '7', deployTxHash: null });
  });
});

describe('expiry', () => {
  it('rejects expired sessions and read keys at authorization, before maintenance', async () => {
    const g = await startGuest();
    const key = await call(g, 'POST', `/workspace/projects/${g.projectId}/keys`, { name: 'k', scopes: ['events:read'], expiresInDays: 7 });
    const secret = key.json().secret;
    const ownerId = (await db.pool.query(`SELECT owner_id FROM projects WHERE id=$1`, [g.projectId])).rows[0].owner_id;
    await expireGuest(db.pool, ownerId);
    const me = await call(g, 'GET', '/auth/me');
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe('WORKSPACE_EXPIRED');
    expect((await call(g, 'GET', `/workspace/projects/${g.projectId}/overview`)).json().error.code).toBe('WORKSPACE_EXPIRED');
    const v1 = await app.inject({ method: 'GET', url: `/v1/projects/${g.projectId}/events`, headers: { authorization: `Bearer ${secret}` } });
    expect(v1.statusCode).toBe(401);
    // The key row itself is still unrevoked: rejection came from authorization, not cleanup.
    expect((await db.pool.query(`SELECT revoked_at FROM api_keys WHERE project_id=$1`, [g.projectId])).rows[0].revoked_at).toBeNull();
    // An expired guest cannot be saved either.
    const save = await call(g, 'POST', '/auth/signup', { email: 'late@example.test', password: 'a secure demo password', inviteCode: 'test-registration-code-1234', claimGuest: true });
    expect(save.statusCode).toBe(401);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM owners WHERE email='late@example.test'`)).rows[0].n).toBe(0);
  });
});

describe('saving the workspace', () => {
  const password = 'a secure demo password';

  it('keeps the guest intact on invalid invite, duplicate email, or missing CSRF', async () => {
    const g = await startGuest();
    const badInvite = await call(g, 'POST', '/auth/signup', { email: 'keep@example.test', password, inviteCode: 'wrong-code-wrong-code', claimGuest: true });
    expect(badInvite.statusCode).toBe(401);
    const duplicate = await call(g, 'POST', '/auth/signup', { email: 'OWNER@example.test', password, inviteCode: 'test-registration-code-1234', claimGuest: true });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.message).toMatch(/not supported yet; your temporary workspace is unchanged/);
    expect(duplicate.headers['set-cookie']).toBeUndefined();
    const noCsrf = await call({ cookie: g.cookie }, 'POST', '/auth/signup', { email: 'keep@example.test', password, inviteCode: 'test-registration-code-1234', claimGuest: true });
    expect(noCsrf.statusCode).toBe(403);
    const me = await call(g, 'GET', '/auth/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().session.kind).toBe('guest');
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM owners WHERE lower(email)='owner@example.test'`)).rows[0].n).toBe(1);
  });

  it('promotes only this guest, keeps its resources, and rotates session and CSRF', async () => {
    const g = await startGuest();
    const { contractId } = await trackedStorage(g, 90);
    await call(g, 'POST', `/workspace/projects/${g.projectId}/contracts/${contractId}/read`, { function: 'retrieve()', args: [] });
    const key = await call(g, 'POST', `/workspace/projects/${g.projectId}/keys`, { name: 'k', scopes: ['events:read'], expiresInDays: 7 });
    const keyExpiry = key.json().data.expires_at;
    const ownerId = (await db.pool.query(`SELECT owner_id FROM projects WHERE id=$1`, [g.projectId])).rows[0].owner_id;

    const saved = await call(g, 'POST', '/auth/signup', { email: 'Saved@Example.Test', password, inviteCode: 'test-registration-code-1234', claimGuest: true });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json()).toMatchObject({ promoted: true, projectId: g.projectId, owner: { id: ownerId, email: 'saved@example.test', kind: 'account' }, session: { kind: 'account' } });
    const newCookie = String(saved.headers['set-cookie']).split(';')[0];
    expect(newCookie).not.toBe(g.cookie);
    expect(saved.json().csrfToken).not.toBe(g.csrf);

    // The old guest session no longer works; the new one is an account session on the same owner.
    expect((await call(g, 'GET', '/auth/me')).statusCode).toBe(401);
    const s = { cookie: newCookie, csrf: saved.json().csrfToken };
    const me = await call(s, 'GET', '/auth/me');
    expect(me.json()).toMatchObject({ owner: { id: ownerId, kind: 'account' }, session: { kind: 'account', expiresAt: null }, playground: null });
    const owner = (await db.pool.query(`SELECT kind,guest_expires_at,promoted_at,password_hash FROM owners WHERE id=$1`, [ownerId])).rows[0];
    expect(owner).toMatchObject({ kind: 'account', guest_expires_at: null });
    expect(owner.promoted_at).not.toBeNull();
    expect(owner.password_hash).toMatch(/^scrypt\$/);

    // Project, contract, guided progress and key (with its original expiry) are preserved.
    const guide = (await call(s, 'GET', `/workspace/projects/${g.projectId}/playground`)).json().data;
    expect(guide.steps.slice(0, 3).map((x: { state: string }) => x.state)).toEqual(['done', 'done', 'done']);
    const keys = (await call(s, 'GET', `/workspace/projects/${g.projectId}/keys`)).json().data;
    expect(new Date(keys[0].expires_at).toISOString()).toBe(new Date(keyExpiry).toISOString());
    // Account rules apply now: more projects are allowed.
    expect((await call(s, 'POST', '/workspace/projects', { name: 'Second project' })).statusCode).toBe(201);
    // And normal password login works for the saved account.
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'saved@example.test', password } });
    expect(login.statusCode).toBe(200);
  });

  it('is unavailable when registration is disabled', async () => {
    process.env.PALLETDOCK_SIGNUP_MODE = 'disabled';
    const closed = await buildServer(db.pool, { evm: new EvmAdapter(PORTALDOT_V3_TESTNET, new FakeRpc()), substrate: null, devControls: false });
    try {
      const g = await startGuest();
      const r = await closed.inject({ method: 'POST', url: '/auth/signup', headers: { cookie: g.cookie, 'x-csrf-token': g.csrf }, payload: { email: 'off@example.test', password, claimGuest: true } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('REGISTRATION_DISABLED');
      expect((await call(g, 'GET', '/auth/me')).json().session.kind).toBe('guest');
    } finally {
      await closed.close();
      process.env.PALLETDOCK_SIGNUP_MODE = 'invite';
    }
  });
});

describe('credentials stay out of responses and logs', () => {
  it('never echoes the session token or stores it in request logs', async () => {
    const g = await startGuest();
    await call(g, 'GET', `/workspace/projects/${g.projectId}/nope`);
    await call({ cookie: g.cookie }, 'POST', `/workspace/projects/${g.projectId}/playground/template`, { template: 'erc20' });
    const logs = await db.pool.query(`SELECT * FROM request_logs`);
    expect(JSON.stringify(logs.rows)).not.toContain(g.token);
    expect(JSON.stringify(logs.rows)).not.toContain(g.csrf);
    const overview = await call(g, 'GET', `/workspace/projects/${g.projectId}/overview`);
    expect(overview.body).not.toContain(g.token);
  });
});
