# Playground (temporary workspaces)

The playground lets a visitor try the real PalletDock workspace without registering. Selecting **Try Playground** opens `/playground`. That page explains the temporary workspace and lists the bundled templates; nothing is created until the visitor presses **Start temporary workspace**. The visitor then lands in the normal `/app` dashboard: the same sidebar (Overview, Contracts, Transactions, Indexer, API, Monitoring, Settings), the same pages, and the same `SignDialog`. Additions are a *Temporary playground* indicator showing the real expiry time, a compact guided checklist, and a **Save workspace** action.

Public guest creation is **off by default** (`PALLETDOCK_PLAYGROUND_ENABLED=0`). When it is off, `/playground` states that the playground is not enabled on that deployment.

## Identity and authorization

- **Guest principal.** A guest is an `owners` row with `kind='guest'`, `email` and `password_hash` both NULL, and a fixed `guest_expires_at` (migration `0004_guest_playground.sql`). A CHECK constraint keeps guests from carrying credentials and keeps accounts from carrying an expiry. Password login, signup duplicate checks, and the owner bootstrap CLI all select by email, so they can never match a guest.
- **Session.** `POST /auth/playground` issues a random 32-byte token. Only its SHA-256 hash is stored, in the existing `sessions` table, along with a fresh CSRF token. The cookie is the existing `palletdock_session`: HttpOnly, `SameSite=Strict`, `Secure` when `SESSION_COOKIE_SECURE=1` (which the API requires in production). It expires at the guest expiry. Activity never extends a guest workspace or its session.
- **Explicit start only.** `GET /auth/playground-config` and page rendering have no side effects. `POST /auth/playground` requires the header `x-palletdock-intent: start-playground`. A third-party page cannot add that header without a CORS preflight, and only `WEB_ORIGIN` passes the preflight.
- **Existing sessions are kept.** If the request carries a valid account session, nothing is created and the account stays signed in. On `/playground` the account is offered **Open workspace** or **Create a sample project** instead. The sample project goes through the normal `POST /workspace/projects` route with `playground: true`, so it gets the same checklist. A still-valid guest session gets its own workspace back, so a double click creates nothing.
- **Same ownership and CSRF rules.** Every workspace route still goes through `sessionAuth`, `requireCsrf`, and the project ownership check. Guests are separate owners, so guest A gets `404` for guest B's resources.
- **Session kind.** `/auth/me` returns `session: { kind: 'account' | 'guest', expiresAt }`, `owner.email` (null for guests), `owner.displayName` (`Temporary workspace`), and, for guests, the limits and current usage. The private `/consumer` demo accepts only `kind: 'account'`.
- **Wallets.** Connecting a wallet only selects a signer. It never authenticates and never establishes workspace ownership. The wallet is not requested on page load (only the silent `eth_accounts` restore that existed before). Wallet secrets never reach the server. MetaMask is the recommended wallet: Rabby and some other wallets do not support Portaldot V3 and can fail when adding the network or signing, so the signer dialog recommends MetaMask and names a detected non-MetaMask wallet.

## Limits (server-enforced)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PALLETDOCK_PLAYGROUND_ENABLED` | `0` | `1` enables public guest creation |
| `PALLETDOCK_PLAYGROUND_LIFETIME_MINUTES` | `360` (6 h) | Fixed workspace and session lifetime, 15–1440 |
| `PALLETDOCK_PLAYGROUND_CAPACITY` | `100` | Unexpired guest workspaces at once, deployment-wide |
| `PALLETDOCK_PLAYGROUND_STARTS_PER_HOUR` | `3` | Starts per visitor address per hour |
| `PALLETDOCK_PLAYGROUND_MAX_CONTRACTS` | `2` | Tracked contracts per guest |
| `PALLETDOCK_PLAYGROUND_MAX_INDEXER_SOURCES` | `1` | Indexer sources (not deleted) per guest |
| `PALLETDOCK_PLAYGROUND_MAX_READ_KEYS` | `1` | Active read keys per guest |
| `PALLETDOCK_PLAYGROUND_MAX_ACTIONS` | `150` | Mutating or RPC-backed workspace requests per guest workspace |

- Each guest has one project. Creating more projects, uploading custom artifacts (only the bundled templates can be deployed), and archive/restore return `403 GUEST_RESTRICTED` with the reason, and the UI explains the restriction rather than hiding the page.
- **Starts per address** are counted in the persistent `guest_starts` table. The address comes from `client-ip.ts`: the visitor address forwarded by the web proxy is trusted only together with `PALLETDOCK_PROXY_SECRET`; otherwise the connection address is used. An arbitrary `X-Forwarded-For` header is ignored. The address is stored only as a keyed hash.
- **Starts and capacity** are checked inside a single transaction that holds an advisory lock, so parallel starts cannot exceed either limit.
- **Contract, source, and key quotas** are checked inside the transaction that inserts the row, after `SELECT … FOR UPDATE` on the project row, so parallel requests are serialized. The contract quota counts tracked contracts plus deployments that are submitted, or prepared in the last 30 minutes. A deployment that was broadcast is still tracked from its receipt, because hiding a real on-chain contract would be worse than exceeding the count.
- **The action budget** is a single conditional `UPDATE … WHERE guest_actions < max`. Recording a wallet submission result never consumes it, so a real broadcast hash is always recorded.
- **Read keys** of a guest expire no later than the workspace (`LEAST(requested, guest_expires_at)`), including keys made with **Replace**.

No CAPTCHA or new platform service was added. The controls protect the database, API, and RPC budget.

## Expiry

Expiry is enforced at authorization and at worker selection, not only by cleanup:

- `sessionAuth` rejects an expired guest with `401 WORKSPACE_EXPIRED`. The workspace shell also switches to an expiry page at the exact `expiresAt`. That page explains that off-chain access ended, that contracts and transactions remain on the testnet, and offers **Start a new playground**.
- `keyAuth` rejects keys whose project belongs to an expired guest.
- The indexer `claim` and the commit `fence` exclude expired guests, so an in-flight commit is discarded (`fenced`). The receipt tracker does not select their transactions.
- A worker maintenance pass (every 60 s, at most 10 batches of 25) closes expired guests. It revokes their sessions and read keys, stops their indexer sources and increments their generation (`desired_state='archived'`, `status='stopped'`), writes one ops log per project, and sets `guest_closed_at`. It is idempotent and safe with several worker instances (`FOR UPDATE SKIP LOCKED`).

What visitors are told: temporary off-chain access expires; deployed contracts and transactions remain on the testnet; clearing browser cookies loses access to an unsaved workspace (it has no password); PalletDock cannot reverse on-chain actions.

### Retained records and the later purge

This iteration revokes access and shuts down resources, but deletes nothing. The guest `owners` row, project, artifacts, contracts, ABI versions, transactions and observations, indexer sources, checkpoints, raw and decoded logs, and revoked key metadata are kept. `request_logs` and `ops_logs` follow the existing 30-day retention. A later purge should run in one transaction per guest and only for guests with `guest_closed_at` older than an agreed grace period. Tables must be deleted children-first because foreign keys do not cascade: `decoded_events` → `raw_logs` → `block_headers`, `indexer_checkpoints`, `indexer_jobs`, `worker_commands`, `ops_logs` (by source or transaction) → `indexer_sources` → `transaction_observations` → `transactions` → `abi_versions` → `contracts` → `artifacts` → `request_logs` and `api_keys` → `projects` → `sessions` → `owners`. `guest_starts.owner_id` is set to NULL automatically. Test it on a database copy first.

## Templates and the guided checklist

Template definitions live once in `packages/contracts/playground.ts` and are served by `GET /auth/playground-config`. Every value was checked against the artifact ABI and the Solidity source.

| Template | Constructor | Read | Example write | Event |
| --- | --- | --- | --- | --- |
| Storage (`PalletDockStorage`) | none | `retrieve()` | `store(42)` | `NumberChanged(caller, previousValue, newValue)` |
| Payments (`PalletDockPayments`) | none (deployer becomes the immutable owner) | `totalReceived()` | `pay(orderRef)` with an amount the visitor must type; the sample order reference is the ASCII text `pd-sample-order-` plus 8 hex characters of the project id, zero-padded to `bytes32` | `PaymentReceived(payer, orderRef, amount)` |
| ERC-20 (`PalletDockToken`) | `initialSupply = 1000000000000000000000` (1,000 PDTT at 18 decimals, minted to the deployer) | `totalSupply()` | `transfer(to, 1000000000000000000)`; the recipient must be entered and be a valid address | `Transfer(from, to, value)` |
| ERC-721 (`PalletDockCollectible`) | none | `nextTokenId()` | `mint(to)` prefilled with the connected account; the contract lets anyone mint to any address | `Transfer(from, to, tokenId)` |

### Shared template contracts (no deployment)

Deploying on Portaldot V3 Testnet needs a storage deposit for the contract code, included in the EVM gas: `revive.depositPerByte` is 0.06 tPOT per byte plus a 30% code-hash lockup (runtime constants read on 2026-10-31). Estimated from a funded account that day, deploying cost about 13 tPOT for Storage, 77 tPOT for Payments, and 343 tPOT for ERC-721. A write to an existing Storage contract was about 0.016 tPOT. So the operator can deploy each template once and share it:

```text
PALLETDOCK_PLAYGROUND_SHARED_STORAGE=0x<address>:<deployment block>[:0x<deployment tx hash>]
PALLETDOCK_PLAYGROUND_SHARED_PAYMENTS=…   PALLETDOCK_PLAYGROUND_SHARED_ERC20=…   PALLETDOCK_PLAYGROUND_SHARED_ERC721=…
```

- `GET /auth/playground-config` lists the shared copy per template (`sharedContract`, or `null`). The `/playground` page and the guide mark those templates *Ready: shared contract, no deployment*; the others say the visitor deploys them.
- Starting a workspace on such a template, switching to it, or **Use shared contract** calls `POST /workspace/projects/:id/playground/shared-contract`. It is idempotent. Before tracking the contract, the server reads its runtime code at the current head and compares it with the bundled artifact's `deployedBytecode`. Bytes may differ only inside a run of 32 or more zero bytes in the artifact, where solc leaves an immutable's placeholder (Payments' owner). Any other difference refuses the contract. The check block is recorded and shown in the checklist.
- A shared copy never counts toward the guest's contract quota, so the visitor can still deploy or import two contracts of their own. The visitor's own deployed copy of the same template takes precedence in the checklist.
- **Indexing** a shared copy starts at the block where this workspace added it, not at its deployment block: every earlier event came from other visitors. The response returns that uncovered range and it is logged as INFO in Monitoring.
- On the shared ERC-20 the visitor holds no PDTT, so the guided write is `approve(spender, 1 PDTT)` with the event `Approval(owner, spender, value)` instead of `transfer`. Payments sent to the shared Payments contract stay in it and only the operator (its owner) can withdraw them; the template notes say so.
- A shared Storage, Payments, or ERC-721 contract is written by every visitor, so `retrieve()`, `totalReceived()`, and `nextTokenId()` include other visitors' actions. The checklist still completes only from this visitor's own transaction hash.

`withdraw(to)` on Payments is owner-only and is explained but never started automatically. The checklist (`GET /workspace/projects/:id/playground`) has six steps: choose template → deploy → read → example interaction → indexed event → application API query. Each state is derived from records the server or worker observed:

- **Deploy** (titled *Use the contract* with a shared copy) is done when the worker tracked the template's contract from a successful deployment receipt, or when the shared copy was added after its code check.
- **Read** is done when the server decoded a successful `eth_call` on that contract (stored in `projects.playground_progress`).
- **Interaction** is done when the template's write has a successful receipt. Rejected, unconfirmed, reverted, or reorganized submissions show as *needs attention* with the reason, and nothing is resent.
- **Event** is done when the template event from that write's transaction hash is indexed and decoded.
- **API** is done when `/v1/projects/:id/events` answered 200 to a read key after the event was indexed. Creating a key alone does not complete it.

Pressing a button never completes a step. All six steps run through the same project and contract. Refreshing reloads the same state.

**Indexer setup.** Once the contract exists, the guide offers **Start indexing**. It calls `POST /workspace/projects/:id/playground/indexer-source`, which is explicit and idempotent: a repeated call, even in parallel, returns the existing source. It starts at the recorded deployment block, after checking that the node still serves that block. If the block has been pruned, the response is `409 HISTORY_UNAVAILABLE` with the head and the uncovered range. The visitor may then choose a later start block explicitly; the range left uncovered is returned and logged as a WARN. It is never moved silently. The source uses the normal worker, generation fencing, the default 3-block head delay, and the bloom-but-no-log guard. The delay is not finality, which stays *Unknown: not confirmed*.

**Signing.** The review dialog is labelled **Real testnet transaction**. On the fixture stack it reads *FIXTURE NETWORK transaction · local test chain, not Portaldot*. It shows the value, fee, and deposit estimates, blocks signing if the wallet account changed after review or if the balance is known to be below value + estimated maximum fee, switches or adds the chain before signing, and records rejection and uncertain submissions without resending.

## Saving the workspace

**Save workspace** opens `/signup`. For a guest session, that page becomes *Save your workspace* and posts `/auth/signup` with `claimGuest: true` plus the guest's CSRF token. The deployment's open/invite policy and rate limit apply as for any signup. In one transaction the server locks the current, unexpired guest; sets `kind='account'`, the email, and a scrypt password hash; clears the expiry; revokes every guest session; and issues a new session and CSRF token. The project, contracts, transactions, sources, keys (with their original expiry), and checklist progress stay attached to the same owner id.

- An invalid invite code, missing CSRF, or an expired guest changes nothing.
- A duplicate email rolls back and returns `409`, explaining that saving into an existing account is not supported yet. The guest session keeps working.
- With registration disabled, the page states that saving is unavailable on this deployment (`403 REGISTRATION_DISABLED`).

## Local walkthrough

1. Add `PALLETDOCK_PLAYGROUND_ENABLED=1` to `.env`, then run `pnpm db:start`, `pnpm db:migrate`, `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web`.
2. Open `http://127.0.0.1:3001/` → **Try Playground** → choose **Storage** → **Start temporary workspace**.
3. With `PALLETDOCK_PLAYGROUND_SHARED_STORAGE` set, the shared contract is added at start. Otherwise use **Open deploy** → connect MetaMask on Portaldot V3 Testnet that holds test tPOT → review the *Real testnet transaction* → sign.
4. **Start indexing** → **Open retrieve()** → **Read** → connect MetaMask → **Prepare store(uint256)** → review and sign → wait until the event step is observed → **Open API playground** → **Create read key for this workspace** → **Send request**. Signing sends a live testnet transaction; use the fixture stack below to avoid that.
5. **Save workspace** to keep it, or let it expire.

To try everything without live transactions, run `pnpm e2e:stack` (fixture Hardhat chain, labelled FIXTURE NETWORK, playground enabled) and `pnpm --filter @palletdock/web exec playwright test -c playwright.fixture.config.ts fixture-playground`.

## Verification status (2026-10-30, shared contracts added 2026-10-31; local Windows working copy)

| Check | Result |
| --- | --- |
| `pnpm typecheck` | all 7 packages pass |
| `pnpm --filter @palletdock/contracts check` | committed artifacts unchanged (exit 0) |
| `pnpm test` (2026-10-31) | 21 files, 200 tests pass. Shared contracts: config and parsing, code check against the artifact (exact or immutables only, mismatch refused), idempotent add outside the contract quota, indexing from the block where the workspace added it with the uncovered range logged, ERC-20 approve variant. Earlier run (2026-10-30): 192 tests. New: `apps/api/test/playground.test.ts` (21 tests: explicit start only, hashed token and cookie flags, account session kept, trusted-address start limit and capacity under concurrency, guest A/B isolation, CSRF, restrictions, concurrent key/contract/source/action quotas, idempotent source setup, unavailable-history recovery, observed-only checklist, expiry before maintenance, conversion success and failures, no credentials in responses or request logs) and `apps/worker/test/guest-expiry.test.ts` (5 tests: claim exclusion, commit fenced when a guest expires mid-claim, no receipt polling, idempotent multi-instance maintenance, credential constraint) |
| `pnpm --filter @palletdock/web build` | passes; `/playground` is static |
| Fixture browser E2E, 2026-10-31 | The stack deploys a shared Storage first. `fixture-playground.spec.ts` passes on desktop (8 tests): Storage on the shared contract with no deployment, through read, `store(42)`, indexed `NumberChanged`, `/v1` events, refresh, and Save workspace; the other templates deploy their own copy. The flow, payments, consumer, and signup specs pass on desktop. |
| Fixture browser E2E, 2026-10-30 (`pnpm e2e:stack`, Hardhat chain labelled FIXTURE NETWORK, fixture wallet) | `fixture-playground.spec.ts` passes on desktop: Storage end to end through deploy, read, `store(42)`, indexed `NumberChanged`, `/v1` events, refresh, and Save workspace; Payments, ERC-20, and ERC-721 through their indexed events; wrong chain switched plus wallet rejection completing nothing; expiry page; account kept with a guided sample project. Mobile layout test passes. The existing fixture specs (flow, payments, consumer, signup, screens) pass |

All of this uses local fixtures. On the hosted deployment (2026-10-31), migration `0004` is applied and starting a workspace was checked; no playground transaction there has been recorded yet. The existing Storage contract `0xdd982913cb04f9e438437e2137ba1452e4b211ed` (deployed in block 133019) has runtime code identical to the bundled artifact, so it can be the hosted shared Storage.
