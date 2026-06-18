#!/usr/bin/env bash
# All-in-one entrypoint for the subkit image: bootstrap state, optionally
# start an embedded PostgreSQL, then run the engine. Everything lives under
# the single /data volume so one mount preserves state across restarts.
#
# Modes:
#   • Embedded DB (default) — no DATABASE_URL set: initdb on first boot,
#     start a local PostgreSQL, create the subkit role/db, point the engine
#     at it. Easiest onramp; app + db in one container.
#   • External DB — DATABASE_URL provided: skip PostgreSQL entirely and
#     connect to the operator's database (production-shaped topology).
set -euo pipefail

log() { printf '[subkit] %s\n' "$*" >&2; }

DATA_DIR=/data
CONFIG_DIR="$DATA_DIR/config"
BLOBS_DIR="$DATA_DIR/blobs"
export PGDATA="${PGDATA:-$DATA_DIR/pgdata}"
export SUBKIT_CONFIG="${SUBKIT_CONFIG:-$CONFIG_DIR/subkit.config.json}"
export NODE_ENV="${NODE_ENV:-production}"
# The container is the trust boundary; bind all interfaces so Docker's
# published-port mapping can reach the engine (loopback-only is unreachable
# through `-p`). resolveListenHostname() honours this override.
export ENGINE_LISTEN_HOST="${ENGINE_LISTEN_HOST:-0.0.0.0}"

# Default file storage to a persistent path inside the volume unless the
# operator overrode it. These are the engine's standard config-leaf overrides.
export SK_OVERRIDE_STORAGE__FILES__BACKEND="${SK_OVERRIDE_STORAGE__FILES__BACKEND:-local}"
export SK_OVERRIDE_STORAGE__FILES__DIR="${SK_OVERRIDE_STORAGE__FILES__DIR:-$BLOBS_DIR}"

mkdir -p "$CONFIG_DIR" "$BLOBS_DIR" "$PGDATA" "${HOME:-/data/home}"
chown -R postgres:postgres "$DATA_DIR"

# --- MASTER_KEY: env > persisted > generated ------------------------------
# Auto-generate on first boot for a frictionless trial, but PERSIST it so
# restarts can still decrypt stored credentials. Production operators should
# supply their own MASTER_KEY (lose it and every encrypted credential is
# unrecoverable).
KEY_FILE="$CONFIG_DIR/master.key"
if [ -z "${MASTER_KEY:-}" ]; then
  if [ -s "$KEY_FILE" ]; then
    MASTER_KEY="$(cat "$KEY_FILE")"
    log "loaded persisted MASTER_KEY from $KEY_FILE"
  else
    MASTER_KEY="$(openssl rand -hex 32)"
    ( umask 077; printf '%s' "$MASTER_KEY" >"$KEY_FILE" )
    chown postgres:postgres "$KEY_FILE"
    log "generated a new MASTER_KEY and persisted it to $KEY_FILE"
    log "WARNING: for production set MASTER_KEY yourself — losing this key makes stored credentials unrecoverable."
  fi
fi
export MASTER_KEY

# --- Database -------------------------------------------------------------
EMBEDDED_PG=0
if [ -z "${DATABASE_URL:-}" ]; then
  EMBEDDED_PG=1
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "initializing embedded PostgreSQL cluster at $PGDATA"
    chmod 700 "$PGDATA"
    gosu postgres initdb -D "$PGDATA" --username=postgres \
      --auth-local=trust --auth-host=trust >/dev/null
    # Loopback-only: the engine connects over 127.0.0.1 inside the container.
    echo "listen_addresses = '127.0.0.1'" >>"$PGDATA/postgresql.conf"
  fi

  log "starting embedded PostgreSQL"
  gosu postgres pg_ctl -D "$PGDATA" -w -t 60 start >/dev/null

  # Idempotently ensure the subkit role + database exist.
  if ! gosu postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='subkit'" | grep -q 1; then
    gosu postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE subkit LOGIN PASSWORD 'subkit'" >/dev/null
  fi
  if ! gosu postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='subkit'" | grep -q 1; then
    gosu postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE subkit OWNER subkit" >/dev/null
  fi

  export DATABASE_URL="postgres://subkit:subkit@127.0.0.1:5432/subkit"
  log "embedded database ready"
else
  log "using external DATABASE_URL — embedded PostgreSQL disabled"
fi

# Persist the resolved bootstrap env so the engine/sk wrappers can make
# one-off `docker exec` invocations (e.g. `engine --issue-admin-key`) work
# without the operator re-supplying DATABASE_URL/MASTER_KEY. The static
# vars (NODE_ENV, SUBKIT_CONFIG, …) are already in the image ENV and thus
# inherited by docker exec; only the dynamic ones need persisting.
RUNTIME_ENV="$CONFIG_DIR/runtime.env"
( umask 077; {
  printf 'DATABASE_URL=%q\n' "$DATABASE_URL"
  printf 'MASTER_KEY=%q\n' "$MASTER_KEY"
  printf 'SK_OVERRIDE_STORAGE__FILES__BACKEND=%q\n' "$SK_OVERRIDE_STORAGE__FILES__BACKEND"
  printf 'SK_OVERRIDE_STORAGE__FILES__DIR=%q\n' "$SK_OVERRIDE_STORAGE__FILES__DIR"
} >"$RUNTIME_ENV" )
chown postgres:postgres "$RUNTIME_ENV"

cat >&2 <<'BANNER'
──────────────────────────────────────────────────────────────────────
 subkit engine — starting
   API    : http://localhost:3000   (publish with -p 3000:3000)
   Health : GET /v1/health
 First-run onboarding (a one-time `sk init --token …` banner with the
 bootstrap token is printed below once the engine is up):
   1. copy the token from this log
   2. docker exec <container> sk init --token <token> \
          --admin-email you@example.com --tenant-name "My Org" \
          --llm-provider anthropic --llm-api-key sk-ant-…
 More keys later:  docker exec <container> engine --issue-admin-key --tenant <slug>
──────────────────────────────────────────────────────────────────────
BANNER

# The engine auto-runs migrations and starts the in-Postgres job queue on
# boot — no separate migrate/seed step. Run it as `postgres` (owns /data).
if [ "$EMBEDDED_PG" = "0" ]; then
  # External DB: nothing local to tear down — exec so the engine is PID 1
  # and receives Docker's signals directly.
  exec gosu postgres /usr/local/bin/engine.bin "$@"
fi

# Embedded DB: keep this shell as PID 1 so we can stop PostgreSQL cleanly
# when the engine exits or the container is signalled.
gosu postgres /usr/local/bin/engine.bin "$@" &
ENGINE_PID=$!

stop_pg() {
  gosu postgres pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
}
forward_term() { kill -TERM "$ENGINE_PID" 2>/dev/null || true; }
trap forward_term TERM INT

set +e
wait "$ENGINE_PID"; code=$?
# `wait` returns early when a trapped signal fires; loop until the engine
# actually exits so we capture its real status before stopping PostgreSQL.
while kill -0 "$ENGINE_PID" 2>/dev/null; do
  wait "$ENGINE_PID"; code=$?
done
set -e

log "engine exited (code $code) — stopping PostgreSQL"
stop_pg
exit "$code"
