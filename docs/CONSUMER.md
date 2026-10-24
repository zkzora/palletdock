# Consumer demo: an app that reads PalletDock's read API

PalletDock's job ends where an application starts: the app needs the latest
state behind its contract, the event that produced it, and an honest answer to
"how current and how complete is this?". The consumer demo is a small read-only
page that plays that application. It uses only the public `/v1` read API
([API.md](API.md)), never the database or the workspace endpoints.

- Page: `/consumer` in the web app (separate from the workspace UI).
- Server route: `/consumer/state` reads `/v1/.../events`, `/v1/.../indexer`, and
  `/v1/.../transactions` with a server-side read key and returns derived data.
- Logic: [`apps/web/lib/consumer/core.ts`](../apps/web/lib/consumer/core.ts)
  (framework-free; the same code runs in the route, the browser, and the tests).
- CLI equivalent: [`examples/read-events.mjs`](../examples/read-events.mjs).

## Run it

1. In the workspace, API → Keys → **Create API key** with `events:read`,
   `indexer:read`, and `transactions:read`. The secret is shown once.
2. Put it on the server, never in the browser. Either environment variables for
   the web process:
   ```bash
   PALLETDOCK_CONSUMER_PROJECT_ID=<project uuid>
   PALLETDOCK_CONSUMER_READ_KEY=<pd_live_...>
   # optional: PALLETDOCK_CONSUMER_CONTRACT, PALLETDOCK_CONSUMER_EVENT (default NumberChanged), PALLETDOCK_CONSUMER_API_URL
   ```
   or a gitignored file `.data/consumer.json` at the repository root (path
   override: `PALLETDOCK_CONSUMER_CONFIG`):
   ```json
   { "projectId": "<project uuid>", "readKey": "pd_live_...", "contract": "0x..." }
   ```
   The file is re-read on every request, so no restart is needed.
3. Sign in to the workspace and open `http://127.0.0.1:3001/consumer`. For a
   dedicated hosted jury demo only, `PALLETDOCK_CONSUMER_PUBLIC=1` may expose
   this read-only page without exposing the workspace.

## Security model

- The read key stays server-side: not in `NEXT_PUBLIC_*`, the bundle, browser
  storage, URLs, or responses. Responses carry the key's public prefix only, and
  error messages are scrubbed of the key.
- `/consumer/state` is private by default and answers a signed-in workspace
  owner only (checked with the API's existing `/auth/me`). Without a session it
  returns 401 and no project data.
- `PALLETDOCK_CONSUMER_PUBLIC=1` explicitly exposes derived state for the one
  configured demo project. It does not expose the read key or bypass auth for
  `/app` or workspace/mutation endpoints. Use a dedicated non-sensitive project,
  then disable the flag and revoke the read key after judging.
- The page is read-only. It sends nothing on chain and triggers no effects.

## What the consumer does

| Situation | Behaviour |
| --- | --- |
| Normal | Latest value from the latest event, with network ID, EVM chain ID, genesis, fingerprint, block number and hash, transaction hash, log index, checkpoint, indexed range, and when it was read. |
| Event identity | `(network fingerprint, chain ID, block hash, transaction hash, log index)`. The same tx/log on another network or in another block is a different event. |
| Reconciliation | Each read replaces the view with a complete snapshot; nothing is appended. A repeated row is shown once. |
| `CURSOR_RESTART_REQUIRED` | The partial snapshot is discarded and paging restarts from the first page (bounded; gives up after 3 in a row). |
| Network identity changes | Previous events are discarded and the change is logged. |
| API unavailable | The last value stays visible, marked *API unavailable* with the time of the last good read. Reads back off (5 s → 60 s). |
| Missing metadata, fingerprint, or indexer status | *Coverage unknown*, never "up to date". |
| Empty result | Only "no event in blocks A–B" when the events snapshot's own `meta.coverage` covers that range; otherwise it says absence is not evidence. |
| `/indexer` newer than the events | Coverage and absence come only from the events snapshot that was read. `/indexer` is read afterwards and may already show a later checkpoint. That is noted ("the indexer has advanced to block N since this snapshot, which covers up to M"), never used as coverage, and shown as *Behind* only when the gap exceeds the lag threshold (10 blocks); a few blocks are normal while the worker follows the head. The next read includes the new blocks once. |
| Different generations between requests | If `/indexer` reports another network fingerprint, another reorg epoch for a source, or another set of sources than the events snapshot, the whole read (events and status) is repeated (bounded; `GENERATION_CHANGED` after 3). |
| Worker stopped or behind | *Possibly out of date* when the indexer has not observed the chain recently (`latestObservedAt`), because the reported lag freezes at the worker's last observation. Paused, error, and lag come from `/v1/indexer`. |
| Finality | Shown as the API reports it: *Unknown: not confirmed*. It is never inferred from receipts, confirmations, or block numbers. |
| Receipt-tracking condition | Per event, from `/v1/transactions` `trackingStatus`: *node history pruned* (inclusion kept from an earlier observation; not a reorg or a failure), *reorganized out*, *settled; finality unknown*, *receipt checks stopped*. Rollbacks show as the indexer's reorg epoch. |

## Demo walkthrough

Evidence types are kept apart: **fixture** = local Hardhat chain (not Portaldot),
**recorded** = stored observations from an earlier live run, **live** = read from
Portaldot V3 Testnet now.

| Step | How | Evidence |
| --- | --- | --- |
| A. Normal event | Open `/consumer`. On the dev stack it shows `43` from `store(43)` at block 134261 with its identity and *Up to date*. | **live** (screenshot `docs/evidence/2026-10-21-consumer/01-normal.png`); **fixture** E2E `fixture-consumer.spec.ts` (A) |
| B. Worker stops, new event | Stop the worker (`scripts/dev-services.ps1 stop -Only worker`), then send a new `store(n)` from the workspace. Sending is a wallet transaction: the owner does it. | **live** 2026-10-21: worker stopped, owner sent `store(44)` (tx `0x56913fdf…b004cd`, block 137978) ([evidence](evidence/2026-10-21-consumer-new-event/)); **fixture** E2E pauses the indexer source and writes `store(43)` (B–D) |
| C. Consumer shows it is not current | Within ~90 s: *Possibly out of date: the indexer has not observed the chain for …*; the value is shown with that caveat. With the API itself down: *API unavailable*, last value kept with its read time. | **live** (`02-worker-stopped.png`, `04-api-down.png`; with the new event already included and the worker still stopped: *Possibly out of date*, value still 43, `03-tx-included-worker-stopped.png` in the new-event run); **fixture** E2E (paused → *Behind*; unreachable API → *API unavailable*) |
| D. Recovery without duplicates | Start the worker again: the new event appears once, the view returns to *Up to date*, the log notes "1 new and 0 removed". | **live** 2026-10-21: worker back → *Up to date*, value 44, 3 events with 3 unique identities, "1 new and 0 removed"; reload and refresh still 3 ([evidence](evidence/2026-10-21-consumer-new-event/)). **fixture** E2E (2 rows, reload still 2) |
| E. Pruned history vs reorg vs RPC error | The `store(42)` row is tagged *node history pruned*: the node discarded that history and PalletDock kept the inclusion it observed. Reorgs show as the reorg epoch (26 on the dev stack) and as snapshot restarts; an RPC error shows as *Indexer error* with the node's message. | **recorded** (the 2026-10-21 pruning and tip reorgs, [TESTNET_EVIDENCE.md](TESTNET_EVIDENCE.md)); RPC error and restart handling: unit and API tests; the RPC-interruption dev control is owner-only and disabled in production |

## Tests

- `apps/web/test/consumer-core.test.ts`: positive controls (healthy view; quiet
  chain stays fresh), paging, restart discards the partial snapshot, bounded
  restarts, API unavailable, missing scope, no-append reconciliation, network
  change, empty results, stopped worker, paused/error/lag, finality, tracking tags,
  and the race between `/events` and a newer `/indexer` (absence limited to the
  snapshot's coverage; rollback or fingerprint change between requests).
- `apps/web/test/consumer-server.test.ts`: config from env/file, key never in
  responses or errors, owner-session check, public demo access off by default.
- `apps/api/test/api.test.ts`: the consumer core against the real Fastify `/v1`
  routes, with a rollback between pages forcing `CURSOR_RESTART_REQUIRED`, and a
  worker commit (event and checkpoint at block 101) between `/events` and
  `/indexer`: the first read claims absence only up to 100, the next shows the
  event once; a reorg-epoch bump between the two requests repeats the read.
- `apps/web/e2e/fixture-consumer.spec.ts` (fixture stack): no data without a
  session, not-configured state, A, paused indexer → behind → resumed with one new
  event, unreachable API → last value kept → recovered; the key secret never
  appears in the page, the state response, or browser storage.

## Limits

Values are what PalletDock's indexer recorded from one RPC node, with the coverage
and checkpoint it reports. They are not a cryptographic proof; finality is not
verified; a single RPC node is trusted for chain data; history the node has
pruned cannot always be re-read. The consumer shows each event once in its own
view; it does not make downstream effects exactly-once. It reads at most 50 pages
and the latest 100 transactions per snapshot.

Each API request is its own database snapshot; there is no cross-request
transaction. An events page's rows and its `meta.coverage` are read together, so
the consumer bases absence on that coverage alone. `/indexer` and
`/transactions` are read after the events and can be newer: their status, lag,
and tracking tags are liveness for the moment they were read, not evidence about
the events snapshot. The generation check compares the network fingerprint, each
source's reorg epoch, and the set of sources. It relies on every rollback,
reindex, and network-recovery path bumping the reorg epoch (the worker and the
workspace reindex do today); a data change that bypassed that would not be seen
between requests. Transactions are not generation-checked: a tracking tag can be
one read ahead of the events.
