#!/usr/bin/env sh
# engine-rebuild — one-shot rebuild + redeploy of the engine docker
# container with a post-redeploy version-skew check.
#
# Why this exists: waves 5–9 reproduced the same failure pattern —
# fix lands in source, source tests pass, but the running docker
# container is still on an older image. The CLI version-mismatch
# banner now flags this at runtime; this script makes the rebuild
# itself a one-command operation so the operator never has to
# remember the exact `docker compose` invocation. Mirrors the
# reference impl's `engine:up --build --force-recreate` recipe.
#
# Usage:
#   bun run engine:rebuild
#   bun run docker:engine:rebuild   # alias
#
# Exit codes:
#   0 — rebuild + redeploy succeeded, version matches package.json
#   1 — rebuild failed
#   2 — redeploy succeeded but version skew remains (compose / build
#       cache / different docker daemon)

set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

CLI_VERSION=$(node -p 'require("./package.json").version' 2>/dev/null || echo "unknown")

echo "↻ engine:rebuild — rebuilding the engine container against package.json v$CLI_VERSION"
echo

if [ -f scripts/ensure-env.sh ]; then
  sh scripts/ensure-env.sh
fi

# Export ENGINE_VERSION so docker-compose substitutes the
# `${ENGINE_VERSION:-0.0.0-dev}` placeholder in docker-compose.yml's
# `args` and `environment` blocks. Without this the container reports
# `0.0.0-dev` regardless of what package.json says — exactly the skew
# the user hit at the start of session f00b8d1c.
export ENGINE_VERSION="$CLI_VERSION"

docker compose build --no-cache engine
docker compose up -d --force-recreate engine

# Wait for /v1/health then compare /v1/status.version. Loop a small
# number of times because docker compose returns before the engine
# has bound the port; we don't want to fail eagerly on a 1s race.
echo
echo "↻ verifying version after redeploy…"
PORT="${SUBKIT_PORT:-3000}"
ATTEMPT=1
MAX_ATTEMPTS=20
ENGINE_VERSION=""
while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  ENGINE_VERSION=$(curl -sf "http://localhost:$PORT/v1/health" 2>/dev/null \
    | node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf-8")).version??"")}catch{process.stdout.write("")}' 2>/dev/null || echo "")
  if [ -n "$ENGINE_VERSION" ]; then
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 0.5
done

if [ -z "$ENGINE_VERSION" ]; then
  echo "⚠ engine did not respond on /v1/health within $((MAX_ATTEMPTS / 2))s"
  echo "  check: docker compose logs -f engine"
  exit 2
fi

if [ "$ENGINE_VERSION" = "$CLI_VERSION" ]; then
  echo "✓ engine v$ENGINE_VERSION — matches package.json v$CLI_VERSION"
  exit 0
fi

echo "⚠ skew remains: engine reports v$ENGINE_VERSION, package.json is v$CLI_VERSION"
echo "  this usually means a build-cache miss — try:"
echo "    docker compose down -v && bun run docker:engine:rebuild"
exit 2
