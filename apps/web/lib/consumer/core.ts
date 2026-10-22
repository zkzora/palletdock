/**
 * PalletDock read-API consumer core. Framework-free and self-contained so the
 * same logic runs in the Next.js route handler, the browser, and tests.
 *
 * What a consumer has to get right, and what this module encodes:
 *  - identity: an event is (network fingerprint, EVM chain ID, block hash,
 *    transaction hash, log index); the same tx/log on another network or in
 *    another block is a different event;
 *  - snapshots: pages are read under one snapshot; CURSOR_RESTART_REQUIRED
 *    discards everything read so far and starts again from the first page;
 *  - reconciliation replaces the view with the new snapshot (never appends);
 *  - freshness comes from timestamps and source status, not only lagBlocks,
 *    because lag is computed from the worker's last observation and freezes
 *    when the worker stops;
 *  - /indexer is read after the events and must be the same generation
 *    (network fingerprint, reorg epochs), else the whole read is repeated;
 *  - absence is only meaningful inside the completed coverage reported with
 *    the events snapshot itself; a newer /indexer checkpoint is liveness, not
 *    coverage;
 *  - finality is reported as the API reports it (unknown), never inferred.
 */

// ------------------------------------------------------------------ API shapes (subset used)

export interface ApiFingerprint {
  id: string;
  genesisHash: string;
  evmChainId: string;
  lastVerifiedAt: string;
}

export interface ApiCoverage {
  sourceId: string;
  contractAddress?: string;
  requested: { fromBlock: string; toBlock: string | null };
  completed: { fromBlock: string; toBlock: string; blockHash: string; committedAt: string } | null;
  status: string;
  latestObservedBlock: string | null;
  latestObservedAt: string | null;
  lagBlocks: string | null;
  /** Source reorg epoch in the same database snapshot as the events (older APIs omit it). */
  reorgEpoch?: string;
}

export interface ApiMeta {
  networkId: string;
  networkFingerprint: ApiFingerprint | null;
  chainLayer?: string;
  observedAt: string;
  checkpoint: { sourceId: string; blockNumber: string; blockHash: string; committedAt: string } | null;
  coverage: ApiCoverage[];
  finalityPolicy?: string;
  finality: string;
  finalityNote?: string;
}

export interface ApiEvent {
  id: string;
  networkId: string;
  contractAddress: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
  decodeStatus: string;
  event: { name: string; signature: string; args: Record<string, unknown> } | null;
  indexedAt: string;
  sourceId: string;
  finality: string;
}

export interface ApiIndexerSource {
  id: string;
  contractAddress: string;
  events: string[];
  requestedRange: { fromBlock: string; toBlock: string | null };
  completedRange: { fromBlock: string; toBlock: string } | null;
  checkpoint: { blockNumber: string; blockHash: string; committedAt: string } | null;
  latestObservedBlock: string | null;
  latestObservedAt: string | null;
  lagBlocks: string | null;
  desiredState: string;
  status: string;
  reorgEpoch: string;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface ApiTransaction {
  hash: string;
  status: { submission: string; inclusion: string; execution: string; finality: string; indexing: string };
  blockNumber: string | null;
  blockHash: string | null;
  trackingStatus?: string;
}

// ------------------------------------------------------------------ reading

/** Minimal fetch contract (global fetch satisfies it; tests can inject one). */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export class ConsumerApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface ReadOptions {
  apiUrl: string;
  projectId: string;
  readKey: string;
  event?: string;
  contract?: string;
  fetch: FetchLike;
  pageLimit?: number;
  maxPages?: number;
  maxRestarts?: number;
  timeoutMs?: number;
}

export interface Snapshot {
  fetchedAt: string;
  meta: ApiMeta | null;
  /** Deduplicated by identity, in chain order. */
  events: ApiEvent[];
  /** null when the indexer endpoint could not be read (e.g. missing indexer:read scope). */
  sources: ApiIndexerSource[] | null;
  sourcesError: string | null;
  /** Transactions behind the events, by lower-case hash (null if not readable). */
  transactions: Record<string, ApiTransaction> | null;
  /** The transaction behind the latest event (null if none or not readable). */
  latestTransaction: ApiTransaction | null;
  /** CURSOR_RESTART_REQUIRED answers handled while reading this snapshot. */
  restarts: number;
  /** Re-reads because /indexer reported another network fingerprint or reorg epoch than the events snapshot. */
  generationRestarts: number;
  pages: number;
  duplicatesDropped: number;
}

export function networkKey(meta: ApiMeta | null): string {
  const fp = meta?.networkFingerprint;
  return fp ? `${meta!.networkId}|${fp.id}|${fp.evmChainId}|${fp.genesisHash.toLowerCase()}` : 'unknown-network';
}

/** Event identity: network fingerprint + chain ID + block hash + tx hash + log index. */
export function eventIdentity(meta: ApiMeta | null, e: Pick<ApiEvent, 'blockHash' | 'transactionHash' | 'logIndex'>): string {
  return `${networkKey(meta)}|${e.blockHash.toLowerCase()}|${e.transactionHash.toLowerCase()}|${e.logIndex}`;
}

function chainOrder(a: ApiEvent, b: ApiEvent): number {
  const ba = BigInt(a.blockNumber);
  const bb = BigInt(b.blockNumber);
  if (ba !== bb) return ba < bb ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

/**
 * Whether the /indexer read belongs to another data generation than the events snapshot:
 * a different network fingerprint, a different reorg epoch for a source, or a different set of sources.
 */
export function generationMismatch(snapshotMeta: ApiMeta | null, indexerMeta: ApiMeta | null, sources: ApiIndexerSource[]): string | null {
  const a = snapshotMeta?.networkFingerprint?.id ?? null;
  const b = indexerMeta?.networkFingerprint?.id ?? null;
  if (a && b && a !== b) return `network fingerprint ${a} (events) vs ${b} (indexer)`;
  const coverage = snapshotMeta?.coverage ?? [];
  const ids = new Set(sources.map((s) => s.id));
  for (const c of coverage) {
    const src = sources.find((s) => s.id === c.sourceId);
    if (!src) return `source ${c.sourceId} is in the events snapshot but not in the indexer status`;
    if (c.reorgEpoch !== undefined && src.reorgEpoch !== c.reorgEpoch) return `reorg epoch ${c.reorgEpoch} (events) vs ${src.reorgEpoch} (indexer) for source ${c.sourceId}`;
    ids.delete(c.sourceId);
  }
  if (snapshotMeta && ids.size) return `source(s) ${[...ids].join(', ')} appeared after the events snapshot`;
  return null;
}

export async function readSnapshot(o: ReadOptions): Promise<Snapshot> {
  const base = `${o.apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(o.projectId)}`;
  const headers = { authorization: `Bearer ${o.readKey}` };
  const timeoutMs = o.timeoutMs ?? 15_000;

  async function get(path: string, params: Record<string, string | undefined> = {}): Promise<{ data: unknown; nextCursor?: string | null; meta?: ApiMeta }> {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as Array<[string, string]>).toString();
    let r: { status: number; json(): Promise<unknown> };
    try {
      r = await o.fetch(`${base}/${path}${q ? `?${q}` : ''}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ConsumerApiError(`PalletDock API unreachable: ${(e as Error).message}`, 'API_UNAVAILABLE', null);
    }
    let body: any;
    try {
      body = await r.json();
    } catch {
      throw new ConsumerApiError(`PalletDock API returned a non-JSON response (HTTP ${r.status}).`, 'BAD_RESPONSE', r.status);
    }
    if (r.status >= 400) throw new ConsumerApiError(body?.error?.message ?? `HTTP ${r.status}`, body?.error?.code ?? `HTTP_${r.status}`, r.status);
    return body;
  }

  const maxPages = o.maxPages ?? 50;
  const maxRestarts = o.maxRestarts ?? 3;
  let restarts = 0;
  let generationRestarts = 0;
  for (;;) {
    // One snapshot: everything read below is discarded if the API invalidates it.
    const byId = new Map<string, ApiEvent>();
    let meta: ApiMeta | null = null;
    let cursor: string | undefined;
    let pages = 0;
    let dropped = 0;
    let restart = false;
    for (;;) {
      let body;
      try {
        body = await get('events', { event: o.event, contract: o.contract, limit: String(o.pageLimit ?? 100), cursor });
      } catch (e) {
        if (e instanceof ConsumerApiError && e.code === 'CURSOR_RESTART_REQUIRED') {
          if (++restarts > maxRestarts) throw new ConsumerApiError(`Snapshot invalidated ${restarts} times in a row; giving up for now.`, 'CURSOR_RESTART_LIMIT', 409);
          restart = true;
          break;
        }
        throw e;
      }
      if (++pages > maxPages) throw new ConsumerApiError(`More than ${maxPages} pages; narrow the filter.`, 'TOO_MANY_PAGES', null);
      // The first page's meta describes the snapshot (its coverage and generation); later pages must match its network.
      if (!meta) meta = body.meta ?? null;
      else if (body.meta?.networkFingerprint?.id !== meta.networkFingerprint?.id) {
        restart = true;
        generationRestarts++;
        break;
      }
      for (const ev of (body.data as ApiEvent[]) ?? []) {
        const id = eventIdentity(meta, ev);
        if (byId.has(id)) dropped++;
        else byId.set(id, ev);
      }
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    if (restart) {
      if (generationRestarts > maxRestarts) throw new ConsumerApiError('The network fingerprint kept changing while reading; no consistent snapshot.', 'GENERATION_CHANGED', null);
      continue;
    }

    // Liveness comes from /indexer, read after the events. It may be newer than the snapshot; it must be the same generation.
    let sources: ApiIndexerSource[] | null = null;
    let sourcesError: string | null = null;
    let indexerMeta: ApiMeta | null = null;
    try {
      const body = await get('indexer');
      sources = (body.data as ApiIndexerSource[]) ?? [];
      indexerMeta = body.meta ?? null;
    } catch (e) {
      if (!(e instanceof ConsumerApiError) || e.code === 'API_UNAVAILABLE') throw e;
      sourcesError = `${e.code}: ${e.message}`;
    }
    const mismatch = sources ? generationMismatch(meta, indexerMeta, sources) : null;
    if (mismatch) {
      if (++generationRestarts > maxRestarts) throw new ConsumerApiError(`No consistent snapshot: ${mismatch}`, 'GENERATION_CHANGED', null);
      continue;
    }
    const events = [...byId.values()].sort(chainOrder);
    let transactions: Record<string, ApiTransaction> | null = null;
    let latestTransaction: ApiTransaction | null = null;
    const last = events.at(-1);
    if (last) {
      try {
        const byHash = (list: unknown) => Object.fromEntries(((list as ApiTransaction[]) ?? []).filter((t) => t.hash).map((t) => [t.hash.toLowerCase(), t]));
        transactions = byHash((await get('transactions', { limit: '100' })).data);
        const key = last.transactionHash.toLowerCase();
        if (!transactions[key]) Object.assign(transactions, byHash((await get('transactions', { hash: last.transactionHash })).data));
        latestTransaction = transactions[key] ?? null;
      } catch (e) {
        if (!(e instanceof ConsumerApiError) || e.code === 'API_UNAVAILABLE') throw e;
        transactions = null;
      }
    }
    return { fetchedAt: new Date().toISOString(), meta, events, sources, sourcesError, transactions, latestTransaction, restarts, generationRestarts, pages, duplicatesDropped: dropped };
  }
}

// ------------------------------------------------------------------ reconciliation

export interface ConsumerState {
  networkKey: string | null;
  meta: ApiMeta | null;
  events: ApiEvent[];
  sources: ApiIndexerSource[] | null;
  sourcesError: string | null;
  transactions: Record<string, ApiTransaction> | null;
  latestTransaction: ApiTransaction | null;
  /** Sum of source reorg epochs at the last good read. */
  epochs: string | null;
  lastGoodAt: string | null;
  lastAttemptAt: string | null;
  lastError: { code: string; message: string; at: string } | null;
  /** Most recent reconciliation notes, newest first (bounded). */
  notes: Array<{ at: string; text: string }>;
}

export type ReadOutcome = { ok: true; snapshot: Snapshot } | { ok: false; error: { code: string; message: string }; at: string };

export const EMPTY_STATE: ConsumerState = {
  networkKey: null,
  meta: null,
  events: [],
  sources: null,
  sourcesError: null,
  transactions: null,
  latestTransaction: null,
  epochs: null,
  lastGoodAt: null,
  lastAttemptAt: null,
  lastError: null,
  notes: [],
};

function epochsOf(sources: ApiIndexerSource[] | null): string | null {
  return sources ? sources.reduce((a, s) => a + BigInt(s.reorgEpoch || '0'), 0n).toString() : null;
}

/** Apply one read. A good read replaces the view; a failed read keeps the last good data. */
export function reconcile(prev: ConsumerState, outcome: ReadOutcome): ConsumerState {
  if (!outcome.ok) {
    return { ...prev, lastAttemptAt: outcome.at, lastError: { ...outcome.error, at: outcome.at } };
  }
  const s = outcome.snapshot;
  const at = s.fetchedAt;
  const key = networkKey(s.meta);
  const epochs = epochsOf(s.sources);
  const notes: string[] = [];
  if (prev.networkKey && prev.networkKey !== key) notes.push(`Network identity changed (${prev.networkKey.split('|')[1] ?? '?'} → ${key.split('|')[1] ?? 'unknown'}); events from the previous network were discarded.`);
  if (s.generationRestarts) notes.push(`The data generation changed between requests (network fingerprint or reorg epoch); the whole read was repeated ${s.generationRestarts}× so events and indexer status come from one generation.`);
  if (s.restarts) notes.push(`The API invalidated the paging snapshot ${s.restarts}× (CURSOR_RESTART_REQUIRED); everything was re-read from the first page.`);
  if (prev.epochs !== null && epochs !== null && prev.epochs !== epochs) notes.push(`Indexed data was rolled back or reindexed since the last read (reorg epoch ${prev.epochs} → ${epochs}); the view was rebuilt from a fresh snapshot.`);
  if (s.duplicatesDropped) notes.push(`${s.duplicatesDropped} repeated row(s) with the same event identity were shown once.`);
  if (prev.networkKey === key) {
    const before = new Set(prev.events.map((e) => eventIdentity(prev.meta, e)));
    const after = new Set(s.events.map((e) => eventIdentity(s.meta, e)));
    const added = [...after].filter((x) => !before.has(x)).length;
    const removed = [...before].filter((x) => !after.has(x)).length;
    if (added || removed) notes.push(`${added} new and ${removed} removed event(s) since the previous read.`);
  }
  if (prev.lastError && (!prev.lastGoodAt || prev.lastError.at > prev.lastGoodAt)) notes.push(`API reachable again after ${prev.lastError.code} at ${prev.lastError.at}.`);
  return {
    networkKey: key,
    meta: s.meta,
    events: s.events,
    sources: s.sources,
    sourcesError: s.sourcesError,
    transactions: s.transactions,
    latestTransaction: s.latestTransaction,
    epochs,
    lastGoodAt: at,
    lastAttemptAt: at,
    lastError: null,
    notes: [...notes.map((text) => ({ at, text })), ...prev.notes].slice(0, 12),
  };
}

// ------------------------------------------------------------------ view

export type FreshnessLevel = 'fresh' | 'lagging' | 'stale' | 'error' | 'unknown' | 'unavailable';

export interface ConsumerView {
  level: FreshnessLevel;
  headline: string;
  reasons: string[];
  latest: { value: string | null; previousValue: string | null; event: ApiEvent } | null;
  network: { networkId: string; fingerprintId: string; evmChainId: string; genesisHash: string; lastVerifiedAt: string } | null;
  coverage: { fromBlock: string; toBlock: string; blockHash: string; committedAt: string; ageMs: number } | null;
  emptyMessage: string | null;
  finality: string;
  transactionCondition: string | null;
  lastGoodAt: string | null;
  ageMs: number | null;
}

export interface ViewOptions {
  /** A checkpoint older than this means the indexer is not keeping up (or the worker is stopped). */
  staleAfterMs?: number;
  /** Reported lag above this is shown as lagging. */
  lagWarnBlocks?: number;
  /** Only sources for this contract count, when set. */
  contract?: string;
}

const RANK: Record<FreshnessLevel, number> = { fresh: 0, lagging: 1, stale: 2, error: 3, unknown: 4, unavailable: 5 };
const worse = (a: FreshnessLevel, b: FreshnessLevel) => (RANK[b] > RANK[a] ? b : a);
const age = (iso: string | null | undefined, now: number) => (iso ? Math.max(0, now - new Date(iso).getTime()) : null);
export const fmtAge = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3_600_000)} h`);

function finalityLabel(value: string | undefined | null): string {
  // Reported, never inferred: receipts, confirmations or block-number parity are not finality.
  if (!value || value === 'unknown') return 'Unknown: not confirmed (no verified finality adapter)';
  return `Reported by the API as "${value}"`;
}

/** Short per-event tag for the receipt-tracking condition of an event's transaction. */
export function trackingTag(t: ApiTransaction | null | undefined): string | null {
  if (!t) return null;
  if (t.status.inclusion === 'reorged_out') return 'reorganized out';
  switch (t.trackingStatus) {
    case 'history_pruned':
      return 'node history pruned (inclusion kept from earlier observation)';
    case 'settled':
      return 'settled; finality unknown';
    case 'gave_up':
      return 'receipt checks stopped';
    case 'active':
      return 'receipt being checked';
    default:
      return null;
  }
}

function trackingLabel(t: ApiTransaction | null): string | null {
  if (!t) return null;
  switch (t.trackingStatus) {
    case 'history_pruned':
      return 'Node history pruned: the RPC node no longer serves this receipt; PalletDock kept the inclusion it observed earlier. Not a reorganization or a failure.';
    case 'settled':
      return 'Receipt checks settled at the confirmation depth. Finality is still unknown.';
    case 'gave_up':
      return 'Receipt checks stopped after repeated failures; stored data is unchanged.';
    case 'active':
      return t.status.inclusion === 'reorged_out' ? 'Reorganized out: the block that held it was replaced; it may be re-included.' : 'Receipt still being checked.';
    default:
      return t.status.inclusion === 'reorged_out' ? 'Reorganized out: the block that held it was replaced; it may be re-included.' : null;
  }
}

export function deriveView(state: ConsumerState, now: number, o: ViewOptions = {}): ConsumerView {
  const staleAfterMs = o.staleAfterMs ?? 90_000;
  const lagWarn = BigInt(o.lagWarnBlocks ?? 10);
  const reasons: string[] = [];
  let level: FreshnessLevel = 'fresh';
  const meta = state.meta;

  if (!state.lastGoodAt) {
    const unavailable = !!state.lastError;
    return {
      level: unavailable ? 'unavailable' : 'unknown',
      headline: unavailable ? 'No data yet: the PalletDock API could not be read.' : 'No data read yet.',
      reasons: state.lastError ? [`${state.lastError.code}: ${state.lastError.message}`] : [],
      latest: null,
      network: null,
      coverage: null,
      emptyMessage: null,
      finality: finalityLabel(null),
      transactionCondition: null,
      lastGoodAt: null,
      ageMs: null,
    };
  }

  if (state.lastError && (!state.lastGoodAt || state.lastError.at > state.lastGoodAt)) {
    level = worse(level, 'unavailable');
    reasons.push(`API unavailable since ${state.lastError.at} (${state.lastError.code}). Showing data last read at ${state.lastGoodAt}; it may be out of date.`);
  }

  const fp = meta?.networkFingerprint ?? null;
  if (!meta) {
    level = worse(level, 'unknown');
    reasons.push('The response carried no metadata: network, checkpoint and coverage are unknown.');
  } else if (!fp) {
    level = worse(level, 'unknown');
    reasons.push('No verified network fingerprint is reported.');
  }

  const forContract = (address: string | null | undefined) => !o.contract || (address ?? '').toLowerCase() === o.contract.toLowerCase();
  // Coverage, and so any claim of absence, comes from the meta of the events snapshot that was read: the API
  // reads it in the same database snapshot as the rows. /indexer is read afterwards and may already be newer,
  // so it only answers liveness (status, errors, lag, last observation), never what the snapshot covers.
  const snapshotCoverage = (meta?.coverage ?? []).filter((c) => forContract(c.contractAddress));
  let coverage: ConsumerView['coverage'] = null;
  for (const c of snapshotCoverage) {
    if (c.completed && (!coverage || BigInt(c.completed.toBlock) > BigInt(coverage.toBlock))) {
      coverage = { fromBlock: c.completed.fromBlock, toBlock: c.completed.toBlock, blockHash: c.completed.blockHash, committedAt: c.completed.committedAt, ageMs: age(c.completed.committedAt, now)! };
    }
  }
  if (meta && !coverage) {
    level = worse(level, 'unknown');
    reasons.push('The events snapshot reports no completed coverage for this contract: absence of events is not evidence that none happened.');
  }

  const relevant = (state.sources ?? []).filter((s) => forContract(s.contractAddress));
  if (state.sources === null) {
    level = worse(level, 'unknown');
    reasons.push(`Indexer status could not be read${state.sourcesError ? ` (${state.sourcesError})` : ''}; freshness is unknown.`);
  } else if (!relevant.length) {
    level = worse(level, 'unknown');
    reasons.push('No indexer source covers this contract: absence of events is not evidence that none happened.');
  }

  for (const s of relevant) {
    if (s.status === 'error' || s.status === 'recovery_required') {
      level = worse(level, 'error');
      reasons.push(`Indexer ${s.status === 'error' ? 'error' : 'needs recovery'}${s.lastError ? `: ${s.lastError}` : ''}${s.lastErrorAt ? ` (at ${s.lastErrorAt})` : ''}.`);
    } else if (s.desiredState === 'paused' || s.status === 'paused') {
      level = worse(level, 'lagging');
      reasons.push(`Indexer paused at block ${s.checkpoint?.blockNumber ?? '?'}: later events are not reflected.`);
    } else if (s.status === 'backfilling' || s.status === 'pending') {
      level = worse(level, 'lagging');
      reasons.push(`Indexer ${s.status}: coverage is still growing.`);
    } else if (s.status === 'stopped') {
      level = worse(level, 'stale');
      reasons.push('Indexer stopped.');
    }
    if (!s.checkpoint) {
      level = worse(level, 'unknown');
      reasons.push('No checkpoint committed yet: no block range is covered.');
      continue;
    }
    // The worker refreshes latestObservedAt on every pass, even when no new block exists, so its age
    // tells whether the indexer is still watching. Checkpoint age alone would flag a quiet chain.
    const seenAge = age(s.latestObservedAt ?? s.checkpoint.committedAt, now)!;
    if (seenAge > staleAfterMs && s.desiredState !== 'paused') {
      level = worse(level, 'stale');
      reasons.push(`The indexer has not observed the chain for ${fmtAge(seenAge)} (checkpoint at block ${s.checkpoint.blockNumber}). The worker may be stopped or behind; the reported lag (${s.lagBlocks ?? '?'} blocks) dates from that last observation.`);
    }
    if (s.lagBlocks !== null && BigInt(s.lagBlocks) > lagWarn) {
      level = worse(level, 'lagging');
      reasons.push(`Indexer ${s.lagBlocks} blocks behind the latest block it observed.`);
    }
    const covered = snapshotCoverage.find((c) => c.sourceId === s.id)?.completed?.toBlock ?? null;
    if (covered === null || BigInt(s.checkpoint.blockNumber) > BigInt(covered)) {
      // Newer liveness, older snapshot: say so instead of stretching the snapshot's coverage.
      level = worse(level, 'lagging');
      reasons.push(`The indexer has advanced to block ${s.checkpoint.blockNumber} since this snapshot, which covers up to ${covered ?? 'no completed block'}; the next read will include it.`);
    }
  }

  const last = state.events.at(-1) ?? null;
  const args = (last?.event?.args ?? {}) as Record<string, unknown>;
  const latest = last ? { value: args.newValue != null ? String(args.newValue) : null, previousValue: args.previousValue != null ? String(args.previousValue) : null, event: last } : null;
  const emptyMessage = last
    ? null
    : coverage
      ? `No matching event in blocks ${coverage.fromBlock}–${coverage.toBlock} (indexed). Outside that range nothing is known.`
      : 'No events returned and no completed coverage reported: this does not show that no event happened.';

  const headline =
    level === 'fresh'
      ? 'Up to date with the indexer.'
      : level === 'lagging'
        ? 'Behind: newer events may not be shown yet.'
        : level === 'stale'
          ? 'Possibly out of date: the indexer has not advanced recently.'
          : level === 'error'
            ? 'Indexer reports an error: data may be incomplete.'
            : level === 'unavailable'
              ? 'API unavailable: showing the last data read.'
              : 'Coverage unknown: do not treat this as complete.';

  return {
    level,
    headline,
    reasons,
    latest,
    network: fp ? { networkId: meta!.networkId, fingerprintId: fp.id, evmChainId: fp.evmChainId, genesisHash: fp.genesisHash, lastVerifiedAt: fp.lastVerifiedAt } : null,
    coverage,
    emptyMessage,
    finality: finalityLabel(last?.finality ?? meta?.finality),
    transactionCondition: trackingLabel(state.latestTransaction),
    lastGoodAt: state.lastGoodAt,
    ageMs: age(state.lastGoodAt, now),
  };
}
