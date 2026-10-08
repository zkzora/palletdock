# Implementation Status

Updated: 2026-10-08. Vocabulary: **Not started · In progress · Implemented · Tested · Blocked**. "Tested" means the cited automated check passed locally; it does not imply live-network acceptance, production readiness, or a security audit. "Fixture" means the local Hardhat chain used by browser E2E, never Portaldot.

## Latest verification (2026-10-08, Windows 11, Node 24, pnpm 11)

```text
pnpm typecheck                                   pass (shared, db, chain, contracts, api, worker, web)
pnpm test                                        11 files, 67 tests pass (Postgres integration via embedded PostgreSQL 18)
pnpm --filter @palletdock/contracts check        pass (artifacts reproducible)
pnpm --filter @palletdock/web build              pass (19 routes)
pnpm e2e:fixture --project=desktop               6 pass (full vertical slice on fixture chain)
pnpm e2e:fixture --project=mobile                1 pass (all workspace pages, no horizontal overflow)
pnpm network:verify / worker probes              FAIL – Portaldot EVM RPC HTTP 502, native WS timeout (178 probes recorded)
```

## Status by area

| Area | Status | Evidence / notes |
| --- | --- | --- |
| Monorepo, lockfile, scripts | Tested | `pnpm typecheck`, CI workflow `.github/workflows/ci.yml` (defined, not yet run on GitHub) |
| Network config + RPC allowlist (SSRF) | Tested | `packages/shared/test/quantity.test.ts` |
| Network identity fingerprint, mismatch halt | Implemented | `apps/worker/src/network.ts`; live activation **Blocked** (RPC 502) |
| Network reset migration | Tested | `apps/worker/test/network-reset.test.ts` |
| Lossless quantities / unit policy | Tested | `quantity.test.ts`; EVM unit **unverified** by design |
| Artifact + ABI validation, arg coercion | Tested | `packages/shared/test/abi.test.ts` |
| Reproducible sample contracts (Storage, ERC-20, ERC-721) | Tested | `packages/contracts` check; Revive compatibility **Blocked** (needs live deploy) |
| Owner auth, sessions, CSRF, login rate limit | Tested | `apps/api/test/api.test.ts` |
| Project CRUD, archive/restore, export | Tested | `api.test.ts`, `fixture-flow.spec.ts` |
| Project and owner isolation | Tested | `api.test.ts` (every workspace route, malformed ids) |
| Contract import (code check), ABI versions, remove | Tested | `api.test.ts`, fixture E2E import rejection |
| Read (eth_call) with lossless output | Tested | `api.test.ts`, fixture E2E |
| Write/deploy preparation, fee estimate, revert decoding | Tested | `api.test.ts` (custom error), fixture E2E (deploy + write) |
| Storage deposit dry run (reviveApi) | Implemented | `SubstrateAdapter.dryRunStorageDeposit`; unavailable path tested; live shape **Blocked** |
| Account mapping (reviveApi.accountId) | Implemented | Codec handling unit-tested in `packages/chain/test/substrate.test.ts`; live **Blocked** |
| Browser wallet: wrong network, rejection, unknown/timeout, late hash | Tested | `apps/web/test/wallet-core.test.ts`, fixture E2E rejection |
| Submission state machine (no rewrite after submit) | Tested | `api.test.ts` |
| Receipt tracker, reorged_out, contract-from-receipt | Tested (fixture) | fixture E2E deploy → contract tracked; reorged_out path not covered by a dedicated test |
| Indexer: leases, fencing, adaptive ranges, backoff, atomic commit, empty ranges | Tested | `apps/worker/test/indexer.test.ts` (13 tests) |
| Indexer: reorg rollback/replacement, deep reorg → recovery_required | Tested | `indexer.test.ts` |
| Indexer: archive-during-fetch, stale lease, concurrent workers, restart, duplicates | Tested | `indexer.test.ts` |
| Read API v1, keys (scope/expiry/revocation/replace), redaction | Tested | `api.test.ts` |
| Cursor snapshots bound to filters/fingerprint/reorg epoch | Tested | `api.test.ts`, `apps/api/test/cursor.test.ts` |
| OpenAPI conformance | Tested | `apps/api/test/openapi.test.ts` |
| Request logging + monitoring queries/filters | Tested | `api.test.ts`, fixture E2E filter → query |
| Web UI (design port): overview, contracts, deploy, import, contract detail, transactions, tx detail, indexer, API playground/keys/endpoints, monitoring, settings, network, docs, landing | Tested (fixture) | `fixture-flow.spec.ts`, screenshots via `fixture-screens.spec.ts` |
| Fixture-mode labelling | Tested | E2E asserts the FIXTURE NETWORK banner |
| Docker images / compose app profile | Implemented | Not run (no Docker on the dev machine) |
| Live acceptance (deploy, write, index, API, restart/interruption on Portaldot) | **Blocked** | RPC outage; needs human-funded wallet + approval. See WALKTHROUGH.md, TESTNET_EVIDENCE.md |

## Known gaps worth doing next

- A dedicated test for the receipt tracker's `reorged_out` and receipt-moved paths.
- Live capability probe set (fee history, `finalized` tag, log range limit) recorded into `rpc_probes`.
- Record and apply a verified EVM unit policy after the live balance comparison.
- Replacement-transaction linking (same nonce), and storage-deposit observation from runtime events.
