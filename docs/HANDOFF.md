# Handoff

## Current checkpoint

Work resumed from an interrupted scaffold whose last action was creating the chain package manifest. The chain package, database runtime, API foundation, and network-monitor worker are now implemented far enough to compile and pass the checks listed in `IMPLEMENTATION_STATUS.md`.

The active local development services at handoff are:

- PostgreSQL: `127.0.0.1:55432`; launcher PID is recorded in `.data/db.pid`.
- PalletDock API: `http://127.0.0.1:4101`; launcher PID is recorded in `.data/api.pid`.
- Port `4100` belongs to an unrelated process and was left untouched.
- Worker: running in degraded mode; launcher PID is recorded in `.data/worker.pid`. It persists heartbeats and retries identity probes while both upstream RPCs are unavailable.

Logs are under `.data/logs/`. `.data/` is ignored by git. A recoverable backup of the initial empty WIN1252 cluster is at `.data/postgres-win1252-backup`; the active cluster was reinitialized with UTF-8.

Local acceptance created one owner (`owner@palletdock.local`), one project named `Local acceptance`, and one expiring read key. The one-time key secret was not written to a file or committed. This is local test data, not demo/live-chain evidence.

## Important decisions

- Browser wallets must own all signing and broadcasting. Server adapters are read-only.
- A native/EVM identity pair is required before activating a network fingerprint. Partial or failed probes remain probe records only.
- EVM denominations remain raw and unverified; native 14 decimals are never applied to EVM quantities automatically.
- Project archive increments indexer generation to fence stale work. Restore deliberately does not resume workers.
- API key lookup uses a visible random prefix; only a digest of the full secret is stored.
- Read cursors are HMAC-signed and bound to project/resource/filter/snapshot. Invalid cursors return restart-required rather than drifting.
- The API currently defaults to 4100 in `.env.example`; use 4101 in this workstation session because 4100 is occupied.

## Exact next implementation slice

1. Add worker lease acquisition/renewal and generation checks using `indexer_jobs`.
2. Implement bounded/adaptive `eth_getLogs` backfill with atomic header/log/coverage/checkpoint commit, including empty ranges.
3. Decode logs against the pinned ABI version while preserving unknown and malformed raw logs.
4. Add deterministic tests for duplicate ingestion, archive-during-fetch fencing, worker restart, RPC backoff, and one-block reorg replacement.
5. Expose session-authenticated contract import and indexer configuration routes, then update the OpenAPI file.
6. Only after that, port the supplied dashboard visual direction into the web app and exercise the complete browser flow.

Do not claim the MVP complete until the live acceptance chain in the original prompt—deployment, write receipt, matching indexed event, authenticated API response, restart/recovery—is recorded with human-approved testnet transactions.
