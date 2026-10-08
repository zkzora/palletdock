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
    "coverage": [ { "sourceId": "…", "requested": { "fromBlock": "…", "toBlock": null }, "completed": { … }, "status": "following", "lagBlocks": "0" } ],
    "finalityPolicy": "included-with-explicit-finality",
    "finality": "unknown"
  }
}
```

Exact integers (blocks, values, gas, fees) are decimal strings. `nextCursor: null` means no further page in this snapshot.

## Errors

`{ "error": { "code", "message", "requestId" } }` with 400 `INVALID_QUERY`, 401 `UNAUTHORIZED`, 403 `FORBIDDEN_SCOPE`, 404 `PROJECT_NOT_FOUND`, 409 `CURSOR_RESTART_REQUIRED`, 429 `RATE_LIMITED`, 5xx. Messages never include secrets or another owner's data.

## Consumer example

[`examples/read-events.mjs`](../examples/read-events.mjs) pages through events and restarts on `CURSOR_RESTART_REQUIRED`:

```bash
PALLETDOCK_API_URL=http://127.0.0.1:4100 PALLETDOCK_PROJECT_ID=<uuid> PALLETDOCK_READ_KEY=<key> node examples/read-events.mjs NumberChanged
```

## Archived projects

Archived projects stay readable through the API with valid keys (data is frozen); workspace mutations and key creation are blocked until restore.
