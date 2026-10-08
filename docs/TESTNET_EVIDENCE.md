# Testnet Evidence (sanitized)

No private keys, seeds, passwords, API secrets, or session tokens appear in this file.

## Summary

| Acceptance check | Status | Evidence |
| --- | --- | --- |
| Verified network identity and capability checks | **Blocked** | Public Portaldot RPCs unavailable (below). No fingerprint was activated. |
| Contract address + deployment transaction hash | **Blocked** | Needs a reachable RPC, a funded wallet, and human approval. |
| Write transaction hash, receipt, execution result, emitted event | **Blocked** | Same. |
| Stored event identity matches receipt (block hash / tx hash / log index) | **Blocked** live · Tested on fixture chain | `apps/web/e2e/fixture-flow.spec.ts`, `apps/worker/test/indexer.test.ts` |
| Authenticated API response returns that record with coverage/freshness | **Blocked** live · Tested on fixture chain | Playground step in `fixture-flow.spec.ts`; `apps/api/test/api.test.ts` |
| Worker restart and RPC interruption recovery without duplicates | **Blocked** live · Tested deterministically | `indexer.test.ts` (backoff/resume, restart, duplicate re-ingestion, concurrent workers) |
| Consumer example reading the real API | Implemented | `examples/read-events.mjs` (not run against live data) |

Do not treat any fixture result as Portaldot evidence. Fixture runs use a local Hardhat chain that reuses chain ID 420420777 and are labelled FIXTURE NETWORK in the UI.

## Read-only network observations (2026-10-08)

Probes recorded by the worker in the local development database (`rpc_probes`):

| Target | Endpoint | Result | Count | First | Last |
| --- | --- | --- | --- | --- | --- |
| EVM | https://testnetv3-eth-rpc.feso-apps.xyz | failed: `HTTP 502` (Cloudflare) | 89 | 2026-10-08T15:07:51Z | 2026-10-08T16:37:42Z |
| Native | wss://testnetv3-node.feso-apps.xyz | failed: connection timed out after 15000 ms (HTTP probe: 502) | 89 | 2026-10-08T15:08:06Z | 2026-10-08T16:37:56Z |

Manual checks at 2026-10-08T14:39Z, 14:40Z, and 16:26Z returned `error code: 502` for `eth_chainId`, `eth_blockNumber`, `net_version`, `web3_clientVersion`, `eth_gasPrice`, `eth_getBlockByNumber`, and `system_chain`. The node console (https://node-console.feso-apps.xyz/) returned HTTP 200. The developer guide still lists the same endpoints (checked 2026-10-08).

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
