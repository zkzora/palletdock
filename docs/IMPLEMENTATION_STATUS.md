# Implementation Status

Updated: 2026-10-09.

Three separate questions per area:

- **Implemented**: the code exists in `main`.
- **Locally tested**: an automated check passed: unit/integration tests (real PostgreSQL), browser E2E on the *fixture chain* (local Hardhat EVM, chain ID 420420777, labelled FIXTURE NETWORK), CI, or Docker. Not evidence about Portaldot.
- **Live-testnet verified**: observed on Portaldot V3 Testnet itself. As of 2026-10-17 (new `portaldot.dev` endpoints): network identity, account mapping, and read-only capabilities are live-verified; wallet-signed transactions are still pending (TESTNET_EVIDENCE.md).

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
| Lossless quantities, EVM unit policy (raw) | ✓ | ✓ | ✗ EVM denomination unverified |
| Artifact/ABI validation, argument coercion | ✓ | ✓ `abi.test.ts` | – |
| Sample contracts, reproducible build | ✓ | ✓ CI artifact check; deploy on fixture chain | ◐ deploy simulated read-only (code matches); not broadcast |
| Owner auth, sessions, CSRF, login limits | ✓ | ✓ `api.test.ts` | n/a |
| Projects, archive/restore, export | ✓ | ✓ API + fixture E2E | n/a |
| Owner/project isolation | ✓ | ✓ every workspace route | n/a |
| Contract import (code check), ABI versions, remove | ✓ | ✓ API + fixture E2E | ✗ |
| Read (eth_call), lossless output | ✓ | ✓ | ✗ |
| Write/deploy preparation, fee estimate, revert decoding | ✓ | ✓ (custom error decode; deploy + write on fixture) | ✗ |
| Storage-deposit dry run (reviveApi) | ✓ | unavailable path; failed-dispatch path | ◐ API shape confirmed; needs a funded origin for a value |
| Account mapping (reviveApi.accountId) | ✓ | codec unit test | ✓ read-only mapping at a finalized block |
| Wallet: wrong network, sender change, rejection, insufficient funds, unknown/timeout, late hash | ✓ | ✓ `wallet-core.test.ts`, fixture E2E rejection | ✗ |
| Submission state machine | ✓ | ✓ | ✗ |
| Receipt tracker: inclusion, revert, disappearance → reorged_out, re-inclusion, sender/recipient match, deploy → contract | ✓ | ✓ `tx-tracker.test.ts` (dedicated) | ✗ |
| Indexer: leases, fencing, adaptive ranges, backoff, atomic commit, empty ranges, duplicates, restart, concurrent workers, archive-during-fetch | ✓ | ✓ `indexer.test.ts` (13) | ✗ |
| Indexer: reorg rollback/replacement, deep reorg or pruned history → recovery_required | ✓ | ✓ | ✗ |
| Read API v1, keys, redaction, snapshot cursors | ✓ | ✓ `api.test.ts`, `cursor.test.ts` | ✗ |
| OpenAPI conformance | ✓ | ✓ `openapi.test.ts` | n/a |
| Monitoring and request logging | ✓ | ✓ | ✓ live probes responding |
| Web UI (design port), mobile layout | ✓ | ✓ fixture E2E desktop + mobile | ✗ |
| Docker image + compose | ✓ | ✓ CI docker job | n/a |
| CI | ✓ | ✓ two green runs | n/a |
| Live acceptance chain (deploy → write → index → API → restart/interruption) | ✓ (code path) | ✓ fixture only | **Pending human wallet** |

## Open items

- Live walkthrough (WALKTHROUGH.md) once the RPCs answer; then record evidence.
- If Revive rejects the EVM bytecode: PolkaVM (resolc) builds of the samples.
- Live capability probes (fee history, `finalized` tag, `eth_getLogs` range limit) and a verified EVM unit policy.
- Replacement-transaction linking by nonce.
