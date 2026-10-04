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

if [ -f "$ENV_FILE" ]; then
  stamp_version
  exit 0
fi

cp "$REPO_ROOT/.env.example" "$ENV_FILE"

MASTER_KEY=$(openssl rand -hex 32)
sed -i.bak "s/^MASTER_KEY=.*/MASTER_KEY=$MASTER_KEY/" "$ENV_FILE"
rm -f "$ENV_FILE.bak"

stamp_version

echo "[subkit] created .env with auto-generated MASTER_KEY (engine v$PKG_VERSION)"
echo "[subkit] complete POST /v1/setup, then manage runtime settings and versioned secrets through the API, CLI, MCP, or Cockpit"
