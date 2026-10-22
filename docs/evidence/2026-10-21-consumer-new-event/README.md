# Consumer demo: new event while the worker is stopped, 2026-10-21 (UTC)

**Live** run on Portaldot V3 Testnet. The local dev stack (web 3001, API 4101) runs the
race fix (coverage taken from the events snapshot; `meta.coverage[].reorgEpoch`). Only
the worker was stopped and started, by `live-kit/consumer-walkthrough.mjs <out> new-event`.
The API, web, and configuration were not touched during the run. The owner sent the
transaction from the wallet. The script sent nothing on chain and used only the scoped read key, kept
server-side (only its public prefix appears in the screenshots).

Transaction (owner, wallet): `store(44)` on `0xdd982913cb04f9e438437e2137ba1452e4b211ed`

| Field | Value |
| --- | --- |
| Tx hash | `0x56913fdfb57364bcbf36ad2ad6e57e9eb0a27175ccdd791d27b5048e54b004cd` |
| Block | 137978, hash `0xc4b34fb149a845825e70ccc47bea4d2e6676938f19ace801a97c4047eb84def9` |
| Receipt | status `0x1`, 1 log (log index 3), checked once with `eth_getTransactionReceipt` on `test-evm-rpc-v3.portaldot.dev` (tip was 137983) |

| Time (UTC) | Step | Consumer showed | Read API (`/consumer/state`) |
| --- | --- | --- | --- |
| 22:44:41 | 1. Normal | *Up to date*, value **43** (`01-before.png`) | 2 events, 2 unique identities; coverage 133019–137746, reorg epoch 51 |
| 22:44:42 | Worker stopped | | |
| 22:46:14 | 3. Worker stopped | ***Possibly out of date***: "The indexer has not observed the chain for 2 min (checkpoint at block 137747) … the reported lag (0 blocks) dates from that last observation." Value **43** kept (`02-worker-stopped.png`) | 2 events; coverage 133019–137747 |
| 23:08:21 | Owner confirmed `store(44)` included | | |
| 23:08:24 | 3b. Tx included, worker still stopped | *Possibly out of date* (24 min); value still **43**, 2 events: the new event is not claimed before it is indexed (`03-tx-included-worker-stopped.png`) | 2 events; coverage still up to 137747 |
| 23:08:25 | Worker started | | |
| 23:09:18 | 4. Worker back | *Up to date*, value **44** from block 137978 (tx `0x56913fdf…b004cd`, log 3); reconciliation log "1 new and 0 removed" (`04-worker-back.png`) | **3 events, 3 unique**, 0 duplicates dropped; coverage 133019–137993 |
| 23:09:21 | 4b. Page reload | *Up to date*, 44, 3 rows (`05-after-reload.png`) | 3 events, 3 unique |
| 23:09:24 | 4c. Another refresh | *Up to date*, 44, 3 rows (`06-after-refresh.png`) | 3 events, 3 unique |

The worker was down for about 24 min (checkpoint 137747, tip 137983 when it restarted:
236 blocks, inside the 258-block state window measured on this endpoint on 2026-10-17) and caught up with no errors in its
log. Finality stayed *Unknown: not confirmed* throughout.

Files: the screenshots above, `walkthrough.json` (step log with the API summary for each
step), `included.json` (the owner's inclusion confirmation that released the worker start).
