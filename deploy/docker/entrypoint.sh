#!/usr/bin/env bash
# Stateless application bootstrap. PostgreSQL and the product object-store
# bucket are the only durable state owners; this container uses /tmp as scratch.
set -euo pipefail

log() { printf '[subkit] %s\n' "$*" >&2; }

export NODE_ENV="${NODE_ENV:-production}"
# The container is the trust boundary; bind all interfaces so Docker's
# published-port mapping can reach the engine (loopback-only is unreachable
# through `-p`). resolveListenHostname() honours this override.
export ENGINE_LISTEN_HOST="${ENGINE_LISTEN_HOST:-0.0.0.0}"

export CONFIGURATION_DIRECTORY="${CONFIGURATION_DIRECTORY:-/tmp/subkit-state}"
export STATE_DIRECTORY="${STATE_DIRECTORY:-/tmp/subkit-state}"
mkdir -p "$CONFIGURATION_DIRECTORY" "$STATE_DIRECTORY" "${HOME:-/tmp/subkit-home}"

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

# Some container platforms expose managed database bindings through a component
# variable and may alias the same value to DATABASE_URL. Preserve an explicitly
# supplied URL and apply compatibility options only to the unchanged binding.
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

# --- MASTER_KEY: env or secret-file binding -------------------------------
if [ -n "${MASTER_KEY_FILE:-}" ]; then
  file_master_key="$(read_secret_file MASTER_KEY "$MASTER_KEY_FILE")"
  if [ -n "${MASTER_KEY:-}" ] && [ "$MASTER_KEY" != "$file_master_key" ]; then
    log "MASTER_KEY and MASTER_KEY_FILE disagree"
    exit 64
  fi
  MASTER_KEY="$file_master_key"
fi
if [ -z "${MASTER_KEY:-}" ]; then
  log "MASTER_KEY or MASTER_KEY_FILE is required; stateless containers never generate or persist it"
  exit 64
fi
export MASTER_KEY
log "using external PostgreSQL"

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
