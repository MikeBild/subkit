#!/usr/bin/env bash
#
# Deploy a subkit engine release onto the production droplet.
#
# This is the single authoritative deploy body: both GitHub Actions
# (`release.yml`) and the laptop orchestrator (`scripts/deploy.sh`)
# pipe this over SSH to the droplet and execute it. Keeping one file
# means the two paths can't diverge.
#
# Expected env on the droplet:
#   ENGINE_VERSION — semver (e.g. "1.6.7"); pulled from DOCR as
#                    registry.digitalocean.com/subkit/{engine,migrate}:<ver>
#   /opt/subkit/.env — bound at rest; contains DATABASE_URL, MASTER_KEY,
#                      ANTHROPIC_API_KEY, etc. Not touched here.
#
# Behavior:
#   1. Log in to DOCR (600 s token).
#   2. Capture the currently-running container's ENGINE_VERSION for rollback.
#   3. Pull the engine + migrate images.
#   4. Run migrations (aborts on failure before any engine restart).
#   5. Re-seed + restart engine (`--no-deps` so the engine is the only thing
#      recreated — postgres and peers stay live).
#   6. Poll Docker's HEALTHCHECK status every 5 s for up to 150 s.
#      On failure, restart engine from the previous version and exit non-zero.
#   7. Bounce Caddy and prune dangling images.
#
# Idempotent: re-running with the same ENGINE_VERSION is a no-op (pull
# is already up to date, up -d won't recreate a healthy container).

set -euo pipefail

: "${ENGINE_VERSION:?ENGINE_VERSION must be set (e.g. export ENGINE_VERSION=1.6.7)}"

cd /opt/subkit
doctl registry login --expiry-seconds 600

export ENGINE_VERSION
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

# Capture current version for rollback (empty if no engine is running).
PREV_VERSION=$(
  $COMPOSE ps -q engine 2>/dev/null |
    xargs -r docker inspect -f '{{index .Config.Env}}' 2>/dev/null |
    grep -oP 'ENGINE_VERSION=\K[^ ]+' || true
)

$COMPOSE pull engine migrate

# Run migrations — abort before touching the engine if they fail.
$COMPOSE up -d migrate
$COMPOSE wait migrate || { echo "FATAL: migration failed"; exit 1; }

$COMPOSE up -d seed
$COMPOSE up -d --no-deps engine

# Health check loop — 30 × 5 s = 150 s max.
# The prod compose override `!reset []`s the engine's host port publish,
# so the container is only reachable via the docker network. Use Docker's
# own HEALTHCHECK state, which matches `docker ps`'s healthy/unhealthy.
ENGINE_ID=$($COMPOSE ps -q engine)
for i in $(seq 1 30); do
  HEALTH=$(docker inspect -f '{{.State.Health.Status}}' "$ENGINE_ID" 2>/dev/null || echo "")
  if [ "$HEALTH" = "healthy" ]; then
    echo "Engine v${ENGINE_VERSION} healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FATAL: health check failed after 150s (state: ${HEALTH:-unknown})"
    if [ -n "$PREV_VERSION" ] && [ "$PREV_VERSION" != "$ENGINE_VERSION" ]; then
      echo "Rolling back to $PREV_VERSION"
      export ENGINE_VERSION="$PREV_VERSION"
      $COMPOSE up -d --no-deps engine
    fi
    exit 1
  fi
  sleep 5
done

$COMPOSE up -d caddy
docker image prune -f
