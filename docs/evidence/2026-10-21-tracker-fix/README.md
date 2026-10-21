# Receipt tracker: pruned history was reported as a reorg (found and fixed 2026-10-21)

## What happened

About 26 minutes after the live acceptance run, both live transactions (deploy `0x25f03a78…f30f`, block 133019; `store(42)` `0x14ee38e9…fa47`, block 133023) were shown as **"Receipt disappeared (possible reorganization)"**. The node had pruned them: `eth_getTransactionReceipt` returned `null` and `eth_getBlockByNumber` for those heights failed with "State already discarded", while the contract state was intact (`retrieve()` still returned 42). The old tracker:

- re-checked included receipts for 30 minutes, longer than this node keeps state;
- treated any missing receipt as a reorg and **cleared** `block_number`, `block_hash`, and the raw receipt;
- then polled the `reorged_out` hashes every ~4 s without limit.

## Fix (`apps/worker/src/tx-tracker.ts`, migration `0002_receipt_tracking.sql`)

- A missing receipt alone is never a reorg. The tracker looks up the canonical block at the recorded height:
  - **different hash** → real reorg (`reorged_out`); the previous snapshot is kept in the observation's `data`;
  - **pruned** ("State already discarded") or **same hash** → `history_pruned`: inclusion, execution, block number, block hash, and stored receipt are kept; this is not a failure.
- RPC errors or ambiguous answers never change stored data. Retries use bounded exponential backoff (`next_check_at`) and stop after `maxCheckFailures` (`gave_up`).
- Every tracked hash reaches a terminal state: `settled` (confirmation depth reached), `history_pruned`, or `gave_up` (failures or no receipt within the pending window). Terminal states are only reopened by *Check account activity*.
- The confirmation depth is configurable (`PALLETDOCK_RECEIPT_CONFIRMATIONS`, default 24) and is capped at half of the shallowest depth at which the tracker has seen this node prune a block. No retention length is hard-coded.

## Restoring the two transactions (`pnpm --filter @palletdock/worker tx:restore-pruned [--apply]`)

The snapshot was rebuilt from each transaction's own observation log and written only after a dry run:

| Transaction | Source observations (receipt / execution / disappearance) | Corroboration | Node check |
| --- | --- | --- | --- |
| deploy `0x25f03a78…f30f` | #3 / #4 / #10 | contract `deploy_block` 133019 | block 133019 pruned |
| `store(42)` `0x14ee38e9…fa47` | #8 / #9 / #11 | indexed `raw_logs` at block 133023, hash `0xbb34…acde` | block 133023 pruned |

Both are now `included`, `success`, with their original block number and hash, and `tracking_status = history_pruned`. Each has a `restored_from_observations` observation (source `restore:observation-log`) whose `data` holds the provenance; `restore-provenance.json` is an export of those rows. The receipt bodies were cleared by the old tracker and cannot be recovered; the page says so.

After the restart, `last_checked_at` for both stayed unchanged and no tracker log lines were written: polling stopped. The indexer kept following.

## Tests (`apps/worker/test/tx-tracker.test.ts`)

Pruning (snapshot kept, no reorg, polling stops), still-canonical block with a missing receipt, a real reorg with a different hash and re-inclusion, transient RPC failures on the receipt and on the block lookup (data kept, backoff honoured, stop after the limit), settling at the confirmation depth, the pruning-depth cap, giving up after the pending window, and restoring old data (dry run writes nothing; apply records provenance; real reorgs and inconsistent logs are skipped). Reverting the reorg decision to the old behaviour fails five of these tests.

## Screenshots

`live-restored-tx-details-{desktop,mobile}.png` (store(42)) and `live-restored-deploy-tx-details-{desktop,mobile}.png` (deploy): "Node history pruned" notice, inclusion and execution restored, the restore entry in the timeline.
