#!/bin/sh
set -eu

case "${PALLETDOCK_SERVICE:-}" in
  api)
    exec pnpm --filter @palletdock/api start
    ;;
  worker)
    exec pnpm --filter @palletdock/worker start
    ;;
  *)
    echo "PALLETDOCK_SERVICE must be 'api' or 'worker'." >&2
    exit 64
    ;;
esac
