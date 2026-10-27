#!/bin/sh
set -eu
node dist/migrate-cli.js
if [ "${BOOTSTRAP_SYNTHETIC_USERS:-true}" = "true" ]; then
  node dist/bootstrap-local.js --synthetic-defaults
fi
exec node dist/server.js
