// Minimal PalletDock API consumer: pages through indexed events for a project.
//
//   PALLETDOCK_API_URL=http://127.0.0.1:4100 \
//   PALLETDOCK_PROJECT_ID=<uuid> \
//   PALLETDOCK_READ_KEY=<pd_live_...>   # from the API page; never commit it
//   node examples/read-events.mjs [EventName]
//
// Handles pagination with nextCursor and restarts from the first page when the
// API reports CURSOR_RESTART_REQUIRED (indexed data was rolled back/reindexed).
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

let cursor = null;
let restarts = 0;
let total = 0;
for (;;) {
  let body;
  try {
    body = await page(cursor);
  } catch (e) {
    if (e.code === 'CURSOR_RESTART_REQUIRED' && restarts < 3) {
      console.error('Snapshot invalidated by a rollback or reindex; restarting from the first page.');
      cursor = null;
      total = 0;
      restarts++;
      continue;
    }
    throw e;
  }
  if (total === 0) {
    const cp = body.meta.checkpoint;
    console.error(`network ${body.meta.networkId} · checkpoint ${cp ? cp.blockNumber : 'none'} · finality ${body.meta.finality} · observed ${body.meta.observedAt}`);
  }
  for (const e of body.data) {
    total++;
    console.log(JSON.stringify({ block: e.blockNumber, tx: e.transactionHash, log: e.logIndex, event: e.event?.name ?? e.decodeStatus, args: e.event?.args ?? null }));
  }
  if (!body.nextCursor) break;
  cursor = body.nextCursor;
}
console.error(`${total} event(s). Absence outside the completed coverage in meta.coverage is not evidence that an event did not happen.`);
