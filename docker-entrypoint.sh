#!/bin/sh
set -eu
node dist/migrate-cli.js
exec node dist/server.js
