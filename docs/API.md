# Read API

Machine-readable spec: [openapi.yaml](openapi.yaml) (also served by the API at `GET /openapi.yaml`). A conformance test (`apps/api/test/openapi.test.ts`) checks that every documented path is registered and that responses carry the documented envelope and meta fields.

## Authentication

Create a key in the workspace (API → Keys). It looks like `pd_live_<prefix>.<secret>` and is shown once. Send it as `Authorization: Bearer <key>`. Keys are scoped to one project and to `contracts:read`, `transactions:read`, `events:read`, `indexer:read`; they expire after 7–365 days and can be revoked or replaced. Keys in URLs are not accepted.

## Endpoints

| Route | Scope | Filters |
| --- | --- | --- |
| `GET /v1/projects/{projectId}/events` | events:read | `contract`, `event` (name or signature), `fromBlock`, `toBlock`, `finality` (`unknown`/`finalized`), `limit`, `cursor` |
| `GET /v1/projects/{projectId}/transactions` | transactions:read | `executionStatus`, `inclusionStatus`, `contract`, `hash`, `limit`, `cursor` |
| `GET /v1/projects/{projectId}/contracts` | contracts:read | `address`, `limit`, `cursor` |
| `GET /v1/projects/{projectId}/indexer` | indexer:read | – |

Unknown query parameters return 400. `limit` defaults to 25, max 100.

## Response

```json
{
  "requestId": "req_…",
  "data": [ … ],
  "nextCursor": "…" ,
  "meta": {
    "networkId": "portaldot-v3-testnet",
    "networkFingerprint": { "id": "…", "genesisHash": "0x…", "evmChainId": "420420777", "lastVerifiedAt": "…" },
    "chainLayer": "evm",
    "observedAt": "2026-…Z",
    "checkpoint": { "sourceId": "…", "blockNumber": "…", "blockHash": "0x…", "committedAt": "…" },
    "coverage": [ { "sourceId": "…", "requested": { "fromBlock": "…", "toBlock": null }, "completed": { … }, "status": "following", "lagBlocks": "0", "reorgEpoch": "0" } ],
    "finalityPolicy": "included-with-explicit-finality",
    "finality": "unknown"
  }
}
```

Exact integers (blocks, values, gas, fees) are decimal strings. `nextCursor: null` means no further page in this snapshot.

Transactions also carry `trackingStatus` (`active`, `settled`, `history_pruned`, `gave_up`), the receipt-tracking condition. It is separate from submission, inclusion, execution, finality, and indexing: `history_pruned` means the RPC node no longer serves that receipt or block and the last observed inclusion is kept (not a failure or a reorganization); `settled` means checks stopped at the confirmation depth, and finality is still unknown.

## Freshness

`meta.coverage[].lagBlocks` is computed from the worker's last observation and stops changing when the worker stops. Judge freshness by `latestObservedAt` and `completed.committedAt` (also in `/v1/.../indexer` with `status`, `desiredState`, `lastError`, and `reorgEpoch`).

## Coverage belongs to the snapshot, liveness may be newer

An events page reads its `meta` (coverage, fingerprint, reorg epochs), the snapshot bound, and its rows in one read-only `REPEATABLE READ` transaction, so `meta.coverage[].completed.toBlock` is the range those rows were read against. The first page's `meta` describes the snapshot that later pages continue. Claim "no event up to block N" only from that coverage.

Each request is its own database snapshot. A `/v1/.../indexer` call made after the events can already report a newer checkpoint (the worker committed in between). Use it for liveness (status, errors, last observation), not to extend the events snapshot's coverage; the next events read includes the newer blocks. If `networkFingerprint.id` or a source's `reorgEpoch` differs between the events `meta.coverage` and `/indexer`, the two answers belong to different data generations (network change or rollback): read both again rather than combining them.

## Errors

`{ "error": { "code", "message", "requestId" } }` with 400 `INVALID_QUERY`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN_SCOPE`, 404 `PROJECT_NOT_FOUND`, 409 `CURSOR_RESTART_REQUIRED`, 429 `RATE_LIMITED`, 5xx. Messages never include secrets or another owner's data.

Keys of a temporary playground workspace work like any other key, expire no later than the workspace, and return 401 `UNAUTHORIZED` once the workspace has expired, even before they are revoked. The `/v1` routes and their semantics are unchanged; the playground adds only browser routes under `/auth` and `/workspace` (see [PLAYGROUND.md](PLAYGROUND.md)), which are not part of the public read API specification.

## Consumer examples

- [CONSUMER.md](CONSUMER.md): the `/consumer` demo page (latest value, event identity, coverage, freshness, finality, tracking condition; read key kept server-side).
- [`examples/read-events.mjs`](../examples/read-events.mjs) reads one consistent snapshot: it discards it and restarts on `CURSOR_RESTART_REQUIRED`, keys events by identity, and prints coverage. The dev stack in this repository serves the API on 4101:

```bash
PALLETDOCK_API_URL=http://127.0.0.1:4100 PALLETDOCK_PROJECT_ID=<uuid> PALLETDOCK_READ_KEY=<key> node examples/read-events.mjs NumberChanged
```

## Archived projects

Archived projects stay readable through the API with valid keys (data is frozen); workspace mutations and key creation are blocked until restore.
