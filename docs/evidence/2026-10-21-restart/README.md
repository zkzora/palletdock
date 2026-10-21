# Live worker restart and tip reorganizations, Portaldot V3 Testnet, 2026-10-21

Nothing here contains a private key, seed, password, session token, or read-key secret.

## Worker restart with a new event while stopped

Run by the owner with `live-restart.mjs` (scripted EIP-1193 signer through the PalletDock UI, as in the acceptance run). Times UTC.

| Step | Observed |
| --- | --- |
| 16:53:16 before | source `following`, checkpoint 134258, 1 canonical record, 0 duplicate identities |
| 16:53:18 | worker stopped (`scripts/dev-services.ps1 stop -Only worker`) |
| 16:53:23 | `store(43)` signed and broadcast: `0x15f4a518c302382e0e04df722eca03df157fcbb9411fdaa39af1ebe3c123ffc1` |
| 16:53:26 | included while the worker was down, read directly from the RPC: block **134261** (`0x701ec6b7…a869b`), status 0x1, 1 log |
| 16:54:26 | after 60 s down: checkpoint 134259 (below the write's block), still 1 canonical record |
| restart | worker started; it resumed from its checkpoint and indexed the write |
| after | checkpoint 134303, **2 canonical records (1 → 2)**, **0 duplicate identities**; new record at block 134261, log index 3, `NumberChanged(previousValue=42, newValue=43)`, block hash matching the receipt; tracker recorded the transaction `included` / `success` and `settled` |

All six checks in `result-restart.json` are true. `eth_call retrieve()` on `0xdd982913…11ed` returns 43 (0x2b).

Harness note: the run's `starting worker` step is timestamped 16:57:52 because the original helper captured the output of `dev-services.ps1 start`, and the worker started by `Start-Process` inherited that pipe, so the call did not return although the worker was already running and indexing. The owner restarted only the verified worker PID to release the runner; no second transaction was sent. `live-restart.mjs` here has the fix (start runs without pipes, then reads `status`); stop and start were re-tested and return in under a second.

## Short reorganizations at the chain tip

The indexer follows the latest block, so it meets this BABE chain's short forks. Between 15:07 and 16:51 it detected and rolled back **20** reorganizations, each at most **3 blocks** deep, with **0 orphaned records** (`indexer-reorgs.json`, from the ops log). A separate 3-minute read-only probe (`tip-reorg-probe.mjs`, result in `tip-reorg-probe-result.json`) saw the hash at height 134366 change while `finalized` was 134364; no hash at or below `finalized` changed. These are real tip reorgs, not a false positive, and the receipt tracker's 24-block confirmation depth is well beyond them.

## Files

| File | Shows |
| --- | --- |
| `restart-01-before.png` | Indexer following before the stop |
| `restart-02-submitted-worker-down.png` | `store(43)` submitted while the worker is down (inclusion not yet recorded by PalletDock) |
| `restart-03-indexed-after-restart.png` | Following again, 2 records, 0 orphaned, reorg epoch 20 |
| `restart-04-transaction.png` | The transaction details after restart |
| `result-restart.json` | Step log and the six checks |
| `indexer-reorgs.json` | The 20 rollbacks with ancestor block and depth |
