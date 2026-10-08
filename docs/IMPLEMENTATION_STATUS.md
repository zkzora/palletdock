# Implementation Status

Updated: 2026-10-08 (Asia/Jakarta)

Status vocabulary: **Not started**, **In progress**, **Implemented**, **Tested**, **Blocked**. “Tested” here means the cited local/deterministic check passed; it does not imply production readiness or a security audit.

| Area | Status | Evidence / limits |
| --- | --- | --- |
| pnpm monorepo and lockfile | Tested | Six workspace projects install; `pnpm typecheck` passes. |
| Shared network/quantity helpers | Tested | Exact bigint/decimal handling and allowlisted RPC configuration compile; chain tests exercise values above JS safe integer. |
| ABI/artifact validation | Implemented | Schema, creation bytecode, linking, scalar/array/tuple coercion exist. Dedicated validation tests still need expansion. |
| PostgreSQL schema and migration runner | Tested | `0001_init.sql` applied to local PostgreSQL; a second `pnpm db:migrate` reported up to date. Initial schema includes ownership, chain identity, contracts, transaction stages, indexer leases/checkpoints/logs, keys, probes, and monitoring logs. |
| Local database startup | Tested | Embedded PostgreSQL starts on `127.0.0.1:55432` with explicit UTF-8 initialization. Docker Compose is supplied but Docker is not installed in this environment. |
| EVM adapter | Tested | Deterministic tests cover identity mismatch, exact quantities, block tags, JSON-RPC errors, and timeouts. Read methods cover identity, headers, code, call/estimate, receipts, fees, and logs. No server-side signing or broadcast is implemented. |
| Native identity/account mapping adapter | Implemented | Reads runtime identity and `reviveApi.accountId` at an explicit finalized block, retaining block/runtime provenance. Unit tests validate `Option<AccountId32>` handling. Live mapping is blocked by endpoint availability. |
| Live network verification | Blocked | 2026-10-08 probe: EVM endpoint HTTP 502; native WebSocket timed out after 15 seconds. Failed probes were persisted. No network fingerprint was activated. |
| Single-owner session authentication | Tested | Local acceptance logged in through an HttpOnly SameSite cookie; passwords use scrypt; login attempts are recorded/rate limited; mutations require CSRF. Broader adversarial testing remains. |
| Project CRUD/archive lifecycle | Tested | Local acceptance created a persisted project. Archive fences indexers by incrementing generation; restore does not silently resume them. Search and delete are not implemented. |
| Project read-key lifecycle | Tested | Local acceptance created a scoped expiring key, returned its secret once, and called a real read route. Metadata listing and revocation exist. Replacement flow is not implemented. |
| Read API | Tested | Contracts/transactions/events/indexer endpoints authorize by project and scope. Limits are bounded; exact values remain strings; signed cursors bind project/filter/snapshot. Local empty-contract response passed. Request logging and full filter coverage remain. |
| Network monitor worker | Tested | Worker heartbeat and persisted identity probes run locally. Current health is degraded because both upstream RPC probes fail. The worker is not an event indexer yet. |
| Event indexer/reorg recovery | Not started | Schema is present; fetch, lease/fencing commit loop, ancestry rollback, decoding, and recovery tests are not implemented. |
| Contract import/deploy/read/write | Not started | Chain reads and schema foundations exist; browser-wallet approval flows and contract routes do not. |
| Contract artifacts | Not started | Reproducible Storage/ERC-20/ERC-721 builds and provenance have not been added. |
| Web application | Not started | The supplied design exports/content kit remain reference material; no Next.js app has been ported yet. |
| OpenAPI | Not started | Packet draft has not been reconciled with the implemented routes. |
| Live wallet acceptance | Blocked | Requires reachable RPCs, compiler compatibility, a human-funded testnet wallet, and human approval. No address or transaction evidence has been fabricated. |

## Latest automated verification

```text
pnpm typecheck: passed (shared, db, chain, api, worker)
pnpm test: 4 files, 10 tests passed
pnpm db:migrate: applied 0001_init.sql; repeat run up to date
local API acceptance: health, login, CSRF project create, one-time key create, authenticated empty contracts response passed
worker runtime: heartbeat started; EVM/native health reported unavailable without activating a fingerprint
```
