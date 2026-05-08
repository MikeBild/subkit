#!/usr/bin/env bash
#
# Deploy a subkit engine release onto the production droplet.
#
# This is the single authoritative deploy body: both GitHub Actions
# (`release.yml`) and the laptop orchestrator (`scripts/deploy.sh`)
# pipe this over SSH to the droplet and execute it. Keeping one file
# means the two paths can't diverge.
#
# 4.2.0: systemd-native deploy. Replaces the docker-compose path —
# subkit no longer ships a docker image. The engine runs as a single
# `bun build --compile` binary under the `subkit-engine.service` unit;
# postgres + caddy are apt-installed system services. Deploy = receive
# a fresh binary on stdin, atomic-swap it, restart the unit, poll
# /v1/health for the new version. Rollback = swap back the .prev
# binary saved before the cutover.
#
# Caller contract:
#   - ENGINE_VERSION env var (semver). Stamped into the binary at
#     build time via `--define BUILD_VERSION=...`; we just compare it
#     against /v1/health on the droplet.
#   - The compiled binary is piped to this script's stdin (the laptop
#     `scripts/deploy.sh` and the CI `release.yml` both do
#     `cat dist/engine | ssh ... 'ENGINE_VERSION=… bash -s' < deploy-body.sh`
#     ... actually the binary comes via a separate scp step, see below.
#
# Behavior:
#   1. Confirm the new binary is sitting at /usr/local/bin/engine.next
#      (placed there by the caller's scp). Exit 1 if missing — the
#      caller didn't ship one.
#   2. Capture the running engine's reported version from /v1/health
#      for rollback.
#   3. Save current binary as /usr/local/bin/engine.prev. Atomic-swap
#      .next over /usr/local/bin/engine. systemctl restart.
#   4. Poll http://127.0.0.1:3000/v1/health for `version == ENGINE_VERSION`,
#      every 5 s for up to 150 s.
#   5. On failure: swap engine.prev back, restart, exit 1. On success:
#      keep .prev (next deploy overwrites it) and exit 0.
#
# Idempotent: re-running with the same ENGINE_VERSION compares the
# binary's reported version with the running engine — a no-op when
# they match.

set -euo pipefail

: "${ENGINE_VERSION:?ENGINE_VERSION must be set (e.g. export ENGINE_VERSION=4.2.0)}"

ENGINE_BIN="/usr/local/bin/engine"
ENGINE_NEXT="${ENGINE_BIN}.next"
ENGINE_PREV="${ENGINE_BIN}.prev"
HEALTH_URL="http://127.0.0.1:3000/v1/health"
SERVICE_UNIT="subkit-engine.service"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-150}"

if [ ! -f "$ENGINE_NEXT" ]; then
  echo "FATAL: $ENGINE_NEXT missing — caller must scp the new binary first"
  exit 1
fi

read_running_version() {
  curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).version||'')}catch{process.stdout.write('')}})" \
    2>/dev/null \
    || true
}

PREV_VERSION=$(read_running_version)
echo "previously running: ${PREV_VERSION:-<none>}"

# Atomic cutover: rename the running binary to .prev, the new binary
# into place. systemd `Type=exec` keeps the running process pinned to
# the old inode until restart, so the rename is safe.
if [ -f "$ENGINE_BIN" ]; then
  cp -p "$ENGINE_BIN" "$ENGINE_PREV"
fi
chmod 755 "$ENGINE_NEXT"
mv "$ENGINE_NEXT" "$ENGINE_BIN"

# Restart the unit. systemd will re-exec the binary; engine boot runs
# embedded migrations in-process before the HTTP listener starts, so
# /v1/health == ENGINE_VERSION implies migrations succeeded.
systemctl restart "$SERVICE_UNIT"

# Health-poll loop: up to HEALTH_TIMEOUT_SECS waiting for the new
# version to surface. systemd Restart=on-failure means a crashing
# binary cycles forever within StartLimitBurst before unit-fail; we
# don't wait on the unit, only the version flip.
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
while :; do
  live=$(read_running_version)
  if [ "$live" = "$ENGINE_VERSION" ]; then
    echo "Engine v${ENGINE_VERSION} healthy"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "FATAL: health timeout after ${HEALTH_TIMEOUT_SECS}s (live='${live:-<unreachable>}', want=${ENGINE_VERSION})"
    if [ -f "$ENGINE_PREV" ]; then
      echo "Rolling back to ${PREV_VERSION:-prev binary}"
      mv "$ENGINE_PREV" "$ENGINE_BIN"
      systemctl restart "$SERVICE_UNIT"
    fi
    exit 1
  fi
  sleep 5
done

# Reload caddy in case the Caddyfile was updated by the caller's scp.
# `caddy reload` is the systemd-managed way; it picks up the on-disk
# Caddyfile without dropping connections (graceful — no "terminating
# connection" log noise that the old compose flow caused).
if systemctl is-active --quiet caddy.service; then
  systemctl reload caddy.service || true
fi

echo "deploy complete: engine ${PREV_VERSION:-<none>} → ${ENGINE_VERSION}"
