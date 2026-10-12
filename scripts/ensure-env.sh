#!/usr/bin/env sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
PKG_VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo "0.0.0-dev")

stamp_version() {
  if grep -qE '^ENGINE_VERSION=' "$ENV_FILE"; then
    sed -i.bak "s/^ENGINE_VERSION=.*/ENGINE_VERSION=$PKG_VERSION/" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '\nENGINE_VERSION=%s\n' "$PKG_VERSION" >>"$ENV_FILE"
  fi
}

validate_database_password() {
  password=${SUBKIT_DB_PASSWORD-}
  if [ -z "$password" ] && [ -f "$ENV_FILE" ]; then
    password=$(sed -n 's/^SUBKIT_DB_PASSWORD=//p' "$ENV_FILE" | tail -n 1)
  fi
  if [ -z "$password" ]; then
    return 0
  fi
  case "$password" in
    *[!A-Za-z0-9._~-]*)
      echo "[subkit] SUBKIT_DB_PASSWORD must use URL-unreserved characters only" >&2
      return 1
      ;;
  esac
}

if [ -f "$ENV_FILE" ]; then
  validate_database_password
  stamp_version
  exit 0
fi

cp "$REPO_ROOT/.env.example" "$ENV_FILE"

MASTER_KEY=$(openssl rand -hex 32)
sed -i.bak "s/^MASTER_KEY=.*/MASTER_KEY=$MASTER_KEY/" "$ENV_FILE"
rm -f "$ENV_FILE.bak"

validate_database_password
stamp_version

echo "[subkit] created .env with auto-generated MASTER_KEY (engine v$PKG_VERSION)"
echo "[subkit] complete POST /v1/setup, then manage runtime settings and versioned secrets through the API, CLI, MCP, or Cockpit"
