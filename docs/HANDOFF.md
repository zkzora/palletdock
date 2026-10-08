# Handoff

For the next agent or developer. Read IMPLEMENTATION_STATUS.md first.

## Where things stand (2026-10-08)

The full MVP workflow is implemented and passes automated tests, including a browser E2E vertical slice on a local fixture chain. The one remaining acceptance item is **live verification on Portaldot V3 Testnet**: both public RPCs returned HTTP 502 for the entire session, so no fingerprint was activated and no live transaction exists. Do not claim live completion until WALKTHROUGH.md has been run by a human with a funded wallet and TESTNET_EVIDENCE.md is filled in.

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
| Chain adapters | `packages/chain/src/evm.ts`, `substrate.ts` (mapping + dry run), `json-rpc.ts` |
| Wallet | `apps/web/lib/wallet-core.ts` (tested), `wallet.tsx`, sign flow `components/sign-flow.tsx` |
| UI pages | `apps/web/app/app/**` |
| E2E | `scripts/e2e-stack.ts`, `apps/web/e2e/fixture-*.ts`, `playwright.fixture.config.ts` |

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

1. **Live walkthrough** (WALKTHROUGH.md) once `pnpm network:verify` succeeds. A human approves every wallet prompt and funds the wallet; record TESTNET_EVIDENCE.md. Do not accept a network reset or change the network without the owner's approval.
2. If Revive rejects the EVM bytecode: add PolkaVM (resolc) builds of the samples (artifact validation already detects `polkavm`).
3. Live capability probes (fee history, `finalized` tag, `eth_getLogs` range limit) and a verified EVM unit policy from the balance comparison.
4. Replacement-transaction linking by nonce.

Done since the previous handoff: a dedicated receipt-tracker test (disappearance, re-inclusion, mismatch), bounded RPC backoff with an overlap guard, an independent clean-clone rerun, two green CI runs including a Docker compose boot, and the security review in SECURITY_REVIEW.md.
