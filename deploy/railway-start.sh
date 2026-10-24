#!/bin/sh
set -eu

# Run tsx directly. The image installs only the API and worker dependencies, and
# invoking pnpm at runtime makes it reinstall the rest of the workspace on every
# container start (minutes, and a registry outage would stop the service).
APP="${PALLETDOCK_APP_ROOT:-/app}"
TSX="$APP/node_modules/.bin/tsx"

case "${PALLETDOCK_SERVICE:-}" in
  api)
    cd "$APP/apps/api"
    exec "$TSX" src/server.ts
    ;;
  worker)
    cd "$APP/apps/worker"
    exec "$TSX" src/worker.ts
    ;;
  *)
    echo "PALLETDOCK_SERVICE must be 'api' or 'worker'." >&2
    exit 64
    ;;
esac
