#!/usr/bin/env bash
# Start a throwaway Postgres inside the sandbox and print its connection string.
#
# The agent runs unprivileged and there is no Docker in the sandbox, so tickets whose acceptance needs a
# real database (integration tests and everything behind them) had nowhere to run. initdb/pg_ctl work fine as a normal
# user provided the data directory is ours, so this gives each run its own cluster under the workspace.
#
#   eval "$(pg-scratch)"      # exports DATABASE_URL
#   psql "$DATABASE_URL" -c 'select 1'
#
# Idempotent: starting twice reuses the running cluster. Dies with the sandbox; nothing to clean up.
set -euo pipefail
DATA="${PG_SCRATCH_DATA:-${WORKSPACE_DIR:-/workspace}/.pg-scratch}"
PORT="${PG_SCRATCH_PORT:-5433}"
SOCK="${PG_SCRATCH_SOCK:-/tmp/pg-scratch}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -n "$BIN" ] || { echo "no postgres server installed in this image" >&2; exit 1; }
export PATH="$BIN:$PATH"
mkdir -p "$SOCK"

if ! pg_ctl -D "$DATA" status >/dev/null 2>&1; then
  [ -d "$DATA/base" ] || initdb -D "$DATA" -U postgres --auth=trust >/dev/null
  pg_ctl -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=127.0.0.1" -l "$DATA/server.log" -w start >/dev/null
fi
createdb -h 127.0.0.1 -p "$PORT" -U postgres scratch 2>/dev/null || true
echo "export DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/scratch"
