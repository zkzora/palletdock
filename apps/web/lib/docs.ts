/**
 * Documentation content. Describes the features that exist in this repository;
 * anything not implemented is labelled Planned. Source for network facts:
 * Portaldot V3 developer guide (github.com/ItsCogumellum/portaldot-v3-testnet-guide).
 */
export type Block =
  | ['p', string]
  | ['h', string]
  | ['code', string]
  | ['list', string[]]
  | ['table', Array<[string, string]>]
  | ['links', Array<[string, string, string]>]
  | ['note', string];

export interface Doc {
  slug: string;
  group: string;
  title: string;
  meta?: Array<[string, string]>;
  blocks: Block[];
}

export const DOCS: Doc[] = [
  {
    slug: '',
    group: 'Getting started',
    title: 'PalletDock Documentation',
    meta: [['Applies to', 'PalletDock testnet MVP · Portaldot V3 Testnet EVM layer']],
    blocks: [
      ['p', 'PalletDock is a self-hosted developer workspace for Portaldot V3 Testnet. It keeps contracts, transactions, indexed events, a read API, and monitoring in one project, and always shows the network, block, and freshness context behind a value.'],
      ['h', 'Start here'],
      ['links', [
        ['getting-started', 'Getting started', 'Install, migrate, create the owner, and run the services.'],
        ['network', 'Network', 'Endpoints, identity checks, and the pinned fingerprint.'],
        ['accounts', 'Accounts and mapping', 'EVM signer vs mapped native funding account.'],
        ['deploy', 'Deploy a contract', 'Artifacts, the deploy wizard, and wallet approval.'],
      ]],
      ['h', 'Build and integrate'],
      ['links', [
        ['contracts', 'Read and write', 'ABI forms, reviews, reverts, and imports.'],
        ['transactions', 'Transaction states', 'Submission, inclusion, execution, finality, indexing.'],
        ['indexer', 'Indexing and finality', 'Coverage, checkpoints, reorgs, recovery.'],
        ['api', 'API reference', 'Read endpoints, keys, pagination, errors.'],
      ]],
      ['h', 'Operate'],
      ['links', [
        ['monitoring', 'Monitoring', 'Probes, lag, request errors, retention.'],
        ['security', 'Security', 'Owner auth, keys, CSRF, RPC allowlist.'],
        ['troubleshooting', 'Troubleshooting', 'Wrong network, unfunded deployer, unknown submissions.'],
        ['limitations', 'Limitations', 'What is not implemented or not verified.'],
      ]],
      ['note', 'Portaldot is not the Polkadot network. PalletDock is independent tooling, not an official Portaldot product.'],
    ],
  },
  {
    slug: 'getting-started',
    group: 'Getting started',
    title: 'Getting Started',
    blocks: [
      ['p', 'PalletDock runs as four processes: PostgreSQL, the API (Fastify), the worker (indexer, receipt tracker, network probes), and the web app (Next.js). Node.js 22+ and pnpm are required. Docker is optional.'],
      ['h', 'Install and start'],
      ['code', 'pnpm install\ncp .env.example .env            # then set PALLETDOCK_CURSOR_SECRET to a random value\npnpm db:start                   # local PostgreSQL (or: docker compose up -d postgres)\npnpm db:migrate\npnpm owner:create --email you@example.com   # prompts for a password (min 12 chars)\npnpm dev:api & pnpm dev:worker & pnpm dev:web'],
      ['p', 'Open the web app, sign in with the owner account, and create a project. The worker verifies the network identity on start, every minute while healthy, and with bounded exponential backoff (up to 30 minutes) while the RPCs fail; chain-bound actions stay disabled until a fingerprint is verified.'],
      ['h', 'First workflow'],
      ['list', [
        'Create a project (network is fixed to Portaldot V3 Testnet).',
        'Connect your EVM wallet and resolve its mapped native funding account on Overview.',
        'Fund that native account, then deploy the bundled PalletDockStorage sample from Contracts → Deploy.',
        'Call store(42) from the Write tab and approve it in your wallet.',
        'Configure an indexer source for NumberChanged starting at the deployment block.',
        'Create a read key and query /v1/projects/{projectId}/events from the API playground.',
      ]],
    ],
  },
  {
    slug: 'network',
    group: 'Network and accounts',
    title: 'Portaldot V3 Network',
    meta: [['Source', 'Portaldot V3 developer guide'], ['Checked by', 'The worker: on start, every 60 s while healthy, backing off up to 30 min while failing']],
    blocks: [
      ['table', [
        ['Network', 'Portaldot V3 Testnet'],
        ['EVM RPC', 'https://testnetv3-eth-rpc.feso-apps.xyz'],
        ['EVM chain ID', '420420777 (0x190f1ca9)'],
        ['Substrate RPC', 'wss://testnetv3-node.feso-apps.xyz'],
        ['Native token', 'tPOTv3, 14 decimals (native runtime)'],
        ['SS58 prefix', '42'],
        ['Node console', 'https://node-console.feso-apps.xyz/'],
      ]],
      ['h', 'Identity fingerprint'],
      ['p', 'The worker reads eth_chainId and the EVM genesis block, plus the native genesis hash, runtime version, and system properties. A fingerprint is activated only when both sides respond and match the configuration. Every probe, including failures, is stored with its time and latency.'],
      ['p', 'If the genesis hash changes (a testnet reset), PalletDock records a mismatch and stops indexing and receipt tracking. Nothing is silently re-pointed. An operator must run the explicit migration, which supersedes the old fingerprint, stops its sources, and invalidates its account mappings and API cursors:'],
      ['code', 'pnpm network:accept-reset --confirm'],
      ['h', 'RPC allowlist'],
      ['p', 'RPC targets come from configuration only and must match an allowlisted host. Users cannot enter arbitrary RPC URLs. Loopback targets are accepted only for local fixture testing and only outside production; the UI then shows a FIXTURE NETWORK banner.'],
      ['h', 'Not assumed'],
      ['p', 'PalletDock does not assume BABE, GRANDPA, BEEFY, finality-proof RPCs, trace RPCs, an EVM block explorer, or a source-verification service.'],
    ],
  },
  {
    slug: 'accounts',
    group: 'Network and accounts',
    title: 'Accounts And Address Mapping',
    blocks: [
      ['h', 'Three things to keep separate'],
      ['list', [
        'EVM signing address: the H160 selected in your browser wallet.',
        'Mapped native funding account: the AccountId32 / SS58 the runtime returns for that H160.',
        'A native signing account: a different signing path (Planned in PalletDock).',
      ]],
      ['h', 'How PalletDock resolves the mapping'],
      ['p', 'Overview → Account mapping calls the runtime API reviveApi.accountId through current metadata at the latest finalized native block. The result is stored with the direction (EVM → native), block number and hash, runtime spec version, and time. It is reused for 10 minutes on the same fingerprint and runtime version, and you can recheck at any time. No mapping formula is hard-coded.'],
      ['p', 'A connected wallet only signs transactions. It does not grant access to workspace data.'],
    ],
  },
  {
    slug: 'funding',
    group: 'Network and accounts',
    title: 'Test Tokens And Funding',
    blocks: [
      ['p', 'Test tokens are distributed by the Portaldot team (see the developer guide and team announcements); PalletDock has no faucet. Send tPOTv3 to the mapped native funding account of your EVM deployer, not to a guessed address.'],
      ['h', 'Units'],
      ['p', 'Native balances use 14 decimals. The EVM facade denomination has not been verified, so PalletDock shows EVM balances, values, gas prices, and fees as raw base units and never applies the native 14-decimal scale to them.'],
    ],
  },
  {
    slug: 'deploy',
    group: 'Contracts',
    title: 'Deploy A Contract',
    blocks: [
      ['h', 'Artifacts'],
      ['p', 'Choose a bundled sample (PalletDockStorage, PalletDockToken ERC-20, PalletDockCollectible ERC-721) or upload a compiled JSON artifact (Hardhat, Foundry, or solc output, up to 2 MB). PalletDock validates the ABI and signatures, requires creation bytecode, rejects runtime-only bytecode and unresolved library placeholders, and never runs uploaded scripts or compiles source on the server.'],
      ['p', 'Bundled samples are compiled reproducibly with solc 0.8.24, optimizer 200 runs, evmVersion paris, and OpenZeppelin 5.1.0. Run pnpm contracts:build to rebuild and pnpm --filter @palletdock/contracts check to confirm the committed artifacts match. Compatibility with the Portaldot Revive runtime is confirmed only by a recorded live deployment.'],
      ['code', '// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\n\ncontract PalletDockStorage {\n    uint256 private number;\n    event NumberChanged(address indexed caller, uint256 previousValue, uint256 newValue);\n\n    function store(uint256 newValue) external {\n        uint256 previousValue = number;\n        number = newValue;\n        emit NumberChanged(msg.sender, previousValue, newValue);\n    }\n\n    function retrieve() external view returns (uint256) {\n        return number;\n    }\n}'],
      ['h', 'Wizard'],
      ['list', [
        'Artifact: pick a sample or upload one.',
        'Arguments: typed constructor inputs; value only for payable constructors.',
        'Review: the API encodes the deployment, estimates gas and price, and asks the runtime for a storage-deposit dry run. Unavailable estimates say why.',
        'Wallet: your wallet shows the final request. Wrong network, rejection, and unknown results are recorded distinctly.',
        'Result: the worker tracks the receipt; on success the contract is added to the project from the receipt.',
      ]],
    ],
  },
  {
    slug: 'contracts',
    group: 'Contracts',
    title: 'Read, Write, And Import',
    blocks: [
      ['h', 'Import'],
      ['p', 'Import an address with its ABI. PalletDock checks that runtime code exists at the address on the verified network. This is off-chain organization: it does not prove ownership and is not source verification.'],
      ['h', 'Read'],
      ['p', 'Read functions run with eth_call at an explicit block. Results are shown losslessly (large integers as decimal strings) with the raw return data.'],
      ['h', 'Write'],
      ['p', 'Write review shows network, signer, destination, function, arguments, calldata, value, fee estimate, and storage deposit (or why it is unavailable). If the simulation reverts, custom errors are decoded with the ABI and the raw data is kept.'],
      ['p', 'Inputs support scalar types, fixed and dynamic arrays, and tuples (enter arrays and tuples as JSON; quote large integers). Unsupported types return an explicit error and nothing is encoded.'],
      ['h', 'ABI versions and removal'],
      ['p', 'Replacing an ABI adds a new version; raw logs and earlier decoded records stay. Removing a contract stops workspace tracking only; on-chain code is unchanged and history is kept.'],
    ],
  },
  {
    slug: 'transactions',
    group: 'Contracts',
    title: 'Transaction States',
    blocks: [
      ['p', 'PalletDock tracks transactions it prepared and hashes you register explicitly. It does not show all wallet activity.'],
      ['table', [
        ['Submission', 'prepared · rejected (nothing broadcast) · submitted (hash returned) · unknown (ambiguous wallet result)'],
        ['Inclusion', 'not observed · pending · included · reorged_out (receipt disappeared)'],
        ['Execution', 'unknown · success (status 0x1) · reverted (status 0x0, a fee may still be charged)'],
        ['Finality', 'unknown (no verified adapter; inclusion is not finality)'],
        ['Indexing', 'not covered · pending · indexed · no events'],
      ]],
      ['p', 'Timeline entries are observation times recorded by PalletDock, not chain timestamps. After an unknown result, use Check account activity before retrying; PalletDock never resubmits automatically. If the wallet answers late, the hash is attached to the same record.'],
    ],
  },
  {
    slug: 'indexer',
    group: 'Data and APIs',
    title: 'Indexing And Finality',
    blocks: [
      ['p', 'A log source indexes one contract, selected ABI events, from a start block to an optional end block (or following the observed head). The worker runs independently of browser tabs.'],
      ['h', 'How a range is committed'],
      ['list', [
        'The worker claims the source with a lease and records the source generation (SKIP LOCKED; one worker at a time).',
        'It verifies the stored checkpoint hash is still canonical, then fetches eth_getLogs for a bounded range, halving the range when the node rejects it.',
        'It fetches headers for the range ends and every log block, checks parent linkage and log block hashes, and re-reads the range end.',
        'Raw logs, decoded events, headers, the checkpoint, and status are written in one database transaction, only if the lease and generation still match. Empty ranges advance the checkpoint too.',
      ]],
      ['p', 'Records are unique by network fingerprint, block hash, transaction hash, and log index. Unknown or malformed logs are stored with their decode status and error.'],
      ['h', 'Reorganizations'],
      ['p', 'If the checkpoint is no longer canonical, the worker walks back through retained headers to the highest common ancestor, marks later records non-canonical (kept as orphan history), moves the checkpoint back, increments the reorg epoch, and reindexes the replacement blocks. A reorg deeper than retained ancestry puts the source in Recovery required.'],
      ['h', 'Failures and lifecycle'],
      ['p', 'RPC failures back off exponentially with jitter and resume from the checkpoint. Pause, archive, and edits increase the generation, so in-flight work is discarded instead of committed. Development builds can simulate an RPC interruption; that control is never a production metric.'],
      ['h', 'Finality'],
      ['p', 'Indexed records stay "finality unknown". No adapter proving the relationship between an EVM block and a finalized native block exists yet, and confirmation depth is not presented as finality.'],
      ['note', 'Absence of an event outside completed coverage is not evidence that it did not happen. Native event indexing is Planned.'],
    ],
  },
  {
    slug: 'api',
    group: 'Data and APIs',
    title: 'API Reference',
    meta: [['Spec', 'GET /openapi.yaml on your API host'], ['Auth', 'Authorization: Bearer <PROJECT_READ_KEY>']],
    blocks: [
      ['table', [
        ['GET /v1/projects/{projectId}/events', 'events:read · contract, event, fromBlock, toBlock, finality, limit, cursor'],
        ['GET /v1/projects/{projectId}/transactions', 'transactions:read · executionStatus, inclusionStatus, contract, hash, limit, cursor'],
        ['GET /v1/projects/{projectId}/contracts', 'contracts:read · address, limit, cursor'],
        ['GET /v1/projects/{projectId}/indexer', 'indexer:read'],
      ]],
      ['p', 'Responses contain requestId, data, nextCursor, and meta (network identity and fingerprint, observedAt, latest checkpoint, per-source coverage and lag, explicit unknown finality). Exact integers are strings.'],
      ['h', 'Keys'],
      ['p', 'Keys are project-scoped, read-only, expiring (7–365 days), revocable, and replaceable. The secret is shown once; only a hash is stored. Keys never authorize workspace changes or signing, and are never accepted in URLs.'],
      ['h', 'Pagination and snapshots'],
      ['p', 'Default limit 25, maximum 100. Events are ordered by block, transaction index, and log index. The first page fixes a snapshot; cursors are signed and bound to project, filters, network fingerprint, and reorg epoch. After a rollback, reindex, or network reset an old cursor returns 409 CURSOR_RESTART_REQUIRED.'],
      ['h', 'Errors'],
      ['table', [
        ['400 INVALID_QUERY', 'Invalid or unsupported filter, range, or limit'],
        ['401 UNAUTHORIZED', 'Missing, invalid, expired, or revoked key'],
        ['403 FORBIDDEN_SCOPE', 'Key lacks the required scope'],
        ['404 PROJECT_NOT_FOUND', 'Project missing or not accessible with this key'],
        ['409 CURSOR_RESTART_REQUIRED', 'Snapshot no longer valid; restart without a cursor'],
        ['429 RATE_LIMITED', 'Too many requests'],
        ['5xx', 'Service unavailable or internal error; includes requestId'],
      ]],
      ['code', 'curl -sS "$PALLETDOCK_API/v1/projects/$PROJECT_ID/events?event=NumberChanged&limit=25" \\\n  -H "Authorization: Bearer $PALLETDOCK_READ_KEY"'],
    ],
  },
  {
    slug: 'monitoring',
    group: 'Operations',
    title: 'Monitoring',
    blocks: [
      ['p', 'Monitoring shows the latest EVM and native probes (responded, failed, stale after 3 minutes, or unavailable), worker heartbeat, indexer lag (latest observed block minus checkpoint), lag at each checkpoint commit, API errors by code from recorded requests, and filterable logs linked to their transaction or indexer source.'],
      ['p', 'Time range, source, and level filters change the query, not just labels. Probes are kept 14 days; logs and request records 30 days. Request records never include keys, cookies, or bodies.'],
    ],
  },
  {
    slug: 'security',
    group: 'Operations',
    title: 'Security And Permissions',
    blocks: [
      ['list', [
        'One owner per deployment. Passwords use scrypt; sign-in is rate limited; sessions are random server-side tokens in HttpOnly SameSite=Strict cookies.',
        'Every workspace mutation requires a CSRF token bound to the session.',
        'Every project, contract, job, transaction, log, and key is checked against the owner. Malformed or foreign ids return 404.',
        'Read keys are hashed, scoped to one project, expiring, revocable, and redacted from logs and request previews.',
        'RPC targets are allowlisted configuration, never user input.',
        'No server-held deployer key. No seed phrase input. All writes are signed in the browser wallet after review.',
        'Exports contain metadata only; secrets are never exported.',
      ]],
      ['note', 'This is a testnet MVP. It has not been security audited.'],
    ],
  },
  {
    slug: 'troubleshooting',
    group: 'Operations',
    title: 'Troubleshooting',
    blocks: [
      ['h', 'Chain-bound actions are disabled'],
      ['p', 'The network identity is not verified. Check Monitoring for probe errors. When the Portaldot RPCs are unavailable (for example HTTP 502), deploy, import, and mapping stay disabled; stored data and the read API keep working.'],
      ['h', 'The wallet shows the wrong network'],
      ['p', 'Use Switch to Portaldot V3 in the signer dialog. Writes are blocked unless the wallet reports chain 0x190f1ca9 at signing time.'],
      ['h', 'Native balance is funded but the EVM deployer is not'],
      ['p', 'Resolve the mapping for the exact EVM address and compare it with the account you funded.'],
      ['h', 'Submission unconfirmed'],
      ['p', 'Use Check account activity. A browser timeout does not undo a broadcast; do not resubmit until the original is understood.'],
      ['h', 'The indexer shows no events'],
      ['p', 'Compare the receipt logs with the source address, selected events, ABI version, start block, and completed coverage. Undecoded logs are kept with their raw topics.'],
      ['h', 'API returns 409 CURSOR_RESTART_REQUIRED'],
      ['p', 'Indexed data was rolled back or reindexed since the first page. Restart pagination without a cursor.'],
    ],
  },
  {
    slug: 'limitations',
    group: 'Operations',
    title: 'Limitations',
    blocks: [
      ['list', [
        'Live acceptance on Portaldot V3 Testnet is pending: the public RPC endpoints returned HTTP 502 during development, so deployment compatibility of the bundled EVM bytecode with Revive is not yet confirmed.',
        'Finality is always unknown. No verified finality adapter exists.',
        'Storage-deposit estimates use the runtime dry-run only when metadata exposes a compatible reviveApi call; otherwise they are unavailable with a reason. Deposits are not read from receipts.',
        'EVM unit denomination is unverified; amounts are raw base units.',
        'Only EVM contract logs are indexed. Native events, native signing, Assets/Uniques/Nfts, ink!, bridges, tracing, source verification, team roles, and billing are not implemented.',
        'Linked libraries are not supported in uploaded artifacts.',
      ]],
    ],
  },
  {
    slug: 'glossary',
    group: 'Reference',
    title: 'Glossary',
    blocks: [
      ['table', [
        ['Fingerprint', 'Pinned network identity: native genesis hash + EVM chain ID (+ runtime evidence).'],
        ['Checkpoint', 'Highest block whose range is durably committed for a source, with its hash.'],
        ['Coverage', 'Requested range vs completed range for a source.'],
        ['Generation', 'Counter that fences in-flight worker commits after pause, archive, or edits.'],
        ['Reorg epoch', 'Counter incremented on each rollback or reindex; binds API cursors.'],
        ['Mapped account', 'Native AccountId32 returned by reviveApi.accountId for an EVM H160.'],
      ]],
    ],
  },
];
