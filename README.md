# PalletDock

PalletDock is an in-progress developer workspace for Portaldot V3 Testnet. This repository currently contains the backend foundation: lossless chain adapters, PostgreSQL schema, single-owner authentication, project and read-key management, authenticated read APIs, and network monitoring. It is not yet a complete MVP and has not passed live wallet acceptance.

## Local setup

Requirements: Node.js 22+, pnpm 11+, and either Docker or the bundled development PostgreSQL binary.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:start
```

In a second terminal:

```powershell
pnpm db:migrate
pnpm owner:create --email you@example.com
pnpm dev:api
```

The embedded database listens on `127.0.0.1:55432`. The API defaults to `127.0.0.1:4100`; set `API_PORT` if that port is occupied. The owner command prompts for a password unless `PALLETDOCK_OWNER_PASSWORD` is deliberately supplied.

Docker users can replace `pnpm db:start` with:

```powershell
docker compose up -d postgres
```

## Checks

```powershell
pnpm typecheck
pnpm test
pnpm network:verify
```

`network:verify` is read-only. It records timestamped EVM and native identity probes, activates a fingerprint only after both sides respond with the expected configured identity, and exits nonzero when the network is unavailable or mismatched.

## Implemented HTTP routes

- `GET /health`
- `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`
- `GET|POST /workspace/projects`
- `PATCH /workspace/projects/:projectId`
- `POST /workspace/projects/:projectId/archive|restore`
- `GET|POST /workspace/projects/:projectId/keys`
- `POST /workspace/projects/:projectId/keys/:keyId/revoke`
- `GET /v1/projects/:projectId/contracts`
- `GET /v1/projects/:projectId/transactions`
- `GET /v1/projects/:projectId/events`
- `GET /v1/projects/:projectId/indexer`

Workspace mutations require a same-site session cookie and `x-csrf-token`. `/v1` routes require a scoped project Bearer key. Key secrets are returned once and only their SHA-256 digest is stored. Pagination cursors are signed and bound to the project, resource, filters, and snapshot.

See [implementation status](docs/IMPLEMENTATION_STATUS.md) and [handoff](docs/HANDOFF.md) before continuing development.
