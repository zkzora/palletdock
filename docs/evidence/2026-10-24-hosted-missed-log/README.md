# Hosted indexer missed a log at the chain head, 2026-10-24 (UTC)

**Live**, on the hosted deployment (Railway worker, Portaldot V3 Testnet, public RPC
`test-evm-rpc-v3.portaldot.dev`). Found while checking the public `/consumer` demo before
recording. Diagnosed with read-only queries (`BEGIN READ ONLY`) on the hosted database;
nothing was changed there.

## What happened

| Time (UTC) | Observation |
| --- | --- |
| 03:01:18 | Block **168958** (`0x1e7785c4…09fe`) includes `store(45)`: tx `0x11ff67b546fb9c9e5d98e6ebda490e2b3488dab2cdde2ddbaa25b4fa55fc86e3`, `NumberChanged` 44 → 45, log index 3, status success |
| 03:01:25 | Worker commits checkpoint 168958 for the range `168958–168958` (the head at that moment) with **0 logs** (`ops_logs`: "Checkpoint committed at 168958", `logs: 0`) |
| 03:00–03:14 | No reorganization near that block (rollbacks at 02:45 to 168795 and at 03:14 to 169082) |
| later | `eth_getLogs` for the same block and filter returns the log; the source's `event_topics` match its topic0 `0x8a0ae77f…bfc7` |
| 03:54:39 | A later `store(20261024)` at block 169491 (`0x2cf86196b8…`) was indexed and shown by `/consumer` |

The node reported block 168958 as the head before its logs were queryable. The worker took the
empty `eth_getLogs` answer as final and moved the checkpoint past the block, so coverage claimed
the block had no matching event. The local live runs did not hit this because `store(43)` and
`store(44)` were indexed while the worker caught up on blocks that were no longer at the head.

## Fix

- The worker indexes up to head minus `PALLETDOCK_INDEX_LAG_BLOCKS` (default 3, about 18 s).
- For short ranges, each block's `logsBloom` is checked. If it may contain the source's address
  and event topic but `eth_getLogs` returned nothing for that block, the worker does not commit;
  it retries with bounded backoff and only then commits with a WARN (a bloom can give false
  positives). The node's `logsBloom` was checked live: the block with the log matched, empty
  blocks did not.
- Regression tests in `apps/worker/test/indexer.test.ts` ("logs that the node serves later than
  its head"): they failed on the previous engine (the checkpoint moved past the block with the
  log) and pass now; the fixture E2E suite also passes.

## Verified live after the fix

The fixed worker (commit `56b2212`, Railway deployment `32d4aa7c`) kept its checkpoint exactly 3
blocks behind the observed head (170095/170098, 170097/170100, 170099/170102), status `following`,
no errors. The owner then sent `store(46)`:

| Field | Value |
| --- | --- |
| Tx | `0x9d5c8df4cc61fcfb86264dca9c1c0e510d2646c92f7a89ec7908a7cf9e8d20e9`, sender `0xfA02…fA8F` |
| Block | **170355** (`0x5bd96f9347…`), 05:21:36 UTC; `NumberChanged` 20261024 → 46, log index 3 |
| Indexed | 05:21:57 UTC (21 s later, consistent with the 3-block lag) |
| Public `/consumer` (signed out) | value **46**, 2 rows (170355 and 169491) with block hash, tx hash, and log index matching the chain; still 2 rows after a reload; finality *Unknown: not confirmed* |

The missed event at 168958 is not recovered: its blocks are outside the node's retained state
window, so a reindex from the source's start block is rejected.
