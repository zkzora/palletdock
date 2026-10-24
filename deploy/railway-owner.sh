#!/bin/sh
set -eu

# Create or reset one account inside the api container (railway ssh):
#   sh /app/deploy/railway-owner.sh --email you@example.com
# The password is read from the interactive prompt only.
APP="${PALLETDOCK_APP_ROOT:-/app}"
cd "$APP/packages/db"
exec "$APP/node_modules/.bin/tsx" src/owner-cli.ts "$@"
