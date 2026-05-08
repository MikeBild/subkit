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
#                    registry.digitalocean.com/subkit/engine:<ver>
#   /opt/subkit/.env — bound at rest; contains DATABASE_URL, MASTER_KEY,
#                      AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL or
#                      LLM_PROVIDER + matching provider credentials. Not touched here.
#
# Behavior:
#   1. Log in to DOCR (600 s token), retrying transient registry errors.
#   2. Capture the currently-running container's ENGINE_VERSION for rollback.
#   3. Pull the engine image, retrying transient registry errors.
#   4. Recreate engine (`--no-deps` so the engine is the only thing
#      recreated — postgres and peers stay live). The engine binary
#      runs migrations + seed in-process on every boot (issue #149);
#      a migration failure aborts boot and the HEALTHCHECK never goes
#      `healthy`, which triggers the rollback below.
#   5. Poll Docker's HEALTHCHECK status every 5 s for up to 150 s.
#      On failure, restart engine from the previous version and exit non-zero.
#   6. Bounce Caddy and prune dangling images.
#
# Idempotent: re-running with the same ENGINE_VERSION is a no-op (pull
# is already up to date, up -d won't recreate a healthy container).

set -euo pipefail

: "${ENGINE_VERSION:?ENGINE_VERSION must be set (e.g. export ENGINE_VERSION=1.6.7)}"

retry() {
  local attempts=$1
  shift
  local base_delay_secs=$1
  shift
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    local status=$?
    if [ "$attempt" -ge "$attempts" ]; then
      return "$status"
    fi
    echo "retry ${attempt}/${attempts} for: $*"
    sleep $((base_delay_secs * attempt))
    attempt=$((attempt + 1))
  done
}

cd /opt/subkit
retry 5 5 doctl registry login --expiry-seconds 600

export ENGINE_VERSION
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

compose_pull() {
  $COMPOSE pull engine
}

# Capture current version for rollback (empty if no engine is running).
PREV_VERSION=$(
  $COMPOSE ps -q engine 2>/dev/null |
    xargs -r docker inspect -f '{{index .Config.Env}}' 2>/dev/null |
    grep -oP 'ENGINE_VERSION=\K[^ ]+' || true
)

retry 5 5 compose_pull

# Recreate engine — migrations + seed run in-process on boot (issue
# #149).  A migration failure aborts boot via process.exit(1); the
# container goes unhealthy and the rollback path below catches it.
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

# Bring caddy up with --no-deps. Without it, compose traverses the
# dep tree (caddy → engine → postgres) and may decide to recreate
# postgres if the synced docker-compose.yml differs from what's on
# disk — even when the postgres service config itself is unchanged.
# That recreate cuts every engine connection ("terminating connection
# due to administrator command" + "ECONNREFUSED 172.18.0.2:5432" in
# pubsub/pg-boss/pool error handlers), and the verify log scan flags
# them as deploy failures even though the system fully recovers.
# --no-deps is safe here: engine is already healthy from the prior
# `up -d --no-deps engine` step, and caddy is the only thing being
# (re)started in this call.
$COMPOSE up -d --no-deps caddy
docker image prune -f
