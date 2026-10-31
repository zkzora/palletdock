# PalletDock

**From contract transactions to application data.**

A developer workspace for Solidity builders on **Portaldot V3 Testnet**. Deploy or connect a contract, track its transactions, index its events, and expose the data to your application from one project.

[Website](https://palletdock.vercel.app/) · [Try Playground](https://palletdock.vercel.app/playground) · [How to test](#how-to-test) · [Create an account](https://palletdock.vercel.app/signup) · [Documentation](https://palletdock.vercel.app/docs) · [Testnet evidence](docs/TESTNET_EVIDENCE.md)

## How to test

The hosted app runs at **[palletdock.vercel.app](https://palletdock.vercel.app/)** on Portaldot V3 Testnet: web on Vercel, API and worker on Railway. Paths 1 and 2 need no install, no account, no wallet, and no test tokens.

### 1. Open the workspace (1 minute, nothing needed)

1. Open **[palletdock.vercel.app/playground](https://palletdock.vercel.app/playground)**, choose **Storage**, and click **Start temporary workspace**.
2. You land in the real dashboard as a temporary guest, with no email or password. The workspace lasts 6 hours.
3. Follow the guide at the top of the page. Storage is ready to use: a shared copy is already deployed on the testnet and added to your workspace, so there is nothing to deploy. Reading it is free. Every area can be opened: Contracts, Transactions, Indexer, API, and Monitoring.
4. The one paid step is the example write, `store(42)`, at about 0.02 tPOT (estimated on 2026-10-31). It needs a wallet with test tPOT (path 3). The other templates are deployed from your own wallet, which needs a storage deposit for the contract code: about 77 tPOT for Payments and 343 tPOT for ERC-721 (estimated on 2026-10-31).

**Test accounts:** none are needed. The Playground replaces a shared login, and nobody else sees your workspace. To keep it, click **Save workspace**: that creates your own account (email and password) and keeps everything. You can also [sign up](https://palletdock.vercel.app/signup) directly; registration is open.

### 2. Check the recorded testnet run (nothing needed)

On 21 October 2026 the full chain ran on Portaldot V3 Testnet: deploy `PalletDockStorage`, then `store(42)`, then the indexed `NumberChanged` event, then the `/v1` API answer. No block explorer is confirmed for this testnet, so check the transactions on the public RPC:

```bash
# store(42): status 0x1, block 0x2079f (133023), one NumberChanged log from 0xdd98…11ed
curl -s https://test-evm-rpc-v3.portaldot.dev -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x14ee38e9c689159661736d39859cb588aa73678d265cac96cd59f9cbd308fa47"]}'

# Deployment: contractAddress 0xdd982913cb04f9e438437e2137ba1452e4b211ed
curl -s https://test-evm-rpc-v3.portaldot.dev -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x25f03a786e57dd203bfe0a00da57208d1eaef22594fdfef512b7257cdec1f30f"]}'
```

Block hashes, the indexed record, the API request ID, and screenshots are in [Testnet evidence](docs/TESTNET_EVIDENCE.md).

### 3. Run the full flow yourself (MetaMask and test tPOT)

1. **Install [MetaMask](https://metamask.io/download/).** It is the tested wallet; Rabby and some other wallets do not support Portaldot V3.
2. **Add the network.** In the Playground workspace, click **Connect wallet**, then **Switch / add Portaldot V3** and approve in MetaMask. To add it by hand instead:

   | Field | Value |
   | --- | --- |
   | Network name | Portaldot V3 Testnet |
   | RPC URL | `https://test-evm-rpc-v3.portaldot.dev` |
   | Chain ID | `420420777` |
   | Currency symbol | `tPOT` |
   | Block explorer | leave empty |

3. **Get test tPOT.** There is no faucet. The Portaldot team hands out tPOT on request in its Discord, once every 24 hours, so request it a day ahead.
   1. In PalletDock, open **Overview → Account mapping → Resolve funding account**. It shows your MetaMask address and the native account (SS58) that the runtime maps to it.
   2. Post a request in the Portaldot Discord with both addresses. A request template is in [Funding](https://palletdock.vercel.app/docs/funding).
   3. When the tPOT arrives, the signing review shows your balance. Signing stays blocked while the balance is too low for the fee.
4. **Run the guide** on Storage. Click **Start indexing**, run `retrieve()`, then review the **Real testnet transaction** for `store(42)` and sign it. When the event is indexed, open the API playground and send the request. A step turns done only from what was observed: a receipt, a decoded event, or a `200` API answer. Clicking a step never marks it done.

### 4. Run it locally without test tokens

A local fixture stack runs the whole flow on a **local Hardhat chain** (labelled **FIXTURE NETWORK**, not Portaldot) with a scripted test wallet. It needs Node.js 22+, pnpm 11+, and Chrome.

```bash
pnpm install --frozen-lockfile
pnpm --filter @palletdock/web exec playwright install chrome
pnpm e2e:stack     # terminal 1: chain, database, API, worker, and web on ports 3199/4199/8599
pnpm --filter @palletdock/web exec playwright test -c playwright.fixture.config.ts fixture-playground   # terminal 2
```

The second command runs the Playground journeys in a browser. Storage goes end to end: deploy, read, write, indexed event, API query, and Save workspace. Payments, ERC-20, and ERC-721 run through their indexed events.


![PalletDock workspace showing an active event indexer, checkpoint, coverage, and decoded contract event](docs/evidence/2026-10-21-live/acceptance/main-06-indexed.png)

*Actual workspace from the recorded 21 October 2026 testnet run, using a local application stack connected to Portaldot V3. This screenshot shows that run's state, not the current hosted deployment.*

**Status:** working testnet MVP, with a hosted web app, API, worker, and private database. To use the workspace, start a temporary [Playground](https://palletdock.vercel.app/playground) with no account, or [create an account](https://palletdock.vercel.app/signup) with an email and password; each workspace sees only its own projects, contracts, transactions, and API keys. Writes need a browser wallet on Portaldot V3 Testnet (EVM chain 420420777) with test tPOT. The [public read-only integration example](https://palletdock.vercel.app/consumer) needs no account; it demonstrates an application consuming PalletDock's API. To run your own stack instead, follow [Quick start](#quick-start).

## The problem

A deployed contract still needs an application around it. Solidity developers must keep artifacts and ABIs, interpret receipts, run an indexer, expose data, and investigate failures across separate tools. A successful transaction does not mean the application's indexed data is current.

PalletDock connects those steps in one workspace and makes transaction outcomes, indexing progress, and freshness visible. Inclusion, execution, indexing, and finality remain separate facts.

## A connected developer workflow

**Project → Contract → Transaction → Indexed event → Application API**

1. **Create a project.** Keep contracts, transactions, event sources, and API access in the same network context.
2. **Deploy or import a contract.** Validate its artifact and ABI, inspect reads, and review writes before wallet signing.
3. **Track the outcome.** Inspect the receipt, execution result, indexing status, and receipt-tracking condition.
4. **Index selected events.** Follow checkpoints, decoded records, reorganization handling, and recovery conditions.
5. **Connect your application.** Query project data through scoped read keys and monitor the worker and RPC observations.

See the [testnet walkthrough](docs/WALKTHROUGH.md) for the detailed steps.

## What is implemented

| Workspace area | What you can do |
| --- | --- |
| Projects | Create and switch projects, export without secrets, archive, and restore inside an owner-isolated workspace |
| Contracts | Deploy or import contracts, manage ABI versions, call reads, and prepare wallet-signed writes (including native value for `payable` functions) with supported estimates and error decoding; bundled samples: Storage, ERC-20, ERC-721, and Payments |
| Transactions | Inspect inclusion, execution, indexing, finality, and tracking conditions, including pruned receipts and reorganized transactions |
| Indexer | Configure EVM event sources, inspect raw and decoded logs, follow checkpoints, and see retry or recovery-required states |
| API | Query contracts, transactions, events, and indexer status through scoped, expiring, revocable keys and snapshot pagination |
| Monitoring | Inspect RPC observations, worker activity, indexing progress, and operational logs |
| Playground | **Try Playground** opens a temporary workspace with no email or password: the same dashboard, one project, a bundled template, and a guided checklist from deployment to the project API. Enabled on the hosted deployment; off by default when self-hosting (`PALLETDOCK_PLAYGROUND_ENABLED=1`) |

The [consumer example](docs/CONSUMER.md) is a separate app-side reader of the public `/v1` API. It shows how another application can display indexed values, coverage, freshness, and unknown finality while keeping its read key server-side.

The **payments sample** (`PalletDockPayments`) accepts tPOT through `pay(bytes32 orderRef)` and emits `PaymentReceived(payer, orderRef, amount)`, so an application can match each payment to its order through indexed events; the deployer withdraws with `withdraw(to)`. It is verified on the local fixture chain (deploy, pay with value, indexed event, withdraw) and has not yet been run on Portaldot V3 Testnet, where the existential deposit and contract storage deposit may affect withdrawing the full balance.

## Why Portaldot V3

The current integration combines Solidity contract workflows with V3's native runtime context:

| V3 capability | How PalletDock uses it |
| --- | --- |
| EVM execution and JSON-RPC | Solidity deployment, contract reads and writes, receipt tracking, and event queries |
| `reviveApi.accountId` | EVM-to-native account mapping with block and runtime provenance for account and funding context |
| Supported Revive runtime dry runs | Storage-deposit information before signing; unavailable estimates stay explicitly unavailable |
| Native genesis, EVM chain ID, and runtime identity | A pinned network fingerprint; an identity mismatch halts work until an explicit network-reset migration |
| Runtime metadata, including `revive.nativeToEthRatio` | Verification of EVM denomination before displaying interpreted amounts; raw quantities remain lossless |

These integrations are documented with [network setup](docs/NETWORK.md) and [live capability measurements](docs/TESTNET_EVIDENCE.md#live-capabilities-2026-10-17-pnpm-networkcapabilities-read-only). General contract and indexing workflows can be adapted to other networks; the implemented account mapping, deposit diagnostics, and unit policy target the verified V3 runtime.

## Testnet evidence

The demonstration contract is **PalletDockStorage** at `0xdd982913cb04f9e438437e2137ba1452e4b211ed` on EVM chain **420420777**.

| Run | Verified result | Evidence |
| --- | --- | --- |
| Deploy → write → index → API, 21 Oct 2026 | Deployed bytecode matched the compiled artifact; `store(42)` executed; indexed event identity matched the receipt and was served through the read API | [Acceptance run and screenshots](docs/evidence/2026-10-21-live/) |
| RPC interruption and worker restart, 21 Oct 2026 | Injected RPC failures recovered from the checkpoint; a write sent while the worker was stopped appeared once after restart | [Interruption](docs/evidence/2026-10-21-live/rpc-interruption/) · [Restart](docs/evidence/2026-10-21-restart/) |
| App-side stale state and recovery, 21 Oct 2026 | Consumer retained 43 with a stale warning, then displayed 44 with three unique events; reload and refresh retained the count | [Recorded consumer run](docs/evidence/2026-10-21-consumer-new-event/) |
| Tip reorganizations, 21 Oct 2026 | Twenty observed tip reorganizations, at most three blocks deep, were rolled back without orphaned records in the recorded run | [Reorganization evidence](docs/TESTNET_EVIDENCE.md#live-tip-reorganizations-2026-10-21) |
| Hosted indexing after the head-log fix, 24 Oct 2026 | `store(46)` at block 170355 was indexed with matching event identity; the public consumer retained its two rows after reload | [Hosted verification and remaining gap](docs/evidence/2026-10-24-hosted-missed-log/) |

The 21 October runs used a local application stack connected to the real testnet. Deployment and the first writes were signed through the UI using a scripted EIP-1193 signer, rather than a MetaMask approval popup. The 24 October verification used the hosted Railway worker. [Full hashes, measurements, and signing details](docs/TESTNET_EVIDENCE.md) are retained separately.

**Known historical gap:** the hosted worker previously missed `store(45)` when the RPC exposed a head block before its logs were queryable. The fix adds a default three-block indexing delay and bounded bloom-based checks for suspicious empty results in short ranges. That event was not recovered after its history aged out. The mitigation and a subsequent successful write are documented; complete history and zero data loss are not guaranteed.

## Architecture and hosting

| Component | Implementation | Hosted demo |
| --- | --- | --- |
| Web | Next.js, React, Tailwind CSS | Vercel |
| API | Fastify, TypeScript, viem | Railway |
| Worker | Independent event indexer, receipt tracker, and network probes | Railway; stays running |
| Database | PostgreSQL, transactional checkpoints and event commits | Railway; private network |

The web proxies API requests through `/backend/*`. The API and worker share PostgreSQL. Wallet signing stays on the client; the consumer's scoped read key stays on the web server.

See [architecture](docs/ARCHITECTURE.md) and the [hosted deployment guide](docs/DEPLOYMENT.md) for service configuration, secrets, migrations, and acceptance checks.

## Quick start

Requirements: **Node.js 22+** and **pnpm 11+**. Local PostgreSQL is provided by `embedded-postgres` or Docker.

From the repository root:

```bash
pnpm install --frozen-lockfile
cp .env.example .env
```

Set `PALLETDOCK_CURSOR_SECRET` in `.env` to a fresh random value. The example configuration uses API port **4100**, web port **3000**, and database port **55432**.

Start PostgreSQL in its own terminal and leave it running:

```bash
pnpm db:start
# Alternatively: docker compose up -d postgres
```

In another terminal, initialize the database and create the local owner:

```bash
pnpm db:migrate
pnpm owner:create --email you@example.com
```

The owner command prompts for a password of at least 12 characters. Running it again for the same email resets only that account and revokes only its sessions.

**Playground.** With `PALLETDOCK_PLAYGROUND_ENABLED=1`, `/playground` starts a temporary workspace without an account. It lasts 6 hours from the start (never extended) and holds one project, up to 2 contracts, 1 indexer source, and 1 read key. Deploying and writing are real testnet transactions signed in the visitor's wallet, so they need test tPOT. **Save workspace** converts it into an account through the registration flow below. Lifecycle, limits, expiry, and conversion: [docs/PLAYGROUND.md](docs/PLAYGROUND.md). On the hosted deployment, starting a workspace was checked on 2026-10-31. The signed deploy, write, index, and API journey is verified on the local fixture stack; a hosted run on Portaldot V3 Testnet is not recorded yet.

Self-service registration is disabled by default. Set `PALLETDOCK_SIGNUP_MODE=invite` with a server-side `PALLETDOCK_SIGNUP_INVITE_CODE` of at least 16 characters to let users create their own isolated accounts at `/signup`. `open` mode removes the code requirement, but should not be exposed long-term without deployment-level CAPTCHA, quotas, and abuse monitoring. The hosted demo runs in `open` mode during hackathon judging, with per-visitor sign-up and sign-in rate limits; it returns to `invite` or `disabled` afterwards.

Start the API and worker in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:worker
```

Start the web app in another terminal. Export the API URL explicitly so the Next.js proxy uses the matching port:

```bash
PALLETDOCK_API_URL=http://127.0.0.1:4100 pnpm dev:web
```

On PowerShell, use:

```powershell
$env:PALLETDOCK_API_URL = 'http://127.0.0.1:4100'
pnpm dev:web
```

Open [the local workspace](http://127.0.0.1:3000/app) and sign in with the owner you created. Follow the [walkthrough](docs/WALKTHROUGH.md) to configure a recent event source. `pnpm network:verify` performs an optional read-only network identity probe.

### Windows service helper

After starting the database separately, the helper can manage API, worker, and web processes. With the example API port:

```powershell
$env:PALLETDOCK_API_URL = 'http://127.0.0.1:4100'
powershell -File scripts/dev-services.ps1 start
```

Replace `start` with `stop`, `restart`, or `status`. Add `-Only worker` or `-Only api,web` to select services. PIDs and logs are stored in `.data/`.

### Docker

With `.env` configured:

```bash
docker compose --profile app up -d
docker compose run --rm owner --email you@example.com
```

The repository's compose image build and boot checks run in CI. The hosted API and worker use `Dockerfile.railway`; the compose and hosted deployment paths are distinct. See [deployment instructions](docs/DEPLOYMENT.md) before configuring hosted services.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm --filter @palletdock/contracts check
pnpm --filter @palletdock/web build
```

Unit and PostgreSQL integration tests cover transaction tracking, indexing, API access, and consumer reconciliation. Contract checks compare committed artifacts with a fresh compile.

For browser tests, install Chrome and start the isolated fixture stack, then run E2E in another terminal:

```bash
pnpm --filter @palletdock/web exec playwright install chrome
pnpm e2e:stack
```

```bash
pnpm e2e:fixture
```

The fixture uses a **local Hardhat chain**, not Portaldot, and labels the UI **FIXTURE NETWORK**. Its ports are 3199/4199/8599. Stop it with Ctrl+C or `scripts/e2e-stack-stop.ps1` on Windows.

[CI](https://github.com/zkzora/palletdock/actions/workflows/ci.yml) runs on pull requests and manual dispatch. Its jobs cover artifact reproducibility, type checking, tests, the web production build, fixture E2E, and Docker compose checks. Recorded results and their revisions are in [implementation status](docs/IMPLEMENTATION_STATUS.md); they are not a claim that every later commit has had the same checks rerun.

## Limits and scope

- **Single RPC trust:** recorded values and coverage reflect one node's responses, not a cryptographic proof of completeness.
- **Finality is unverified:** the node answers `safe` and `finalized` tags, but no tested adapter independently links EVM records to native finality. PalletDock reports **Unknown: not confirmed**. The indexing delay does not establish finality.
- **History may be unrecoverable:** the public RPC served only the last 258 blocks when measured on 17 October 2026. This was an endpoint observation, not a permanent network guarantee. An aged-out checkpoint can require a recent start block, leaving a historical gap.
- **Freshness is not completeness:** a recent worker observation does not prove that every historical event was captured. Snapshot metadata and tracking conditions must be interpreted together.
- **No exactly-once downstream guarantee:** event identity and consumer reconciliation prevent duplicate rows in the demonstrated view; external side effects require their own safeguards.
- **Testnet MVP:** not audited or production-ready. Native signing/events, Assets/Uniques/Nfts management, ink!, bridges, finality proofs, tracing, source verification, team roles, and billing are not implemented.

Read [limitations](docs/LIMITATIONS.md), [API semantics](docs/API.md), and [consumer behavior](docs/CONSUMER.md) before integrating. PalletDock is an independent project, not an official Portaldot service.

## Repository layout

```text
apps/web            Next.js workspace, landing page, and documentation
apps/api            Fastify owner/workspace routes and public /v1 read API
apps/worker         Event indexer, receipt tracker, and network probes
packages/chain      EVM JSON-RPC and Substrate runtime adapters
packages/shared     Network configuration, lossless quantities, and validation
packages/db         PostgreSQL migrations and owner CLI
packages/contracts  Sample Solidity contracts (Storage, ERC-20, ERC-721, Payments) and reproducible artifacts
packages/e2e-chain  Local Hardhat chain for fixture tests
docs/               Guides, API specification, status, and testnet evidence
```

## Documentation

- [Walkthrough](docs/WALKTHROUGH.md) — contract-to-API testnet workflow
- [Playground](docs/PLAYGROUND.md) — temporary workspaces: lifecycle, limits, templates, saving, expiry
- [Architecture](docs/ARCHITECTURE.md) — processes, data model, and indexing
- [Network guide](docs/NETWORK.md) — identity, account mapping, and units
- [API guide](docs/API.md) · [OpenAPI specification](docs/openapi.yaml)
- [Consumer example](docs/CONSUMER.md) — application integration and freshness
- [Hosted deployment](docs/DEPLOYMENT.md) — Vercel, Railway, and acceptance checks
- [Testnet evidence](docs/TESTNET_EVIDENCE.md) · [Recorded artifacts](docs/evidence/)
- [Troubleshooting](docs/TROUBLESHOOTING.md) · [Limitations](docs/LIMITATIONS.md)
- [Implementation status](docs/IMPLEMENTATION_STATUS.md) · [Developer handoff](docs/HANDOFF.md)
- [In-app documentation](https://palletdock.vercel.app/docs)
