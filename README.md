# PalletDock

PalletDock is a self-hosted developer workspace for **Portaldot V3 Testnet** (EVM layer). One project keeps a contract's artifacts, wallet-signed deployments and writes, tracked receipts, indexed events, a scoped read API, and monitoring together, and always shows the network, block, and freshness context behind each value.

> Status: self-hosted testnet MVP. **Live on Portaldot V3 Testnet (2026-10-21):** PalletDockStorage deployed at [`0xdd982913cb04f9e438437e2137ba1452e4b211ed`](docs/TESTNET_EVIDENCE.md#live-acceptance-run-2026-10-21) (tx `0x25f03a78…f30f`, block 133019), `store(42)` executed (tx `0x14ee38e9…fa47`, block 133023), its `NumberChanged` event indexed with block hash, tx hash, and log index matching the receipt, and served by the read API (`req_928DQZqiuWqf`, finality reported as unknown); a simulated RPC interruption failed safely and recovered without duplicates, a worker restart with `store(43)` sent while it was down produced exactly one new record, and 20 real tip reorganizations were rolled back without orphaned records. Screenshots and raw results: [docs/evidence/2026-10-21-live](docs/evidence/2026-10-21-live/). Network identity, account mapping, funding, and the EVM unit policy are recorded in the same file. Not audited, not production-ready. PalletDock is independent tooling, not an official Portaldot product.

## What it does

| Area | Implemented |
| --- | --- |
| Projects | Single-owner login, create/search/switch/edit, export without secrets, archive with fenced indexer stop, controlled restore |
| Network | Allowlisted RPCs only; identity fingerprint (native genesis + EVM chain ID + runtime) pinned by the worker; reset requires an explicit migration |
| Accounts | EVM wallet signing in the browser (EIP-1193); EVM → native mapping via runtime `reviveApi.accountId` with block/runtime provenance |
| Contracts | Artifact upload validation; bundled reproducible Storage / ERC-20 / ERC-721 samples; deploy wizard; import with runtime-code check; ABI versions; ABI-driven read and write with fee + storage-deposit dry-run review; custom error decoding |
| Transactions | Submission, inclusion, execution, finality, indexing tracked separately; wallet rejection, wrong network, unknown/timeout, revert, and receipt-disappeared states; hash registration; reconcile |
| Indexer | Separate worker; leased, generation-fenced commits; adaptive `eth_getLogs`; backoff with jitter; header ancestry checks; reorg rollback and reindex; recovery-required state; raw + decoded logs |
| Read API | `GET /v1/projects/{id}/{contracts,transactions,events,indexer}`; hashed, scoped, expiring, revocable, replaceable keys; signed snapshot cursors; OpenAPI at `/openapi.yaml` |
| Monitoring | Probes (responded / failed / stale / unavailable), worker heartbeat, lag, API errors from recorded requests, filtered and paginated logs |

Out of scope (not built): native signing and native event indexing, Assets/Uniques/Nfts, ink!, bridges, finality proofs, tracing, source verification, team roles, billing.

## Layout

```text
apps/web        Next.js 16 workspace, landing, docs (ported from the supplied PalletDock design)
apps/api        Fastify: owner sessions, workspace routes, public /v1 read API
apps/worker     Indexer, receipt tracker, network probes (independent process)
packages/chain  EVM JSON-RPC adapter and Substrate adapter (identity, mapping, dry run)
packages/shared Network allowlist, lossless quantities, ABI/artifact validation, schemas
packages/db     SQL migrations, migration runner, owner CLI
packages/contracts  Sample Solidity sources + reproducible artifacts (solc 0.8.24)
packages/e2e-chain  Local Hardhat node for browser E2E only (not Portaldot)
docs/           Architecture, API, network, walkthrough, status, handoff, evidence
```

## Setup

Requirements: Node.js 22+, pnpm 11+. PostgreSQL comes from `embedded-postgres` (no install) or Docker.

```bash
pnpm install
cp .env.example .env          # set PALLETDOCK_CURSOR_SECRET to a random 32-byte value
pnpm db:start                 # terminal 1: local PostgreSQL on 127.0.0.1:55432 (or: docker compose up -d postgres)
pnpm db:migrate
pnpm owner:create --email you@example.com      # prompts for a password (min 12 chars)
pnpm dev:api                  # terminal 2: API on API_PORT (default 4100)
pnpm dev:worker               # terminal 3: indexer, receipts, probes
pnpm dev:web                  # terminal 4: web on 3000, proxies /backend/* to PALLETDOCK_API_URL
pnpm network:verify           # optional: one read-only identity probe
```

Windows helper for long-running services (PIDs in `.data/*.pid`, logs in `.data/logs/`):

```powershell
powershell -File scripts/dev-services.ps1 start|stop|restart|status
```

Docker: `docker compose --profile app up -d`, then `docker compose run --rm owner --email you@example.com`. The image build and a compose boot (migrate, API health, web `/login`, worker) are checked in CI ([IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)).

## Tests

```bash
pnpm typecheck
pnpm test                         # vitest: unit + Postgres integration (starts a throwaway PostgreSQL)
pnpm --filter @palletdock/contracts check   # committed artifacts match a fresh compile
pnpm --filter @palletdock/web build
pnpm e2e:stack                    # terminal A: isolated fixture stack (ports 3199/4199/8599)
pnpm e2e:fixture                  # terminal B: Playwright desktop + mobile against it
```

The fixture stack uses a local Hardhat chain with Portaldot's chain ID and labels the UI **FIXTURE NETWORK**. Fixture results are never live evidence. Stop it with Ctrl+C or `scripts/e2e-stack-stop.ps1`.

## Docs

- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) – human steps for the live testnet acceptance run
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – processes, data model, indexer algorithm, security
- [docs/API.md](docs/API.md) and [docs/openapi.yaml](docs/openapi.yaml) – read API
- [docs/NETWORK.md](docs/NETWORK.md) – identity verification, units, mapping, reset migration
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
- [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md), [docs/HANDOFF.md](docs/HANDOFF.md), [docs/TESTNET_EVIDENCE.md](docs/TESTNET_EVIDENCE.md)
- In-app docs at `/docs`
