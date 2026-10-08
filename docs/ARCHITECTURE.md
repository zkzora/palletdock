# Architecture

## Processes

| Process | Code | Role |
| --- | --- | --- |
| PostgreSQL | `packages/db/migrations` | Single source of truth: owners, sessions, network identity, projects, artifacts, contracts, ABI versions, transactions + observations, indexer sources/jobs/checkpoints/headers, raw logs, decoded events, API keys, request logs, ops logs, probes, heartbeats, worker commands |
| API | `apps/api` (Fastify) | Owner auth and sessions, CSRF-protected workspace routes (`/workspace/...`), public read API (`/v1/...`), `/openapi.yaml`, `/health` |
| Worker | `apps/worker` | Network identity probes (60 s), indexer loop (2 s), receipt tracker (4 s), control commands, retention pruning. Independent of browsers and HTTP requests |
| Web | `apps/web` (Next.js 16) | Landing, docs, workspace UI. Proxies `/backend/*` to the API so session cookies are same-origin. Wallet signing happens here (EIP-1193) |

Coordination is through PostgreSQL only (no Redis or broker): leases on `indexer_jobs`, commands in `worker_commands`.

## Network identity

`network_fingerprints` holds one `active` row per network. The worker activates a fingerprint only when the EVM (`eth_chainId`, block 0, latest block) and native (`genesis hash`, runtime version, `system_properties`) probes both respond and match configuration. A different genesis is stored as `mismatch`; indexing and receipt tracking stop. `pnpm network:accept-reset --confirm` is the only path to a new identity: it supersedes the old one, fences and marks its sources `recovery_required`, bumps reorg epochs (invalidating API cursors), and invalidates account mappings. Contracts, transactions, logs, and mappings carry `fingerprint_id`.

## Transactions

The API prepares a write or deployment: it encodes calldata, estimates gas and price, requests a `reviveApi` dry run for storage deposit, and inserts a `prepared` row. The browser wallet signs. The browser reports `submitted` (hash), `rejected`, `wrong_network`, `failed_before_broadcast`, or `unknown`; a late hash after a timeout is attached to the same row. The worker's receipt tracker records inclusion, execution, gas, fee, and the raw receipt. It detects a receipt that disappears (`reorged_out`) or moves. Finality stays `unknown`. A successful deployment receipt creates the contract and ABI version v1 from the artifact.

## Indexer algorithm (`apps/worker/src/indexer/engine.ts`)

1. **Claim**: `UPDATE indexer_jobs … FOR UPDATE SKIP LOCKED` sets a new `lease_token`, `lease_expires_at`, and captures `indexer_sources.generation`.
2. **Identity**: the source's fingerprint must equal the active fingerprint, otherwise `recovery_required`.
3. **Ancestry**: the stored checkpoint hash must equal the chain's hash at that height. If not, walk retained `block_headers` downward to the highest matching height (common ancestor). If none matches, `recovery_required`.
4. **Fetch**: `eth_getLogs(address, topic0 ∈ selected events, [from, to])`. Range-too-large errors halve the range; success doubles it (bounded).
5. **Verify**: headers for `from`, `to`, and every log block. `from.parentHash` must equal the checkpoint hash, each log's block hash must match its header, and `to` is re-read after the fetch.
6. **Commit (one transaction)**: lock job + source, re-check lease token, expiry, generation, `desired_state='running'`, project not archived, and that the checkpoint is unchanged. Then insert raw logs (`ON CONFLICT DO NOTHING` on fingerprint + block hash + tx hash + log index + source), decoded rows (ABI-pinned; unknown/malformed kept with status and error), headers (pruned to retention), checkpoint, status, latest observed head, and job schedule. Empty ranges commit the checkpoint too.
7. **Rollback** on reorg: mark later raw logs `canonical=false` (orphan history kept), delete headers above the ancestor, move the checkpoint, `reorg_epoch += 1`, then reindex.
8. **Errors**: exponential backoff with equal jitter, `status='error'`, `last_error`, ops log. A recovery is logged on the next successful commit.

Pause, archive, contract removal, reindex, and edits all increment `generation`, so an in-flight fetch is discarded at commit (tested).

## Read API snapshots

Events are ordered by `(block_number, transaction_index, log_index, seq)`. The first page fixes `max(seq)`, the active fingerprint id, and the sum of the project's source reorg epochs. Cursors are HMAC-signed JSON bound to project, resource, normalized filters, and that snapshot. A changed fingerprint or epoch returns `409 CURSOR_RESTART_REQUIRED`.

## Security model

- One owner; scrypt password hashes; login rate-limited per IP and per email; sessions are random tokens stored hashed, HttpOnly SameSite=Strict cookies, 7-day expiry; production start refuses non-secure cookies.
- CSRF: per-session token required in `x-csrf-token` for every mutation.
- Ownership: every workspace route resolves the project by `(id, owner_id)`; child objects are always looked up with `project_id`; malformed UUIDs return 404.
- Read keys: `pd_live_<prefix>.<secret>`; only SHA-256 of the full key is stored; project-scoped; scopes per endpoint; expiry; revocation; replacement. Keys cannot authorize workspace routes.
- Logs: Fastify redacts `authorization`, `cookie`, `x-csrf-token`. `request_logs` store route templates, never query strings, headers, or bodies.
- RPC: allowlisted hosts from configuration; loopback only with `PALLETDOCK_ALLOW_LOOPBACK_RPC=1` outside production (fixture tests).
- No server-side signing keys. Uploaded artifacts are JSON only; nothing is compiled or executed server-side.
