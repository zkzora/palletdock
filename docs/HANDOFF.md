# Handoff

For the next agent or developer. Read IMPLEMENTATION_STATUS.md first.

## Where things stand (2026-10-21)

The full MVP workflow is implemented, passes automated tests (including a browser E2E vertical slice on a local fixture chain), and has run live on Portaldot V3 Testnet: deploy → `store(42)` → indexed event → read API, recorded in TESTNET_EVIDENCE.md. That run was signed with a scripted EIP-1193 signer holding the owner's test key, through the PalletDock UI. RPC-interruption recovery was also verified live (docs/evidence/2026-10-21-live). A worker restart with `store(43)` sent while it was down was verified live as well (docs/evidence/2026-10-21-restart). The live walkthrough is complete. A consumer demo (`/consumer`, docs/CONSUMER.md) shows how an application reads the public API, including stale, unavailable, and pruned-history cases; its live walkthrough is in docs/evidence/2026-10-21-consumer.

## Repository conventions

- Commits are authored by the repository owner. Do not add AI co-author trailers (owner's instruction).
- Code style: TypeScript ESM, `.js` import specifiers in Node packages. The web app does not import workspace Node packages (validation and encoding happen in the API).
- Chain quantities are strings end to end (`int8`/`numeric` come back from node-pg as strings).
- Every workspace route uses `workspaceGuard` (session + ownership; mutations also need CSRF and a non-archived project unless allowed).
- Fixture runs must stay visibly labelled and must never be written into TESTNET_EVIDENCE.md.

## Key files

| Concern | File |
| --- | --- |
| Schema | `packages/db/migrations/0001_init.sql` (add new numbered files; applied files are checksummed) |
| Indexer | `apps/worker/src/indexer/engine.ts`, `decode.ts`; tests `apps/worker/test/indexer.test.ts` with `fake-chain.ts` |
| Receipts | `apps/worker/src/tx-tracker.ts` |
| Network identity / reset | `apps/worker/src/network.ts`, `network-reset.ts` |
| Workspace API | `apps/api/src/workspace.ts`, auth helpers `context.ts`, project/auth/keys routes `server.ts` |
| Public API | `apps/api/src/v1.ts`, `cursor.ts`, spec `docs/openapi.yaml` |
| Consumer demo | `apps/web/app/consumer/` (page + `state/route.ts`), logic `apps/web/lib/consumer/core.ts`, server config/auth `lib/consumer/server.ts`; guide `docs/CONSUMER.md` |
| Chain adapters | `packages/chain/src/evm.ts`, `substrate.ts` (mapping + dry run), `json-rpc.ts` |
| Wallet | `apps/web/lib/wallet-core.ts` (tested), `wallet.tsx`, sign flow `components/sign-flow.tsx` |
| UI pages | `apps/web/app/app/**` |
| E2E | `scripts/e2e-stack.ts`, `apps/web/e2e/fixture-*.ts`, `playwright.fixture.config.ts` |
| Hosted deployment | `Dockerfile.railway`, `deploy/railway-start.sh`, and `docs/DEPLOYMENT.md` |

## Hosted deployment prepared (2026-10-22)

- Chosen shape: Vercel for `apps/web`; Railway for separate API and always-on worker services plus private PostgreSQL.
- The API now accepts Railway's injected `PORT`, uses `0.0.0.0` by default in production, and validates the port (`apps/api/src/listen.ts`, `server-config.test.ts`).
- `Dockerfile.railway` selects API or worker from `PALLETDOCK_SERVICE`; both services run `pnpm db:migrate` as a pre-deploy command. Migrations already serialize with a PostgreSQL advisory lock.
- Jury access should use `PALLETDOCK_CONSUMER_PUBLIC=1` on Vercel. This exposes only derived read-only consumer state for a dedicated demo project; the read key remains server-side and workspace/mutation auth is unchanged. The default remains private.
- Nothing has been committed, pushed, deployed, or configured in a hosting account. Docker is unavailable on this machine, so the new Railway image still needs its first Railway build. Follow `docs/DEPLOYMENT.md` exactly and do not reuse the local read key or database.

## Local environment on the original machine

- PostgreSQL `127.0.0.1:55432` (`pnpm db:start`, data in `.data/postgres`), API `127.0.0.1:4101`, web `127.0.0.1:3001`, worker. Managed with `scripts/dev-services.ps1`. `.env` (gitignored) holds a random cursor secret and `PALLETDOCK_DEV_CONTROLS=1`.
- Ports 3000 and 4100 belong to an unrelated project (Collara). Do not stop them.
- The dev owner `owner@palletdock.local` was created by an earlier session and its password was not stored. Run `pnpm owner:create --email <you>` to set a new one (this updates the single owner and revokes sessions).

## In a fresh clone (cloud session)

```bash
pnpm install
cp .env.example .env        # set PALLETDOCK_CURSOR_SECRET
pnpm db:start               # or docker compose up -d postgres
pnpm db:migrate && pnpm owner:create --email you@example.com
pnpm test                   # starts its own throwaway PostgreSQL (or set TEST_DATABASE_URL)
pnpm e2e:stack & pnpm e2e:fixture   # needs Chrome for Playwright: pnpm --filter @palletdock/web exec playwright install chrome
```

On Linux the fixture stack stops its children by process group; on Windows use `scripts/e2e-stack-stop.ps1`.

## Next steps, in priority order

1. **Optional MetaMask-approved run** of the same flow (the live runs used a scripted EIP-1193 signer). Configure any new indexer source within ~26 minutes of its start block (the public endpoint retained 258 blocks when measured on 2026-10-17). Do not change the network or accept a reset without the owner's approval.
2. ~~Verify the EVM unit policy~~ Done 2026-10-19: `eth_getBalance` = (native free − existential deposit) × 10⁴ (TESTNET_EVIDENCE.md).
3. Replacement-transaction linking by nonce.

Receipt tracking (2026-10-21): a missing receipt is a reorg only when the canonical block at that height has a different hash; pruned history is kept as `history_pruned`; every tracked hash ends in a terminal state (settled, history_pruned, gave_up). Use `pnpm --filter @palletdock/worker tx:restore-pruned` (dry run, then `--apply`) if older data was cleared by the previous tracker.
4. A finality adapter: the node exposes `finalized`/`safe` tags and GRANDPA is present, but nothing is claimed until a tested adapter links EVM blocks to native finality.

Network change on 2026-10-17: endpoints moved to `*.portaldot.dev` (owner-approved), native token symbol is `tPOT` (owner-approved), fingerprint `3fc49db4…` active.

Done since the previous handoff: a dedicated receipt-tracker test (disappearance, re-inclusion, mismatch), bounded RPC backoff with an overlap guard, an independent clean-clone rerun, two green CI runs including a Docker compose boot, and the security review in SECURITY_REVIEW.md.
