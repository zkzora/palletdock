# Testnet Evidence (sanitized)

No private keys, seeds, passwords, API secrets, or session tokens appear in this file.

## Summary

| Acceptance check | Status | Evidence |
| --- | --- | --- |
| Verified network identity and capability checks | **Live-verified (2026-10-17)** | New endpoints; fingerprint active. See "Live identity" and "Live capabilities" below. |
| Deployer funding and EVM unit policy | **Live-verified (2026-10-19)** | Native transfer to the mapped account; `eth_getBalance` matches `(free − existential deposit) × 10⁴`. See "Live funding and EVM unit check" below. |
| EVM bytecode accepted by Revive | **Live-verified (2026-10-21)** | Deployed PalletDockStorage; `eth_getCode` is identical to the compiled `deployedBytecode`. Earlier read-only simulation: | `eth_call` of PalletDockStorage creation code returned code identical to the compiled `deployedBytecode`; `eth_estimateGas` succeeded. Not yet broadcast. |
| Contract address + deployment transaction hash | **Live-verified (2026-10-21)** | `0xdd982913cb04f9e438437e2137ba1452e4b211ed`, tx `0x25f03a78…f30f`, block 133019. See "Live acceptance run" below. |
| Write transaction hash, receipt, execution result, emitted event | **Live-verified (2026-10-21)** | `store(42)` tx `0x14ee38e9…fa47`, block 133023, status 0x1, `NumberChanged(previousValue=0, newValue=42)` at log index 3. |
| Stored event identity matches receipt (block hash / tx hash / log index) | **Live-verified (2026-10-21)** | Indexed record and receipt agree on block hash `0xbb34…acde`, tx hash, and log index 3; one canonical `raw_logs` row. |
| Authenticated API response returns that record with coverage/freshness | **Live-verified (2026-10-21)** | `GET /v1/projects/{id}/events` → 200, `req_928DQZqiuWqf`, checkpoint 133023, coverage `following`, lag 0, `finality: "unknown"`. |
| RPC interruption: safe failure, clear error, recovery without duplicates | **Live-verified (2026-10-21)** | Source went *Needs attention* with the error and backoff, then recovered from its checkpoint; 0 duplicates. See "Live RPC interruption" below. |
| Worker restart with a new event while stopped | Not yet run live · Tested deterministically | `indexer.test.ts` (backoff/resume, restart, duplicate re-ingestion, concurrent workers) |
| Consumer example reading the real API | Implemented | `examples/read-events.mjs` (not run against live data) |

Do not treat any fixture result as Portaldot evidence. Fixture runs use a local Hardhat chain that reuses chain ID 420420777 and are labelled FIXTURE NETWORK in the UI.

## Endpoint change (2026-10-17)

Portaldot announced new V3 testnet endpoints and retired the `feso-apps.xyz` hosts (the source of the 502s below). The owner approved switching:

| | Endpoint |
| --- | --- |
| EVM RPC | https://test-evm-rpc-v3.portaldot.dev |
| Native (WebSocket) | wss://test-node-v3.portaldot.dev |
| Node explorer | https://node-console.portaldot.dev/ |
| EVM chain ID | 420420777 (unchanged) |

## Live identity (2026-10-17, `pnpm network:verify`)

| Field | Observed |
| --- | --- |
| Status | **verified**, fingerprint `3fc49db4-0049-448c-82cf-889d71335ed6` active |
| Chain | PortaldotV3 Test |
| Genesis hash | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` |
| Runtime | portaldot-v3, spec 3002, transaction version 2 |
| system_properties | SS58 42, token **tPOT**, 14 decimals |
| EVM | chain ID 420420777, client `eth-rpc/main-fddd431`, head 67,723 at verification |

The live token symbol is `tPOT`, not `tPOTv3` as in the earlier guide; the owner accepted `tPOT` as the expected identity. Two adapter bugs were found and fixed during this check: EVM block 0 is not served by this pruned node (identity no longer requires it), and `system_properties` arrays arrive as codec wrappers (now normalised).

## Live capabilities (2026-10-17, `pnpm network:capabilities`, read-only)

| Capability | Result |
| --- | --- |
| Deploy simulation (`eth_call`, PalletDockStorage creation code) | returned 201 bytes, **identical to compiled deployedBytecode** |
| `eth_estimateGas` for that deployment (unfunded probe sender) | 693,486,325,102,896 (raw; Revive gas, unit semantics unverified) |
| `eth_gasPrice` / `eth_maxPriorityFeePerGas` / `eth_feeHistory` | 42210 raw / 0 / supported |
| `finalized` and `safe` block tags | supported; 3 blocks behind head (PalletDock still reports finality as unknown) |
| `eth_getLogs` | accepted ranges up to 20,000 blocks |
| Block state retention | `eth_getBlockByNumber` served only the last **258 blocks** (≈ 26 min at 6.03 s/block); older blocks fail with "State already discarded" |
| `reviveApi.accountId` | works at a finalized block (probe address mapped to `…deadeeee…`) |
| `reviveApi.call` parameters | origin, dest, value, gas_limit, storage_deposit_limit, input_data (matches the dry-run adapter) |
| Storage-deposit dry run (instantiate, unfunded origin) | dispatch failed (Revive module error 0x17), so reported **unavailable** rather than "charge 0" |
| Pallets present | Babe, Grandpa, Beefy, Balances, Revive, Assets, Uniques, Nfts, … |

Consequences handled in code: an indexer start block outside the retained window is rejected when the source is created, and a checkpoint that ages out while the worker is stopped moves the source to *Recovery required* instead of retrying forever.

## Live funding and EVM unit check (2026-10-19, read-only queries)

The owner funded a dedicated test deployer. Both transfers were signed by the owner in their own wallet; balances below were read with `system.account` (native) and `eth_getBalance` (EVM).

| Step | Observed |
| --- | --- |
| Distribution to the owner's native account `5CohGL5Eyayo7v1BAfA2TWeMzV4bhoDEhPST4iYJT36kK7vF` | `balances.Transfer` from `5E4pUyRTnB7bKmxRiu9TkuQ3WUb61NYHRduEr9eandz8yfEy`, 500 tPOT, block **#91218** |
| Owner → deployer's mapped account `5HiWX46Z3BFKyXrLCUVPguSfAyPcBNd2WU3whcYMf254ZBph` | `balances.Transfer` 100 tPOT (raw `10000000000000000`), block **#91292** |
| Deployer EVM address | `0xfA02532D22cB7e9EF572751BE928efCD2Ac4fA8F` (maps to the account above via `reviveApi.accountId`) |
| Native free balance of the mapped account | `10000000000000000` raw (14 decimals) = 100 tPOT |
| `eth_getBalance(0xfA02…fA8F, latest)` | `99900000000000000000` raw (18 decimals) = 99.9 tPOT |
| `balances.existentialDeposit` | `10000000000000` raw = 0.1 tPOT |

EVM denomination: **verified** on this runtime. `eth_getBalance` = (native free − existential deposit) × 10⁴, i.e. 1 native base unit (10⁻¹⁴ tPOT) = 10⁴ EVM wei, and the EVM view reports the spendable balance above the existential deposit. PalletDock still displays EVM quantities raw.

## Live acceptance run (2026-10-21)

Run by the owner on their machine against the local PalletDock stack (web, API, worker, PostgreSQL) and Portaldot V3 Testnet, through the PalletDock web UI. **Signing:** the owner used a scripted EIP-1193 signer (`live-run.mjs`) holding their dedicated test key in the local Node process, in place of the MetaMask popup. Every request went through PalletDock's own prepare → review → `eth_sendTransaction` → receipt tracking path; no key reached the PalletDock server. A MetaMask-signed run would differ only in the approval UI.

| Step | Observed |
| --- | --- |
| Project | `storage-demo-live` (`3570d90a-c165-4041-aee3-c93f174f1d0a`); UI showed Portaldot V3 · 0x190f1ca9, not FIXTURE NETWORK |
| Deploy review (UI) | network Portaldot V3 Testnet · EVM chain 420420777; signer `0xfA02…fA8F`; fee estimate gas 816,400,923,971,356 × price 35,855; storage deposit **charge 2,878,800,000,000,000 native base units** (`reviveApi.instantiate` dry run); no simulated revert |
| Deploy tx | `0x25f03a786e57dd203bfe0a00da57208d1eaef22594fdfef512b7257cdec1f30f` · nonce 0 · block **133019** (`0x538836c990f6d8981ad13535b091edeba58ddf9c4290e0e8f4c96d8893b7900f`) · status **0x1** · gasUsed 803,829,753,071,626 · price 35,855 · fee raw 28,821,315,796,383,150,230 |
| Contract | `0xdd982913cb04f9e438437e2137ba1452e4b211ed`; `eth_getCode` returns 201 bytes **identical to the compiled `deployedBytecode`** |
| Write `store(42)` | `0x14ee38e9c689159661736d39859cb588aa73678d265cac96cd59f9cbd308fa47` · nonce 1 · block **133023** (`0xbb34e101c516afdbca9c79df2d02d31ebc9e9246652c20eed92baf0713a5acde`) · status **0x1** · gasUsed 107,584,726,716,852 · price 35,850 · fee raw 3,856,912,452,799,144,200 |
| Emitted log | log index 3, topic0 `0x8a0ae77f…bfc7` = `NumberChanged(address,uint256,uint256)`, caller `0xfA02…fA8F`, previousValue 0, newValue 42 |
| Read back | `eth_call retrieve()` → 42 |
| Indexer | source from start block 133019 (deployment block); record indexed at 2026-10-21T14:49:08Z; checkpoint 133023 (`0xbb34…acde`), status `following`, lag 0; exactly one canonical `raw_logs` row for the write |
| Event identity vs receipt | block hash, transaction hash, transaction index 1, and log index 3 match |
| Read API | `GET /v1/projects/3570d90a-…/events` → **200**, requestId `req_928DQZqiuWqf`, `decodeStatus: "decoded"`, args `{caller, previousValue: "0", newValue: "42"}`, fingerprint `3fc49db4…`, `finality: "unknown"` |
| Fee accounting | deployer EVM balance 99,900,000,000,000,000,000 → 67,221,771,750,817,705,570 raw; the difference 32,678,228,249,182,294,430 equals deploy fee + write fee exactly |

Screenshots of each step and the raw result are in [evidence/2026-10-21-live/acceptance](evidence/2026-10-21-live/acceptance/).

## Live RPC interruption (2026-10-21)

Development control *Simulate RPC interruption* on the same source (no transaction sent): the worker's next 3 EVM RPC calls fail. The worker shares one RPC client, so the failures landed on the indexer and the receipt tracker. Times are UTC.

| Time | Observed |
| --- | --- |
| 15:00:27 | Source `following`, checkpoint 133137 (`0xd5d3ae36…ea236`), 1 canonical record, 0 duplicate identities |
| 15:00:30.528 | WARN worker: "Development control: next 3 RPC calls will fail." |
| 15:00:31.114, .117 | WARN transaction: "Receipt check failed; will retry." (2 injected failures) |
| 15:00:32.560 | ERROR indexer: "RPC request failed; retrying in 1 s" (`kind: network`, `eth_blockNumber`, attempt 1); source status `error`, checkpoint unchanged at 133137 |
| UI | *Needs attention* with "RPC connection interrupted · Simulated RPC interruption (development control) during eth_blockNumber · 1 failed attempt(s), next retry 15:00:33 UTC. Indexing resumes from checkpoint 133,137 with no duplicate records." Lag shown as Unknown, not 0. Reconnect offered. |
| 15:00:36.346 | INFO indexer: "Recovered after 1 failed attempt(s); resumed from stored checkpoint."; checkpoint committed at 133138 (`0xf270dec7…7473`); status `following`, attempts 0 |
| After | 1 canonical record, 0 duplicate identities; EVM and Substrate probes kept responding (the control affects only the worker's EVM indexing client) |

Artifacts: [evidence/2026-10-21-live/rpc-interruption](evidence/2026-10-21-live/rpc-interruption/).

## Read-only network observations (2026-10-08, retired endpoints)

Probes recorded by the worker in the local development database (`rpc_probes`):

| Target | Endpoint | Result | Count | First | Last |
| --- | --- | --- | --- | --- | --- |
| EVM | https://testnetv3-eth-rpc.feso-apps.xyz | failed: `HTTP 502` (Cloudflare) | 121+ | 2026-10-08T15:07:51Z | still failing at 2026-10-08T17:29Z |
| Native | wss://testnetv3-node.feso-apps.xyz | failed: connection timed out after 15000 ms (HTTP probe: 502) | 121+ | 2026-10-08T15:08:06Z | still failing at 2026-10-08T17:29Z |

Since 2026-10-08T17:26Z the worker probes with bounded exponential backoff (60 s while healthy; on failure the gap grows to ~30 min, jittered, with no overlapping probes). Observed gaps after a restart: 65 s, 110 s, then 212 s scheduled. A manual `eth_chainId` at 2026-10-08T17:25Z still returned 502.

Manual checks at 2026-10-08T14:39Z, 14:40Z, 16:26Z, and 17:25Z returned `error code: 502` for `eth_chainId`, `eth_blockNumber`, `net_version`, `web3_clientVersion`, `eth_gasPrice`, `eth_getBlockByNumber`, and `system_chain`. The node console (https://node-console.feso-apps.xyz/) returned HTTP 200. The developer guide still lists the same endpoints (checked 2026-10-08).

The Packet's `network.json` records an earlier successful read-only check (2026-10-04) of `eth_chainId` (`0x190f1ca9`) and `system_properties` (tPOTv3, 14 decimals, SS58 42). That is the only positive identity evidence available and it predates this implementation.

## Not yet run live

Covered by deterministic tests (`apps/worker/test/indexer.test.ts`) and still open on the live network:

- Worker restart with a new event emitted while the worker is stopped (`store(43)`), confirming exactly one new canonical record after resume.
