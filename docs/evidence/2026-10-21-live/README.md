# Live evidence, Portaldot V3 Testnet, 2026-10-21

Raw artifacts behind [TESTNET_EVIDENCE.md](../../TESTNET_EVIDENCE.md). Nothing here contains a private key, seed, password, session token, or read-key secret.

## Acceptance run (`acceptance/`)

Deploy → write → index → read API, driven through the PalletDock web UI. The owner signed with a scripted EIP-1193 signer (`live-run.mjs`) holding their dedicated test key in the local Node process; the key is never printed, written, or sent to the page or the PalletDock server.

| File | Shows |
| --- | --- |
| `main-01-connected.png` | Project `storage-demo-live` on Portaldot V3 (0x190f1ca9), signer `0xfa02…fa8f` connected |
| `main-02-deploy-review.png` | Deployment review: network, signer, fee estimate, storage-deposit dry run, calldata, finality unknown |
| `main-03-deploy-succeeded.png` | Deploy `0x25f03a78…f30f` included in block 133,019, executed (0x1); contract `0xdd982913…11ed` |
| `main-04-write-succeeded.png` | `store(42)` succeeded |
| `main-05-write-details.png` | Transaction details: block 133,023, gas, fee, storage deposit, observed timeline, raw receipt |
| `main-06-indexed.png` | Indexer following, checkpoint 133,023, lag 0, one `NumberChanged` record (log 3) |
| `main-07-api.png` | Read API playground: HTTP 200, `req_928DQZqiuWqf`, decoded event, finality unknown |
| `result-main.json` | Hashes, contract address, project ID, review text, full API response |

## RPC interruption (`rpc-interruption/`)

Development control "Simulate RPC interruption" (the worker's next 3 EVM RPC calls fail). No transaction was sent. `live-interrupt.mjs` watches the local database and the UI.

| File | Shows |
| --- | --- |
| `interrupt-01-before.png` | Source following before the interruption |
| `interrupt-02-needs-attention.png` | *Needs attention*, "RPC connection interrupted" with the error, attempt count, next retry, and the checkpoint it resumes from; lag shown as Unknown |
| `interrupt-03-recovered.png` | Following again, checkpoint advanced |
| `interrupt-04-monitoring.png` | Ops log: control WARN, 2 receipt-check WARNs, indexer ERROR with backoff, "Recovered after 1 failed attempt(s)", next checkpoint |
| `result-interrupt.json` | State timeline from the database, ops logs, raw-log counts and duplicate check before/after |
