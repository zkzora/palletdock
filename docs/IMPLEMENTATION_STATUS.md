# Implementation Status

Updated: 2026-10-21.

Three separate questions per area:

- **Implemented**: the code exists in `main`.
- **Locally tested**: an automated check passed: unit/integration tests (real PostgreSQL), browser E2E on the *fixture chain* (local Hardhat EVM, chain ID 420420777, labelled FIXTURE NETWORK), CI, or Docker. Not evidence about Portaldot.
- **Live-testnet verified**: observed on Portaldot V3 Testnet itself. As of 2026-10-21: network identity, account mapping, funding and the EVM unit policy, and the deploy → write → index → API chain are live-verified (signed by the owner with a scripted EIP-1193 signer through the PalletDock UI; see TESTNET_EVIDENCE.md). RPC-interruption recovery is live-verified (safe failure, clear error, recovery from checkpoint, no duplicates); worker restart with a new event is not yet run live.

## Verification runs

| Run | Where | Result |
| --- | --- | --- |
| `pnpm test` | Windows working copy | 12 files, 76 tests pass |
| Independent clean clone (`git clone` → `pnpm install --frozen-lockfile` → contracts check → typecheck → test → web build) | Windows, short path `C:\PalletDock\_verify`, 2026-10-09 | all steps exit 0; 12 files / 75 tests (commit ba3534a) |
| Same, long path under `%TEMP%` | Windows | **failed**: embedded PostgreSQL cannot read files past MAX_PATH (267 chars). Environment limit; test setup now reports it clearly (TROUBLESHOOTING.md) |
| GitHub Actions CI run 37813541136 | ubuntu-latest, commit ba3534a | checks ✓ (12 files / 75 tests, artifacts reproducible, typecheck, build), fixture E2E ✓ (9 Playwright tests) |
| GitHub Actions CI run 37815181739 | ubuntu-latest, commit 33735d8 | checks ✓, fixture E2E ✓, **docker ✓** (image build, compose app profile: migrate exited 0, API healthy, web `/login` 200, `/backend/health` 200, worker running) |
| Fixture E2E | Windows, 2026-10-08 | desktop 6 + mobile 1 (+ screenshots) pass |
| `pnpm audit --prod` | 2026-10-09 | no known vulnerabilities |
| Live identity probes (old endpoints, 2026-10-08) | local worker → feso-apps.xyz | failed: EVM HTTP 502, native WS timeout (endpoints since retired) |
| `pnpm network:verify` (new endpoints, 2026-10-17) | → test-evm-rpc-v3 / test-node-v3.portaldot.dev | **verified**; fingerprint active (genesis 0xd4f9…83bd, portaldot-v3 spec 3002, tPOT/14/SS58 42) |
| `pnpm network:capabilities` (2026-10-17) | read-only | deploy simulation matches compiled bytecode; gas/fee methods, finalized/safe tags, getLogs, mapping OK; node retains 258 blocks |

## Status by area

| Area | Implemented | Locally tested | Live-testnet verified |
| --- | --- | --- | --- |
| Network config, RPC allowlist (SSRF) | ✓ | ✓ `quantity.test.ts` | – |
| Identity fingerprint, mismatch halt | ✓ | ✓ (pruned-node and codec-wrapper cases tested) | ✓ fingerprint active 2026-10-17 |
| Bounded RPC backoff (probes, receipts, indexer) | ✓ | ✓ `Backoff` + overlap test; worker log spacing measured | n/a |
| Network reset migration (manual, `--confirm`) | ✓ | ✓ `network-reset.test.ts` | not run (needs your approval) |
| Lossless quantities, EVM unit policy (raw) | ✓ | ✓ | ✓ denomination verified 2026-10-19 (×10⁴, minus existential deposit) |
| Artifact/ABI validation, argument coercion | ✓ | ✓ `abi.test.ts` | – |
| Sample contracts, reproducible build | ✓ | ✓ CI artifact check; deploy on fixture chain | ✓ PalletDockStorage deployed 2026-10-21; runtime code identical to the compiled artifact |
| Owner auth, sessions, CSRF, login limits | ✓ | ✓ `api.test.ts` | n/a |
| Projects, archive/restore, export | ✓ | ✓ API + fixture E2E | n/a |
| Owner/project isolation | ✓ | ✓ every workspace route | n/a |
| Contract import (code check), ABI versions, remove | ✓ | ✓ API + fixture E2E | ✗ |
| Read (eth_call), lossless output | ✓ | ✓ | ◐ `retrieve()` via eth_call returns 42; UI read not part of the live run |
| Write/deploy preparation, fee estimate, revert decoding | ✓ | ✓ (custom error decode; deploy + write on fixture) | ✓ deploy and `store(42)` prepared, estimated, and executed (2026-10-21); revert decoding not exercised live |
| Storage-deposit dry run (reviveApi) | ✓ | unavailable path; failed-dispatch path | ✓ instantiate dry run returned a charge (2,878,800,000,000,000 base units) for the funded deployer |
| Account mapping (reviveApi.accountId) | ✓ | codec unit test | ✓ read-only mapping at a finalized block |
| Wallet: wrong network, sender change, rejection, insufficient funds, unknown/timeout, late hash | ✓ | ✓ `wallet-core.test.ts`, fixture E2E rejection | ✗ |
| Submission state machine | ✓ | ✓ | ◐ success path (wallet hash → included → executed) |
| Receipt tracker: inclusion, revert, disappearance → reorged_out, re-inclusion, sender/recipient match, deploy → contract | ✓ | ✓ `tx-tracker.test.ts` (dedicated) | ◐ inclusion, execution, and deploy → contract observed; revert and reorg paths not observed |
| Indexer: leases, fencing, adaptive ranges, backoff, atomic commit, empty ranges, duplicates, restart, concurrent workers, archive-during-fetch | ✓ | ✓ `indexer.test.ts` (13) | ◐ backfill from the deployment block, atomic commit, following with lag 0, RPC failure → backoff → recovery without duplicates; restart and concurrency not run live |
| Indexer: reorg rollback/replacement, deep reorg or pruned history → recovery_required | ✓ | ✓ | ✗ |
| Read API v1, keys, redaction, snapshot cursors | ✓ | ✓ `api.test.ts`, `cursor.test.ts` | ◐ events endpoint 200 with a scoped key (`req_928DQZqiuWqf`); cursors not exercised live |
| OpenAPI conformance | ✓ | ✓ `openapi.test.ts` | n/a |
| Monitoring and request logging | ✓ | ✓ | ✓ live probes responding |
| Web UI (design port), mobile layout | ✓ | ✓ fixture E2E desktop + mobile | ✓ desktop flow used for the live run |
| Docker image + compose | ✓ | ✓ CI docker job | n/a |
| CI | ✓ | ✓ two green runs | n/a |
| Live acceptance chain (deploy → write → index → API → restart/interruption) | ✓ (code path) | ✓ fixture | ✓ deploy → write → index → API and RPC-interruption recovery (2026-10-21); worker restart not yet run live |

## Open items

- Live worker-restart check with a new event while stopped (WALKTHROUGH.md step 6.1).
- A MetaMask-approved run of the same flow (the 2026-10-21 run used a scripted EIP-1193 signer).
- Replacement-transaction linking by nonce.
