#!/bin/sh
set -eu

# Railway pre-deploy command for the api and worker services. Runs the migration
# CLI with tsx directly, for the same reason as railway-start.sh: no pnpm at runtime.
APP="${PALLETDOCK_APP_ROOT:-/app}"
cd "$APP/packages/db"
exec "$APP/node_modules/.bin/tsx" src/migrate-cli.ts
