#!/usr/bin/env sh
# Create .env from .env.example with an auto-generated MASTER_KEY if .env
# does not already exist. Idempotent — safe to call on every compose:up.
#
# Also stamps ENGINE_VERSION into .env from package.json so `bun run dev`
# reports the right version. Without this, the engine binary falls back
# to `0.0.0-dev` and the CLI shows the "engine is older than this CLI"
# banner on every restart — even right after a fresh checkout.
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
echo "[subkit] edit .env to set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL or LLM_PROVIDER + matching provider secrets"
