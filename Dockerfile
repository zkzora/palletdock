# PalletDock monorepo image (api, worker, web, migrations). Self-hosted testnet MVP.
# Build: docker compose build   ·   Not verified on this repository's development machine (no Docker).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/chain/package.json packages/chain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/e2e-chain/package.json packages/e2e-chain/
RUN pnpm install --frozen-lockfile

FROM deps AS app
COPY . .
ARG PALLETDOCK_API_URL=http://api:4100
ENV PALLETDOCK_API_URL=$PALLETDOCK_API_URL
RUN pnpm --filter @palletdock/web build
EXPOSE 3000 4100
