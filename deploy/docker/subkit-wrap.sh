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

apply_managed_database_tls_contract() {
  [ -n "${UPRAFT_DB_PRIMARY_URL:-}" ] || return 0
  [ "${DATABASE_URL:-}" = "$UPRAFT_DB_PRIMARY_URL" ] || return 0
  if [ "${NODE_EXTRA_CA_CERTS+x}" = x ] || [ "${SSL_CERT_FILE+x}" = x ] ||
    [ "${SSL_CERT_DIR+x}" = x ] || [ "${PGSSLROOTCERT+x}" = x ] ||
    [ "${PGSSLMODE+x}" = x ]; then
    return 0
  fi
  case "$DATABASE_URL" in
    *\#*|*$'\n'*|*$'\r'*) return 0 ;;
    postgres://*\?*|postgresql://*\?*) ;;
    *) return 0 ;;
  esac
  local query="${DATABASE_URL#*\?}" key value parameter encoded seen="|" mode=""
  case "$query" in
    *$'\n'*|*$'\r'*|*\#*|*\?*|*\;*|*\&|\&*) return 0 ;;
  esac
  local parameters=()
  IFS='&' read -r -a parameters <<< "$query"
  for parameter in "${parameters[@]}"; do
    [[ "$parameter" = *=* ]] || return 0
    key="${parameter%%=*}"
    value="${parameter#*=}"
    case "$seen" in *"|$key|"*) return 0 ;; esac
    seen="$seen$key|"
    case "$key" in
      sslmode) mode="$value" ;;
      application_name|options)
        encoded="$value"
        while [[ "$encoded" = *%* ]]; do
          encoded="${encoded#*%}"
          [[ "$encoded" =~ ^[0-9A-Fa-f][0-9A-Fa-f] ]] || return 0
          encoded="${encoded:2}"
        done
        ;;
      connect_timeout)
        case "$value" in *%*) return 0 ;; esac
        ;;
      *) return 0 ;;
    esac
  done
  [ "$mode" = "require" ] || return 0
  export DATABASE_URL="${DATABASE_URL}&uselibpqcompat=true"
}

apply_managed_database_tls_contract

exec "/usr/local/bin/$(basename "$0").bin" "$@"
