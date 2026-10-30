# Hosted deployment: Vercel + Railway

This is the recommended hackathon deployment shape:

| Component | Host | Public? |
| --- | --- | --- |
| Next.js web | Vercel | Yes |
| Fastify API | Railway | Yes; required by the Vercel proxy |
| Indexer worker | Railway | No domain |
| PostgreSQL | Railway | Private only |

The API and worker are separate always-on services built from the same repository. Do not put the worker on Vercel: it must keep polling Portaldot V3 and the node's retained-history window is short.

## 1. Preflight

1. Commit and push the reviewed working tree. Never commit `.env`, `.data/`, a read key, an owner password, or a wallet key.
2. Create one fresh cursor secret, for example with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
3. Use the same Railway region for API, worker, and PostgreSQL. One replica of each process is enough for this demo.

Docker is verified by repository CI, but `Dockerfile.railway` still needs its first build in Railway because Docker is not installed on the current development machine.

## 2. Railway

Create a Railway project with a PostgreSQL service plus two empty services named `api` and `worker`. Connect both application services to the same GitHub repository and branch. Keep the repository root as `/`.

For both `api` and `worker`:

- set `RAILWAY_DOCKERFILE_PATH=Dockerfile.railway`;
- set pre-deploy command to `sh /app/deploy/railway-migrate.sh` (the migration runner uses a Postgres advisory lock, so concurrent attempts serialize safely). The image installs only the API and worker dependencies, so containers run `tsx` directly; calling `pnpm` inside a container would make it download the rest of the workspace;
- set restart policy to **Always**;
- reference the private database URL as `DATABASE_URL=${{Postgres.DATABASE_URL}}` (replace `Postgres` if the database service has another name);
- do not enable serverless/sleeping behavior for the worker.

API variables:

```dotenv
PALLETDOCK_SERVICE=api
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
WEB_ORIGIN=https://YOUR-VERCEL-DOMAIN
SESSION_COOKIE_SECURE=1
API_TRUST_PROXY=1
PALLETDOCK_CURSOR_SECRET=GENERATE_A_FRESH_32_BYTE_SECRET
PORTALDOT_EVM_RPC_URL=https://test-evm-rpc-v3.portaldot.dev
PORTALDOT_SUBSTRATE_RPC_URL=wss://test-node-v3.portaldot.dev
PALLETDOCK_PROCESS=api
PALLETDOCK_PROXY_SECRET=SAME_FRESH_SECRET_AS_IN_VERCEL
```

Browser requests reach the API through the Vercel proxy, so the API sees every visitor as Vercel's server address. With `PALLETDOCK_PROXY_SECRET` set to the same value (at least 32 characters) on the API and in Vercel, the web app's `proxy.ts` forwards each visitor's address and the API uses it for rate limits and sign-in/sign-up lockouts; without it, all visitors share one quota. Only set it behind a platform that overwrites the visitor-supplied `x-forwarded-for` header (Vercel does). Sign-in attempts per visitor default to 10 per 15 minutes (`API_LOGIN_RATE_LIMIT_PER_15_MINUTES`).

The API reads Railway's injected `PORT` automatically and listens on `0.0.0.0` in production. Configure `/health` as its healthcheck, deploy it, then generate a public Railway domain. Do not set `PALLETDOCK_DEV_CONTROLS=1`.

Worker variables:

```dotenv
PALLETDOCK_SERVICE=worker
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
PORTALDOT_EVM_RPC_URL=https://test-evm-rpc-v3.portaldot.dev
PORTALDOT_SUBSTRATE_RPC_URL=wss://test-node-v3.portaldot.dev
PALLETDOCK_PROCESS=worker
# optional, default 3: blocks to stay behind the head before indexing
# PALLETDOCK_INDEX_LAG_BLOCKS=3
```

The worker must remain running. It does not need a public domain.

After the API is healthy, create an operator account without putting the password in an environment variable:

```sh
railway ssh --service api
sh /app/deploy/railway-owner.sh --email you@example.com
```

Enter the password only at the interactive prompt. Running the command again for the same email resets that account and revokes only its sessions.

For self-service hosted accounts, prefer invite mode on the API service:

```text
PALLETDOCK_SIGNUP_MODE=invite
PALLETDOCK_SIGNUP_INVITE_CODE=<random value, at least 16 characters>
PALLETDOCK_SIGNUP_RATE_LIMIT_PER_15_MINUTES=5
```

### Playground (temporary workspaces)

Public guest creation is off unless the API service sets the flag. All values are read by the API only; nothing is configured in Vercel or as `NEXT_PUBLIC_*`:

```text
PALLETDOCK_PLAYGROUND_ENABLED=1                  # default 0 (disabled)
PALLETDOCK_PLAYGROUND_LIFETIME_MINUTES=360       # fixed lifetime, 15–1440, never extended by activity
PALLETDOCK_PLAYGROUND_CAPACITY=100               # unexpired guest workspaces at once
PALLETDOCK_PLAYGROUND_STARTS_PER_HOUR=3          # per visitor address (needs PALLETDOCK_PROXY_SECRET behind the web proxy)
PALLETDOCK_PLAYGROUND_MAX_CONTRACTS=2
PALLETDOCK_PLAYGROUND_MAX_INDEXER_SOURCES=1
PALLETDOCK_PLAYGROUND_MAX_READ_KEYS=1
PALLETDOCK_PLAYGROUND_MAX_ACTIONS=150            # mutating or RPC-backed workspace requests per guest
```

It needs migration `0004_guest_playground.sql` (applied by the normal pre-deploy migration) and a worker built from the same commit: the worker skips expired guests when claiming indexer work and polling receipts, and runs the expiry maintenance pass. Without `PALLETDOCK_PROXY_SECRET` on both services, every visitor shares the proxy's address for the start limit. Saving a temporary workspace uses the signup mode below; with `PALLETDOCK_SIGNUP_MODE=disabled`, guests are told that saving is unavailable. See [PLAYGROUND.md](PLAYGROUND.md).

Acceptance after enabling: `GET /auth/playground-config` shows `enabled: true`; opening `/playground` sets no cookie; **Start temporary workspace** opens `/app` with the *Temporary playground* indicator.

Redeploy the API after changing these values. Users then create isolated accounts at `/signup`; the invite code is sent only to intended testers and is never configured in Vercel or a `NEXT_PUBLIC_*` variable. `PALLETDOCK_SIGNUP_MODE=open` is supported but is not recommended until the deployment also has CAPTCHA, resource quotas, and abuse monitoring. `disabled` remains the default.

## 3. Vercel

Import the GitHub repository as one Vercel project and set **Root Directory** to `apps/web`. Leave "Include source files outside of the Root Directory" enabled so Vercel can use the root lockfile and workspace metadata.

Set these server-side variables for Production (and Preview only if a preview should use the production API):

```dotenv
PALLETDOCK_API_URL=https://YOUR-API.up.railway.app
PALLETDOCK_CONSUMER_API_URL=https://YOUR-API.up.railway.app
PALLETDOCK_CONSUMER_PROJECT_ID=HOSTED_PROJECT_UUID
PALLETDOCK_CONSUMER_READ_KEY=HOSTED_READ_KEY
PALLETDOCK_CONSUMER_CONTRACT=HOSTED_CONTRACT_ADDRESS
PALLETDOCK_CONSUMER_EVENT=NumberChanged
PALLETDOCK_CONSUMER_PUBLIC=1
PALLETDOCK_PROXY_SECRET=SAME_FRESH_SECRET_AS_IN_RAILWAY_API
```

`PALLETDOCK_CONSUMER_READ_KEY` must never use a `NEXT_PUBLIC_` prefix. The browser receives derived consumer state and the public key prefix only. `PALLETDOCK_CONSUMER_PUBLIC=1` exposes only the read-only `/consumer` demo; `/app`, workspace endpoints, keys, and mutation routes still require the owner session. Use a dedicated demo project and revoke the hosted read key after judging. Omit the flag or set it to `0` to require owner login again.

In public mode every viewer polls `/consumer/state` every 5 s, but the API sees all of them as Vercel's server address and rate-limits per IP (`API_RATE_LIMIT_PER_MINUTE`, default 120). The route therefore shares one upstream read (about three `/v1` requests) per 4 s per Vercel instance, so the load does not grow with the number of viewers. Viewers may see data up to 4 s older than a direct read.

After Vercel has assigned its production domain, update Railway's `WEB_ORIGIN` to that exact `https://...` origin and redeploy the API. The browser will call same-origin `/backend/*`; Next.js proxies those requests to `PALLETDOCK_API_URL`.

## 4. Initialize hosted demo data

The local database is intentionally not copied. In the hosted workspace:

1. sign in as the owner;
2. create a dedicated demo project;
3. import or deploy `PalletDockStorage` on Portaldot V3;
4. create the event source immediately, starting near the current tip;
5. create a seven-day key with only `events:read`, `indexer:read`, and `transactions:read`;
6. put its project ID, key, contract, and event name in Vercel's server-side consumer variables and redeploy Vercel;
7. open `/consumer` in a signed-out browser and confirm it loads without exposing the key secret.

Do not reuse the local consumer key. The hosted API has a new database and therefore needs a new hosted project and key.

## 5. Acceptance checks

Run these against the hosted URLs before sharing them:

```sh
curl -fsS https://YOUR-API.up.railway.app/health
curl -I https://YOUR-VERCEL-DOMAIN/
curl -I https://YOUR-VERCEL-DOMAIN/login
curl -I https://YOUR-VERCEL-DOMAIN/consumer
```

Then verify in a signed-out browser:

- landing page and `/consumer` load without console errors;
- `/consumer/state` contains no `pd_live_...` key secret;
- `/app` redirects to sign-in and no owner password is shared with judges;
- worker logs keep advancing `latestObservedAt` and do not enter `recovery_required`;
- finality remains **Unknown: not confirmed**; do not relabel it as finalized.

## Rollback

- Set `PALLETDOCK_CONSUMER_PUBLIC=0` and redeploy Vercel to close public demo access.
- Revoke the consumer read key in the workspace.
- Roll back Vercel and Railway deployments independently from their dashboards.
- Keep PostgreSQL private; do not expose its TCP endpoint just to debug the demo.
