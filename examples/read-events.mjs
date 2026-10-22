// Minimal PalletDock API consumer: reads one consistent snapshot of indexed events for a project.
//
//   PALLETDOCK_API_URL=http://127.0.0.1:4100 \
//   PALLETDOCK_PROJECT_ID=<uuid> \
//   PALLETDOCK_READ_KEY=<pd_live_...>   # from the API page; never commit it
//   node examples/read-events.mjs [EventName]
//
// Pages with nextCursor. When the API reports CURSOR_RESTART_REQUIRED (rollback,
// reindex, or network change) it discards everything read so far and starts again
// from the first page; nothing is printed until the snapshot is complete. Events
// are keyed by identity (network fingerprint, chain ID, block hash, transaction
// hash, log index), so a repeated row is printed once. The web app's consumer demo
// (/consumer, apps/web/lib/consumer) does the same and adds freshness checks.
const base = (process.env.PALLETDOCK_API_URL ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const projectId = process.env.PALLETDOCK_PROJECT_ID;
const key = process.env.PALLETDOCK_READ_KEY;
const event = process.argv[2];
if (!projectId || !key) {
  console.error('Set PALLETDOCK_PROJECT_ID and PALLETDOCK_READ_KEY.');
  process.exit(1);
}

async function page(cursor) {
  const q = new URLSearchParams({ limit: '100', ...(event ? { event } : {}), ...(cursor ? { cursor } : {}) });
  const res = await fetch(`${base}/v1/projects/${projectId}/events?${q}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(`${res.status} ${body.error?.code}: ${body.error?.message} (requestId ${body.error?.requestId})`);
    err.code = body.error?.code;
    throw err;
  }
  return body;
}

let restarts = 0;
let snapshot;
for (;;) {
  // One snapshot: discarded as a whole if the API invalidates it.
  const events = new Map();
  let meta = null;
  let cursor = null;
  let restart = false;
  for (;;) {
    let body;
    try {
      body = await page(cursor);
    } catch (e) {
      if (e.code === 'CURSOR_RESTART_REQUIRED' && restarts < 3) {
        console.error('Snapshot invalidated by a rollback, reindex, or network change; discarding it and re-reading from the first page.');
        restarts++;
        restart = true;
        break;
      }
      throw e;
    }
    meta ??= body.meta;
    const fp = body.meta.networkFingerprint;
    for (const e of body.data) {
      const id = [fp?.id ?? 'unknown-network', fp?.evmChainId ?? '?', e.blockHash.toLowerCase(), e.transactionHash.toLowerCase(), e.logIndex].join('|');
      if (!events.has(id)) events.set(id, e);
    }
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  if (restart) continue;
  snapshot = { meta, events: [...events.values()] };
  break;
}

const { meta, events } = snapshot;
const fp = meta.networkFingerprint;
console.error(`network ${meta.networkId} · chain ${fp?.evmChainId ?? 'unknown'} · genesis ${fp?.genesisHash ?? 'unknown'} · finality ${meta.finality} · observed ${meta.observedAt}`);
if (!fp) console.error('No verified network fingerprint reported: treat these results as unverified.');
if (!meta.coverage?.length) console.error('No indexer coverage reported: an empty result here says nothing about whether events happened.');
for (const c of meta.coverage ?? []) {
  const done = c.completed ? `blocks ${c.completed.fromBlock}-${c.completed.toBlock} (checkpoint ${c.completed.committedAt})` : 'nothing completed yet';
  console.error(`coverage ${c.contractAddress ?? c.sourceId}: ${done} · status ${c.status} · last observed ${c.latestObservedAt ?? 'never'}`);
}
for (const e of events) {
  console.log(JSON.stringify({ block: e.blockNumber, blockHash: e.blockHash, tx: e.transactionHash, log: e.logIndex, event: e.event?.name ?? e.decodeStatus, args: e.event?.args ?? null, finality: e.finality }));
}
console.error(`${events.length} event(s), ${restarts} snapshot restart(s). Absence outside the completed coverage above is not evidence that an event did not happen.`);
