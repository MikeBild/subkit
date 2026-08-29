#!/usr/bin/env bash
# Application bootstrap for the subkit image. PostgreSQL is intentionally an
# external service; this process only owns product state below /data.
set -euo pipefail

log() { printf '[subkit] %s\n' "$*" >&2; }

DATA_DIR=/data
CONFIG_DIR="$DATA_DIR/config"
BLOBS_DIR="$DATA_DIR/blobs"
export SUBKIT_CONFIG="${SUBKIT_CONFIG:-$CONFIG_DIR/subkit.config.json}"
export NODE_ENV="${NODE_ENV:-production}"
# The container is the trust boundary; bind all interfaces so Docker's
# published-port mapping can reach the engine (loopback-only is unreachable
# through `-p`). resolveListenHostname() honours this override.
export ENGINE_LISTEN_HOST="${ENGINE_LISTEN_HOST:-0.0.0.0}"

# Default file storage to a persistent path inside the volume unless the
# operator overrode it. These are the engine's standard config-leaf overrides.
# NOTE: the loader maps SK_OVERRIDE_<PATH> with a SINGLE underscore between
# path segments (envKeyForLeaf joins leaf.path with "_"), so the leaf
# storage.files.dir is SK_OVERRIDE_STORAGE_FILES_DIR — NOT double underscores.
export SK_OVERRIDE_STORAGE_FILES_BACKEND="${SK_OVERRIDE_STORAGE_FILES_BACKEND:-local}"
export SK_OVERRIDE_STORAGE_FILES_DIR="${SK_OVERRIDE_STORAGE_FILES_DIR:-$BLOBS_DIR}"

# Point the engine's boot-dependency fs-write probe at the real state dirs on
# the volume. Without these (systemd convention) the probe falls back to
# /etc/subkit + /var/lib/subkit — absent and unwritable in this image — and
# emits alarming but meaningless EACCES warnings on every boot. SUBKIT_CONFIG
# already pins the actual config path, so this only steers the probe.
export CONFIGURATION_DIRECTORY="${CONFIGURATION_DIRECTORY:-$CONFIG_DIR}"
export STATE_DIRECTORY="${STATE_DIRECTORY:-$DATA_DIR}"

mkdir -p "$CONFIG_DIR" "$BLOBS_DIR" "${HOME:-/data/home}"

read_secret_file() {
  name="$1"
  path="$2"
  [ -r "$path" ] || { log "$name file is not readable: $path"; exit 64; }
  value="$(cat "$path")"
  [ -n "$value" ] || { log "$name file is empty: $path"; exit 64; }
  printf '%s' "$value"
}

if [ -n "${DATABASE_URL_FILE:-}" ]; then
  file_database_url="$(read_secret_file DATABASE_URL "$DATABASE_URL_FILE")"
  if [ -n "${DATABASE_URL:-}" ] && [ "$DATABASE_URL" != "$file_database_url" ]; then
    log "DATABASE_URL and DATABASE_URL_FILE disagree"
    exit 64
  fi
  export DATABASE_URL="$file_database_url"
fi

# Upraft exposes managed database bindings under a stable component variable
# and may alias the same URL to DATABASE_URL. Its `sslmode=require` endpoint
# uses a platform certificate, so request libpq-compatible encryption semantics
# only when the value is the unmodified Upraft-provided binding.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${UPRAFT_DB_PRIMARY_URL:-}" ]; then
  export DATABASE_URL="$UPRAFT_DB_PRIMARY_URL"
fi
if [ -n "${UPRAFT_DB_PRIMARY_URL:-}" ] && [ "${DATABASE_URL:-}" = "$UPRAFT_DB_PRIMARY_URL" ]; then
  case "$DATABASE_URL" in
    *sslmode=require*uselibpqcompat=*) ;;
    *sslmode=require*) export DATABASE_URL="${DATABASE_URL}&uselibpqcompat=true" ;;
  esac
fi
[ -n "${DATABASE_URL:-}" ] || {
  log "DATABASE_URL or DATABASE_URL_FILE is required; PostgreSQL is not bundled in this image"
  exit 64
}

# --- MASTER_KEY: env > persisted > generated ------------------------------
# Auto-generate on first boot for a frictionless trial, but PERSIST it so
# restarts can still decrypt stored credentials. Production operators should
# supply their own MASTER_KEY (lose it and every encrypted credential is
# unrecoverable).
KEY_FILE="${MASTER_KEY_PERSIST_FILE:-$CONFIG_DIR/master.key}"
if [ -n "${MASTER_KEY_FILE:-}" ]; then
  file_master_key="$(read_secret_file MASTER_KEY "$MASTER_KEY_FILE")"
  if [ -n "${MASTER_KEY:-}" ] && [ "$MASTER_KEY" != "$file_master_key" ]; then
    log "MASTER_KEY and MASTER_KEY_FILE disagree"
    exit 64
  fi
  MASTER_KEY="$file_master_key"
fi
if [ -z "${MASTER_KEY:-}" ]; then
  if [ -s "$KEY_FILE" ]; then
    MASTER_KEY="$(cat "$KEY_FILE")"
    log "loaded persisted MASTER_KEY from $KEY_FILE"
  else
    MASTER_KEY="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
    ( umask 077; printf '%s' "$MASTER_KEY" >"$KEY_FILE" )
    log "generated a new MASTER_KEY and persisted it to $KEY_FILE"
    log "WARNING: for production set MASTER_KEY yourself — losing this key makes stored credentials unrecoverable."
  fi
fi
export MASTER_KEY
log "using external PostgreSQL"

# Persist the resolved bootstrap env so the engine/sk wrappers can make
# one-off `docker exec` invocations (e.g. `engine --issue-admin-key`) work
# without the operator re-supplying DATABASE_URL/MASTER_KEY. The static
# vars (NODE_ENV, SUBKIT_CONFIG, …) are already in the image ENV and thus
# inherited by docker exec; only the dynamic ones need persisting.
RUNTIME_ENV="$CONFIG_DIR/runtime.env"
( umask 077; {
  printf 'DATABASE_URL=%q\n' "$DATABASE_URL"
  printf 'MASTER_KEY=%q\n' "$MASTER_KEY"
  printf 'SK_OVERRIDE_STORAGE_FILES_BACKEND=%q\n' "$SK_OVERRIDE_STORAGE_FILES_BACKEND"
  printf 'SK_OVERRIDE_STORAGE_FILES_DIR=%q\n' "$SK_OVERRIDE_STORAGE_FILES_DIR"
} >"$RUNTIME_ENV" )

cat >&2 <<'BANNER'
──────────────────────────────────────────────────────────────────────
 subkit engine — starting
   API    : http://localhost:3000   (publish with -p 127.0.0.1:3000:3000)
   Health : GET /health
   Ready  : GET /ready
 First-run onboarding (a one-time `sk init --token …` banner with the
 bootstrap token is printed below once the engine is up):
   1. copy the token from this log
   2. docker exec <container> sk init --token <token> \
          --admin-email you@example.com --tenant-name "My Org" \
          --llm-provider anthropic --llm-api-key sk-ant-…
 More keys later:  docker exec <container> engine --issue-admin-key --tenant <slug>
──────────────────────────────────────────────────────────────────────
BANNER

# The engine auto-runs its embedded migrations before accepting traffic.
exec /usr/local/bin/engine.bin "$@"
