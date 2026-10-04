#!/usr/bin/env bash
set -euo pipefail

if [ -n "${DATABASE_URL_FILE:-}" ] && [ -r "$DATABASE_URL_FILE" ]; then
  export DATABASE_URL="$(cat "$DATABASE_URL_FILE")"
fi
if [ -n "${MASTER_KEY_FILE:-}" ] && [ -r "$MASTER_KEY_FILE" ]; then
  export MASTER_KEY="$(cat "$MASTER_KEY_FILE")"
fi
if [ -z "${DATABASE_URL:-}" ] && [ -n "${UPRAFT_DB_PRIMARY_URL:-}" ]; then
  export DATABASE_URL="$UPRAFT_DB_PRIMARY_URL"
fi
if [ -n "${UPRAFT_DB_PRIMARY_URL:-}" ] && [ "${DATABASE_URL:-}" = "$UPRAFT_DB_PRIMARY_URL" ]; then
  case "$DATABASE_URL" in
    *sslmode=require*uselibpqcompat=*) ;;
    *sslmode=require*) export DATABASE_URL="${DATABASE_URL}&uselibpqcompat=true" ;;
  esac
fi

exec "/usr/local/bin/$(basename "$0").bin" "$@"
