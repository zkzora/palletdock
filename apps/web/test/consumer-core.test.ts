import { describe, expect, it } from 'vitest';
import {
  ConsumerApiError,
  EMPTY_STATE,
  deriveView,
  eventIdentity,
  readSnapshot,
  reconcile,
  trackingTag,
  type ApiEvent,
  type ApiIndexerSource,
  type ApiMeta,
  type FetchLike,
  type Snapshot,
} from '../lib/consumer/core';

const KEY = 'pd_live_abc123.secretsecretsecret';
const NOW = Date.parse('2026-10-22T10:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const CONTRACT = '0xdd982913cb04f9e438437e2137ba1452e4b211ed';

/** Coverage as the events snapshot reported it (what the read can vouch for). */
function cov(toBlock: number, reorgEpoch = '0', from = 100) {
  return {
    sourceId: 's1',
    contractAddress: CONTRACT,
    requested: { fromBlock: String(from), toBlock: null },
    completed: { fromBlock: String(from), toBlock: String(toBlock), blockHash: H(toBlock), committedAt: iso(5_000) },
    status: 'following',
    latestObservedBlock: String(toBlock),
    latestObservedAt: iso(5_000),
    lagBlocks: '0',
    reorgEpoch,
  };
}

function meta(over: Partial<ApiMeta> = {}, fp = 'fp-a', genesis = H(1)): ApiMeta {
  return {
    networkId: 'portaldot-v3-testnet',
    networkFingerprint: { id: fp, genesisHash: genesis, evmChainId: '420420777', lastVerifiedAt: iso(60_000) },
    observedAt: iso(0),
    checkpoint: { sourceId: 's1', blockNumber: '200', blockHash: H(200), committedAt: iso(5_000) },
    coverage: [cov(200)],
    finality: 'unknown',
    ...over,
  };
}

function ev(block: number, value: number, over: Partial<ApiEvent> = {}): ApiEvent {
  return {
    id: `e${block}`,
    networkId: 'portaldot-v3-testnet',
    contractAddress: CONTRACT,
    blockNumber: String(block),
    blockHash: H(block),
    transactionHash: H(10_000 + block),
    transactionIndex: 0,
    logIndex: 3,
    decodeStatus: 'decoded',
    event: { name: 'NumberChanged', signature: 'NumberChanged(address,uint256,uint256)', args: { caller: '0xfa02', previousValue: String(value - 1), newValue: String(value) } },
    indexedAt: iso(10_000),
    sourceId: 's1',
    finality: 'unknown',
    ...over,
  };
}

function source(over: Partial<ApiIndexerSource> = {}): ApiIndexerSource {
  return {
    id: 's1',
    contractAddress: CONTRACT,
    events: ['NumberChanged'],
    requestedRange: { fromBlock: '100', toBlock: null },
    completedRange: { fromBlock: '100', toBlock: '200' },
    checkpoint: { blockNumber: '200', blockHash: H(200), committedAt: iso(5_000) },
    latestObservedBlock: '200',
    latestObservedAt: iso(5_000),
    lagBlocks: '0',
    desiredState: 'running',
    status: 'following',
    reorgEpoch: '0',
    lastError: null,
    lastErrorAt: null,
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    fetchedAt: iso(1_000),
    meta: meta(),
    events: [ev(150, 42), ev(180, 43)],
    sources: [source()],
    sourcesError: null,
    transactions: null,
    latestTransaction: { hash: H(10_180), status: { submission: 'submitted', inclusion: 'included', execution: 'success', finality: 'unknown', indexing: 'indexed' }, blockNumber: '180', blockHash: H(180), trackingStatus: 'settled' },
    restarts: 0,
    generationRestarts: 0,
    pages: 1,
    duplicatesDropped: 0,
    ...over,
  };
}

const ok = (s: Snapshot) => ({ ok: true as const, snapshot: s });

/** Fake /v1 server: responses per path; records requests. */
function fakeApi(routes: Record<string, Array<{ status: number; body: unknown }> | ((url: URL) => { status: number; body: unknown })>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    const u = new URL(url);
    const key = u.pathname.split('/').pop()!;
    const r = routes[key];
    if (!r) throw new Error(`no route ${key}`);
    const res = typeof r === 'function' ? r(u) : r.shift()!;
    return { status: res.status, json: async () => res.body };
  };
  return { fetch, calls };
}
const page = (data: ApiEvent[], nextCursor: string | null, m: ApiMeta = meta()) => ({ status: 200, body: { requestId: 'req_x', data, nextCursor, meta: m } });
const restart = { status: 409, body: { error: { code: 'CURSOR_RESTART_REQUIRED', message: 'Indexed data was rolled back or reindexed since this cursor was issued.', requestId: 'req_y' } } };
const indexer = (sources: ApiIndexerSource[] = [source()]) => ({ status: 200, body: { requestId: 'req_i', data: sources, nextCursor: null, meta: meta() } });
const txs = { status: 200, body: { requestId: 'req_t', data: [], nextCursor: null, meta: meta() } };
const opts = (fetch: FetchLike) => ({ apiUrl: 'http://api.test', projectId: '3570d90a-c165-4041-aee3-c93f174f1d0a', readKey: KEY, event: 'NumberChanged', fetch, pageLimit: 2 });

describe('positive control', () => {
  it('a healthy, fresh, covered snapshot reads as up to date with the latest value and its identity', () => {
    const view = deriveView(reconcile(EMPTY_STATE, ok(snapshot())), NOW);
    expect(view.level).toBe('fresh');
    expect(view.reasons).toEqual([]);
    expect(view.latest).toMatchObject({ value: '43', previousValue: '42' });
    expect(view.latest?.event).toMatchObject({ blockNumber: '180', blockHash: H(180), transactionHash: H(10_180), logIndex: 3 });
    expect(view.network).toMatchObject({ networkId: 'portaldot-v3-testnet', evmChainId: '420420777', fingerprintId: 'fp-a' });
    expect(view.coverage).toMatchObject({ fromBlock: '100', toBlock: '200' });
    expect(view.transactionCondition).toMatch(/settled/i);
  });
});

describe('readSnapshot against the /v1 contract', () => {
  it('pages with the cursor, sends the key only as a bearer header, and shows a repeated identity once', async () => {
    const { fetch, calls } = fakeApi({ events: [page([ev(150, 42), ev(160, 43)], 'c1'), page([ev(160, 43), ev(180, 44)], null)], indexer: [indexer()], transactions: () => txs });
    const s = await readSnapshot(opts(fetch));
    expect(s.events.map((e) => e.blockNumber)).toEqual(['150', '160', '180']);
    expect(s.duplicatesDropped).toBe(1);
    expect(s.pages).toBe(2);
    expect(calls[1].url).toContain('cursor=c1');
    expect(calls.every((c) => c.auth === `Bearer ${KEY}` && !c.url.includes(KEY))).toBe(true);
    expect(JSON.stringify(s)).not.toContain('secretsecret');
  });

  it('on CURSOR_RESTART_REQUIRED discards the partial snapshot and re-reads from the first page', async () => {
    // First pass: page 1 has a block that a rollback later removes; page 2 is refused.
    const { fetch, calls } = fakeApi({ events: [page([ev(150, 42), ev(170, 99)], 'c1'), restart, page([ev(150, 42), ev(171, 43)], null, meta({ coverage: [cov(200, '1')] }))], indexer: [indexer([source({ reorgEpoch: '1' })])], transactions: () => txs });
    const s = await readSnapshot(opts(fetch));
    expect(s.restarts).toBe(1);
    expect(s.events.map((e) => e.blockNumber)).toEqual(['150', '171']); // nothing from the invalidated pass survives
    expect(calls[2].url).not.toContain('cursor=');
    const state = reconcile(reconcile(EMPTY_STATE, ok(snapshot({ sources: [source({ reorgEpoch: '0' })] }))), ok(s));
    expect(state.notes.map((n) => n.text).join(' ')).toMatch(/CURSOR_RESTART_REQUIRED.*re-read from the first page/);
    expect(state.notes.map((n) => n.text).join(' ')).toMatch(/rolled back or reindexed/);
  });

  it('gives up after repeated restarts instead of looping', async () => {
    const { fetch } = fakeApi({ events: () => restart, indexer: [indexer()], transactions: () => txs });
    // First page itself refused every time.
    await expect(readSnapshot(opts(fetch))).rejects.toMatchObject({ code: 'CURSOR_RESTART_LIMIT' });
  });

  it('reports an unreachable API as API_UNAVAILABLE and API errors with their code', async () => {
    const down: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4101');
    };
    await expect(readSnapshot(opts(down))).rejects.toMatchObject({ code: 'API_UNAVAILABLE' });
    const { fetch } = fakeApi({ events: [{ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid key', requestId: 'r' } } }] });
    await expect(readSnapshot(opts(fetch))).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('keeps going without indexer status when that scope is missing, and marks coverage unknown', async () => {
    const forbidden = { status: 403, body: { error: { code: 'FORBIDDEN_SCOPE', message: 'Key lacks indexer:read', requestId: 'r' } } };
    const { fetch } = fakeApi({ events: [page([ev(150, 42)], null)], indexer: [forbidden], transactions: () => txs });
    const s = await readSnapshot(opts(fetch));
    expect(s.sources).toBeNull();
    const view = deriveView(reconcile(EMPTY_STATE, ok(s)), NOW);
    expect(view.level).toBe('unknown');
    expect(view.reasons.join(' ')).toMatch(/Indexer status could not be read.*FORBIDDEN_SCOPE/);
  });
});

describe('snapshot coverage vs a newer indexer status (race between /events and /indexer)', () => {
  const NONE: ApiEvent[] = [];
  it('absence is claimed only for the range the events snapshot covered; a newer checkpoint is liveness, not coverage', async () => {
    // /events: no event, coverage up to 100. Then the worker indexes an event at 101. Then /indexer: checkpoint 101.
    const first = fakeApi({
      events: [page(NONE, null, meta({ coverage: [cov(100)] }))],
      indexer: [indexer([source({ checkpoint: { blockNumber: '101', blockHash: H(101), committedAt: iso(1_000) }, latestObservedBlock: '101', latestObservedAt: iso(1_000) })])],
      transactions: () => txs,
    });
    let state = reconcile(EMPTY_STATE, ok(await readSnapshot(opts(first.fetch))));
    let view = deriveView(state, NOW);
    expect(view.coverage?.toBlock).toBe('100');
    expect(view.emptyMessage).toMatch(/No matching event in blocks 100–100\b/);
    expect(view.emptyMessage).not.toMatch(/101/);
    // One block of difference is normal while the worker follows the head: noted, not a freshness problem.
    expect(view.level).toBe('fresh');
    expect(view.reasons.join(' ')).toMatch(/advanced to block 101 since this snapshot.*covers up to 100/);
    // Beyond the lag threshold the same situation is shown as behind.
    const far = deriveView({ ...state, sources: [source({ checkpoint: { blockNumber: '111', blockHash: H(111), committedAt: iso(1_000) }, latestObservedBlock: '111', latestObservedAt: iso(1_000) })] }, NOW);
    expect(far.level).toBe('lagging');
    expect(far.emptyMessage).toContain('No matching event in blocks 100–100 (indexed)');

    // Next read: the snapshot now covers 101 and contains the event; it appears once.
    const second = fakeApi({
      events: [page([ev(101, 43)], null, meta({ coverage: [cov(101)] }))],
      indexer: [indexer([source({ checkpoint: { blockNumber: '101', blockHash: H(101), committedAt: iso(1_000) }, latestObservedBlock: '101', latestObservedAt: iso(1_000) })])],
      transactions: () => txs,
    });
    state = reconcile(state, ok(await readSnapshot(opts(second.fetch))));
    view = deriveView(state, NOW);
    expect(view.level).toBe('fresh');
    expect(view.latest?.value).toBe('43');
    expect(state.events).toHaveLength(1);
    expect(state.notes[0].text).toMatch(/1 new and 0 removed/);
    state = reconcile(state, ok(await readSnapshot(opts(fakeApi({ events: [page([ev(101, 43)], null, meta({ coverage: [cov(101)] }))], indexer: [indexer([source({ checkpoint: { blockNumber: '101', blockHash: H(101), committedAt: iso(1_000) } })])], transactions: () => txs }).fetch))));
    expect(state.events).toHaveLength(1);
  });

  it('a rollback between the events read and the indexer read restarts the whole read', async () => {
    // Pass 1: events from epoch 0, but /indexer already reports epoch 1. Pass 2: both epoch 1.
    const { fetch, calls } = fakeApi({
      events: [page([ev(150, 42), ev(170, 99)], null, meta({ coverage: [cov(200, '0')] })), page([ev(150, 42)], null, meta({ coverage: [cov(160, '1')] }))],
      indexer: [indexer([source({ reorgEpoch: '1' })]), indexer([source({ reorgEpoch: '1' })])],
      transactions: () => txs,
    });
    const s = await readSnapshot(opts(fetch));
    expect(s.generationRestarts).toBe(1);
    expect(s.events.map((e) => e.blockNumber)).toEqual(['150']); // nothing from the older generation survives
    expect(calls.filter((c) => c.url.includes('/events')).length).toBe(2);
    expect(reconcile(EMPTY_STATE, ok(s)).notes[0].text).toMatch(/generation changed between requests/);
  });

  it('a network fingerprint change between requests is not one snapshot; persistent changes are refused', async () => {
    const flip = fakeApi({
      events: () => page([ev(150, 42)], null, meta({}, 'fp-a')),
      indexer: () => ({ status: 200, body: { requestId: 'r', data: [source()], nextCursor: null, meta: meta({}, 'fp-b', H(2)) } }),
      transactions: () => txs,
    });
    await expect(readSnapshot(opts(flip.fetch))).rejects.toMatchObject({ code: 'GENERATION_CHANGED' });
  });
});

describe('reconciliation', () => {
  it('replaces the view with each snapshot and never appends duplicates', () => {
    let state = reconcile(EMPTY_STATE, ok(snapshot()));
    state = reconcile(state, ok(snapshot()));
    state = reconcile(state, ok(snapshot()));
    expect(state.events).toHaveLength(2);
    // A rollback removes an event; the view follows.
    state = reconcile(state, ok(snapshot({ events: [ev(150, 42)] })));
    expect(state.events.map((e) => e.blockNumber)).toEqual(['150']);
    expect(state.notes[0].text).toMatch(/0 new and 1 removed/);
  });

  it('keeps the last value when the API is unavailable, labelled with when it was read', () => {
    const good = reconcile(EMPTY_STATE, ok(snapshot()));
    const down = reconcile(good, { ok: false, error: { code: 'API_UNAVAILABLE', message: 'connect ECONNREFUSED' }, at: iso(0) });
    const view = deriveView(down, NOW);
    expect(view.level).toBe('unavailable');
    expect(view.latest?.value).toBe('43');
    expect(view.reasons[0]).toMatch(new RegExp(`API unavailable since .*Showing data last read at ${good.lastGoodAt}`));
    // Recovery: the next good read clears the error and notes it.
    const back = reconcile(down, ok(snapshot({ fetchedAt: new Date(NOW).toISOString() })));
    expect(deriveView(back, NOW).level).toBe('fresh');
    expect(back.notes[0].text).toMatch(/API reachable again/);
  });

  it('treats a different network as different events and discards the old ones', () => {
    const a = reconcile(EMPTY_STATE, ok(snapshot()));
    const sameTxOtherNetwork = snapshot({ meta: meta({}, 'fp-b', H(2)) });
    expect(eventIdentity(a.meta, a.events[1])).not.toBe(eventIdentity(sameTxOtherNetwork.meta, sameTxOtherNetwork.events[1]));
    const b = reconcile(a, ok(sameTxOtherNetwork));
    expect(b.notes[0].text).toMatch(/Network identity changed \(fp-a → fp-b\)/);
    expect(b.events).toHaveLength(2);
    expect(deriveView(b, NOW).network?.fingerprintId).toBe('fp-b');
  });
});

describe('freshness and coverage are never assumed', () => {
  it('missing metadata or fingerprint is not healthy', () => {
    expect(deriveView(reconcile(EMPTY_STATE, ok(snapshot({ meta: null }))), NOW).level).toBe('unknown');
    const noFp = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ meta: { ...meta(), networkFingerprint: null } }))), NOW);
    expect(noFp.level).toBe('unknown');
    expect(noFp.reasons.join(' ')).toMatch(/fingerprint/);
  });

  it('an empty result is not evidence of absence', () => {
    const covered = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ events: [], latestTransaction: null }))), NOW);
    expect(covered.emptyMessage).toMatch(/No matching event in blocks 100–200.*Outside that range nothing is known/);
    // Coverage comes from the events snapshot's own meta, not from /indexer.
    const uncovered = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ meta: meta({ coverage: [] }), events: [], latestTransaction: null }))), NOW);
    expect(uncovered.level).toBe('unknown');
    expect(uncovered.emptyMessage).toMatch(/does not show that no event happened/);
  });

  it('a stopped worker shows as stale even though the last reported lag is 0', () => {
    const view = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ sources: [source({ checkpoint: { blockNumber: '200', blockHash: H(200), committedAt: iso(10 * 60_000) }, latestObservedAt: iso(10 * 60_000), lagBlocks: '0' })] }))), NOW);
    expect(view.level).toBe('stale');
    expect(view.reasons.join(' ')).toMatch(/has not observed the chain for 10 min.*reported lag \(0 blocks\) dates from that last observation/);
  });

  it('positive control: a quiet chain with an old checkpoint but a recent observation is still fresh', () => {
    const quiet = cov(200);
    quiet.completed.committedAt = iso(30 * 60_000);
    const view = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ meta: meta({ coverage: [quiet] }), sources: [source({ checkpoint: { blockNumber: '200', blockHash: H(200), committedAt: iso(30 * 60_000) }, latestObservedAt: iso(4_000), lagBlocks: '0' })] }))), NOW);
    expect(view.level).toBe('fresh');
    expect(view.coverage?.ageMs).toBe(30 * 60_000);
  });

  it('shows paused, error and lag from the indexer metadata', () => {
    const paused = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ sources: [source({ desiredState: 'paused', status: 'paused' })] }))), NOW);
    expect(paused.level).toBe('lagging');
    expect(paused.reasons.join(' ')).toMatch(/paused at block 200/);
    const error = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ sources: [source({ status: 'error', lastError: 'RPC request failed: HTTP 502', lastErrorAt: iso(3_000) })] }))), NOW);
    expect(error.level).toBe('error');
    expect(error.reasons.join(' ')).toMatch(/HTTP 502/);
    const behind = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ sources: [source({ lagBlocks: '57' })] }))), NOW);
    expect(behind.level).toBe('lagging');
  });
});

describe('finality and receipt-tracking conditions', () => {
  it('never reports finalized from a receipt, confirmations, or a settled tracker', () => {
    const view = deriveView(reconcile(EMPTY_STATE, ok(snapshot())), NOW);
    expect(view.finality).toMatch(/^Unknown: not confirmed/);
    expect(view.finality).not.toMatch(/finalized/i);
    const noMeta = deriveView(reconcile(EMPTY_STATE, ok(snapshot({ meta: { ...meta(), finality: '' }, events: [ev(150, 1, { finality: '' })] }))), NOW);
    expect(noMeta.finality).toMatch(/^Unknown/);
  });

  it('distinguishes pruned node history from a reorganization and from stopped checks', () => {
    const cond = (trackingStatus: string, inclusion = 'included') =>
      deriveView(reconcile(EMPTY_STATE, ok(snapshot({ latestTransaction: { hash: H(1), status: { submission: 'submitted', inclusion, execution: 'success', finality: 'unknown', indexing: 'indexed' }, blockNumber: '1', blockHash: H(1), trackingStatus } }))), NOW).transactionCondition;
    expect(cond('history_pruned')).toMatch(/Node history pruned.*Not a reorganization or a failure/);
    expect(cond('active', 'reorged_out')).toMatch(/^Reorganized out/);
    expect(cond('gave_up')).toMatch(/stopped after repeated failures/);
  });

  it('tags each event with its own transaction condition', () => {
    const tx = (trackingStatus: string, inclusion = 'included') => ({ hash: H(1), status: { submission: 'submitted', inclusion, execution: 'success', finality: 'unknown', indexing: 'indexed' }, blockNumber: '1', blockHash: H(1), trackingStatus });
    expect(trackingTag(tx('history_pruned'))).toMatch(/node history pruned/);
    expect(trackingTag(tx('settled'))).toMatch(/settled; finality unknown/);
    expect(trackingTag(tx('active', 'reorged_out'))).toBe('reorganized out');
    expect(trackingTag(undefined)).toBeNull();
  });

  it('a failed read keeps the error code distinct from indexer errors', () => {
    expect(new ConsumerApiError('x', 'API_UNAVAILABLE', null).code).toBe('API_UNAVAILABLE');
  });
});
