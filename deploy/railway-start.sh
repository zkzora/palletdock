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
  all)
    # One container for hosts with a single free instance and no pre-deploy step:
    # migrate, keep the worker running in the background (restarted if it exits),
    # and run the API in the foreground so the host's health check follows it.
    sh "$APP/deploy/railway-migrate.sh"
    (
      cd "$APP/apps/worker"
      while :; do
        PALLETDOCK_PROCESS=palletdock-worker "$TSX" src/worker.ts || true
        echo "[start] worker exited; restarting in 5 s" >&2
        sleep 5
      done
    ) &
    cd "$APP/apps/api"
    PALLETDOCK_PROCESS=palletdock-api exec "$TSX" src/server.ts
    ;;
  *)
    echo "PALLETDOCK_SERVICE must be 'api', 'worker' or 'all'." >&2
    exit 64
    ;;
esac
