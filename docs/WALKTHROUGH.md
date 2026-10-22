# Live Testnet Walkthrough (human-run)

This is the acceptance run on **Portaldot V3 Testnet**. It needs reachable Portaldot RPCs, a browser EVM wallet you control, test tokens, and your approval of every transaction. Nothing here is automated, and no agent should approve wallet prompts or move funds on your behalf.

## 0. Preconditions

```bash
pnpm db:start            # or docker compose up -d postgres
pnpm db:migrate
pnpm dev:api & pnpm dev:worker & pnpm dev:web
pnpm network:verify      # must print "status": "verified"
```

If `network:verify` fails, stop: check the RPCs, then [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Record the fingerprint (genesis hash, spec version) from Monitoring → Network.

## 1. Wallet and funding

1. Add the network in your wallet: name Portaldot V3 Testnet, RPC `https://test-evm-rpc-v3.portaldot.dev`, chain ID `420420777`, symbol `tPOT`, no explorer.
2. Sign in to PalletDock, create a project, click **Connect wallet**, and approve account access.
3. Overview → **Resolve funding account**. Copy the SS58 account. It comes from `reviveApi.accountId` at a finalized block.
4. Fund that native account with tPOT (the live runtime symbol) via the node console or the Portaldot team's distribution. You sign this transfer yourself.
5. Optional unit check: compare the wallet's EVM balance (shown as raw base units in Contract → Write → Signer) with the native free balance. Record both in TESTNET_EVIDENCE.md. PalletDock keeps EVM amounts raw until this is verified.

## 2. Deploy

Contracts → **Deploy contract** → PalletDockStorage → Continue → Continue to review. Check:

- network `Portaldot V3 Testnet · EVM chain 420420777`, signer = your address;
- the fee estimate is present; the storage deposit is either a dry-run estimate or "Unavailable: reason";
- no simulated revert.

Click **Request signature** and approve in your wallet. Wait for **Execution: Succeeded**, then **Open contract**. Record the contract address, deployment hash, block number and hash.

If the deployment reverts or the fee estimate fails, the bundled EVM bytecode may not be compatible with Revive. Record the error and raw data; do not retry blindly.

## 3. Write and receipt

Contract → **Write** → `store(uint256)` = `42` → Review write → Request signature → approve. Open **View transaction details** and record the hash, block, status, gas used, fee (raw), and the raw receipt.

## 4. Index

> When measured on 2026-10-17, the public Portaldot V3 RPC endpoint kept state for only the last 258 blocks (about 26 minutes); treat it as an observation of that endpoint, not a fixed network property. Configure the indexer **soon after deploying** (start block = deployment block) and keep the worker running. A start block older than the window is rejected; a worker stopped for longer than the window puts the source in *Recovery required* (reindex from a recent block).


Indexer → **Configure log source** → contract PalletDockStorage, event NumberChanged, start block = deployment block → Save. Wait until the record `NumberChanged … newValue=42` appears and coverage passes the write's block. Confirm the record's block hash, tx hash, and log index match the receipt's log.

## 5. API

API → Keys → create a key with `events:read` (copy it once; do not commit it). Then:

```bash
PALLETDOCK_API_URL=http://127.0.0.1:4100 PALLETDOCK_PROJECT_ID=<id> PALLETDOCK_READ_KEY=<key> node examples/read-events.mjs NumberChanged
```

Record the `requestId`, checkpoint, and that `finality` is `unknown`.

## 6. Restart and interruption

1. Stop the worker (Ctrl+C), call `store(43)`, wait one minute (well under the ~26-minute retention window), start the worker again. Confirm the new event is indexed and `SELECT count(*) FROM raw_logs WHERE canonical` grew by exactly one.
2. With `PALLETDOCK_DEV_CONTROLS=1`, Indexer → **Simulate RPC interruption**. Observe *Needs attention* with backoff, then recovery, and no duplicate records.

Write the results into [TESTNET_EVIDENCE.md](TESTNET_EVIDENCE.md) without secrets. Only then mark the live checks complete in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
