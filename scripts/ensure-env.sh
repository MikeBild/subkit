#!/usr/bin/env sh
# Create .env from .env.example with an auto-generated MASTER_KEY if .env
# does not already exist. Idempotent — safe to call on every compose:up.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

[ -f "$ENV_FILE" ] && exit 0

cp "$REPO_ROOT/.env.example" "$ENV_FILE"

MASTER_KEY=$(openssl rand -hex 32)
sed -i.bak "s/^MASTER_KEY=.*/MASTER_KEY=$MASTER_KEY/" "$ENV_FILE"
rm -f "$ENV_FILE.bak"

echo "[subkit] created .env with auto-generated MASTER_KEY"
echo "[subkit] edit .env to set AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL or LLM_PROVIDER + matching provider secrets"
