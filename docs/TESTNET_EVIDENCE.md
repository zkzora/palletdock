# Testnet Evidence (sanitized)

No private keys, seeds, passwords, API secrets, or session tokens appear in this file.

## Summary

| Acceptance check | Status | Evidence |
| --- | --- | --- |
| Verified network identity and capability checks | **Live-verified (2026-10-17)** | New endpoints; fingerprint active. See "Live identity" and "Live capabilities" below. |
| EVM bytecode accepted by Revive | **Live-simulated (read-only)** | `eth_call` of PalletDockStorage creation code returned code identical to the compiled `deployedBytecode`; `eth_estimateGas` succeeded. Not yet broadcast. |
| Contract address + deployment transaction hash | **Pending human** | Needs your funded wallet and approval (WALKTHROUGH.md). |
| Write transaction hash, receipt, execution result, emitted event | **Pending human** | Same. |
| Stored event identity matches receipt (block hash / tx hash / log index) | **Blocked** live · Tested on fixture chain | `apps/web/e2e/fixture-flow.spec.ts`, `apps/worker/test/indexer.test.ts` |
| Authenticated API response returns that record with coverage/freshness | **Blocked** live · Tested on fixture chain | Playground step in `fixture-flow.spec.ts`; `apps/api/test/api.test.ts` |
| Worker restart and RPC interruption recovery without duplicates | **Blocked** live · Tested deterministically | `indexer.test.ts` (backoff/resume, restart, duplicate re-ingestion, concurrent workers) |
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

## Read-only network observations (2026-10-08, retired endpoints)

Probes recorded by the worker in the local development database (`rpc_probes`):

| Target | Endpoint | Result | Count | First | Last |
| --- | --- | --- | --- | --- | --- |
| EVM | https://testnetv3-eth-rpc.feso-apps.xyz | failed: `HTTP 502` (Cloudflare) | 121+ | 2026-10-08T15:07:51Z | still failing at 2026-10-08T17:29Z |
| Native | wss://testnetv3-node.feso-apps.xyz | failed: connection timed out after 15000 ms (HTTP probe: 502) | 121+ | 2026-10-08T15:08:06Z | still failing at 2026-10-08T17:29Z |

Since 2026-10-08T17:26Z the worker probes with bounded exponential backoff (60 s while healthy; on failure the gap grows to ~30 min, jittered, with no overlapping probes). Observed gaps after a restart: 65 s, 110 s, then 212 s scheduled. A manual `eth_chainId` at 2026-10-08T17:25Z still returned 502.

Manual checks at 2026-10-08T14:39Z, 14:40Z, 16:26Z, and 17:25Z returned `error code: 502` for `eth_chainId`, `eth_blockNumber`, `net_version`, `web3_clientVersion`, `eth_gasPrice`, `eth_getBlockByNumber`, and `system_chain`. The node console (https://node-console.feso-apps.xyz/) returned HTTP 200. The developer guide still lists the same endpoints (checked 2026-10-08).

The Packet's `network.json` records an earlier successful read-only check (2026-10-04) of `eth_chainId` (`0x190f1ca9`) and `system_properties` (tPOTv3, 14 decimals, SS58 42). That is the only positive identity evidence available and it predates this implementation.

## What to record when the RPCs return

Follow [WALKTHROUGH.md](WALKTHROUGH.md) and fill in:

```text
Network fingerprint: genesis=<0x…> chain=420420777 spec=<name> v<version> verified_at=<ISO>
Capabilities: eth_getLogs range limit=<…>, eth_feeHistory=<supported|unsupported>, finalized tag=<…>, reviveApi.call dry-run=<available|unavailable: reason>
EVM unit check: eth_getBalance(<deployer>) raw=<…> vs native free balance of mapped account raw=<…> → denomination <verified|unverified>
Deployment: contract=<0x…> tx=<0x…> block=<n> (<hash>) status=success gasUsed=<…> fee raw=<…>
Write store(42): tx=<0x…> block=<n> (<hash>) status=success
Event: NumberChanged block_hash=<…> tx=<…> log_index=<…> (matches receipt: yes/no)
API: GET /v1/projects/<id>/events → 200 requestId=<…> checkpoint=<n> finality=unknown
Restart: worker stopped at checkpoint <n>, restarted, resumed at <n+1>, canonical duplicates=0
RPC interruption: dev control or network outage at <time>, backoff observed, recovered at <time>, duplicates=0
```
