#!/usr/bin/env bash
#
# Post-deploy verification. Three stages, all abort-on-fail:
#
#   1. Poll /v1/health until `version` matches the just-deployed tag
#      (proves the droplet actually flipped, not the prior container
#      still serving from the old image).
#   2. Run the existing smoke script against the deploy URL.
#   3. Tail engine logs for new errors in the last 2 min.
#
# Env:
#   VERSION      — semver to verify (default: current_version from manifest)
#   DEPLOY_URL   — base URL (default: https://subkit-api.mikebild.dev)
#   DROPLET_HOST — for log tail (default: via doctl compute ssh; see below)
#
# Exit 0 = all three green. Exit 1 = health mismatch, smoke fail, or
# new error lines surfaced in the log window.

set -euo pipefail

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./version.sh
source "$_SCRIPT_DIR/version.sh"
REPO_ROOT=$(cd "$_SCRIPT_DIR/../.." && pwd)

VERSION="${VERSION:-$(current_version)}"
DEPLOY_URL="${DEPLOY_URL:-https://subkit-api.mikebild.dev}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-90}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"

msg() { printf '\033[1;36m[release/verify]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[release/verify]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[release/verify]\033[0m %s\n' "$*" >&2; }

# 1. Wait for /v1/health.version == VERSION.
msg "poll $DEPLOY_URL/v1/health for version=$VERSION (timeout ${HEALTH_TIMEOUT_SECS}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
while :; do
  body=$(curl -fsS --max-time 5 "$DEPLOY_URL/v1/health" 2>/dev/null || true)
  live_version=$(printf '%s' "$body" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).version||'')}catch{process.stdout.write('')}})" 2>/dev/null || true)
  if [ "$live_version" = "$VERSION" ]; then
    ok "/v1/health reports version=$VERSION"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    err "timeout: /v1/health stuck on '$live_version' (expected '$VERSION')"
    exit 1
  fi
  sleep 3
done

# 2. Smoke script.
msg "running scripts/smoke.sh"
if ! "$REPO_ROOT/scripts/smoke.sh" "$DEPLOY_URL" "$VERSION"; then
  err "smoke.sh failed"
  exit 1
fi
ok "smoke green"

# 3. Engine log tail — last 2 min, any new error/fatal levels.
#    Uses `doctl compute ssh` so we don't need to resolve the droplet
#    IP ourselves; the operator's doctl auth is the only dep.
msg "scanning engine logs for errors in the last 2 min"
LOGS=$(
  doctl compute ssh "$DROPLET_NAME" --ssh-command \
    "cd /opt/subkit && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs engine --since 2m 2>&1 || true" \
    2>/dev/null || true
)
ERR_LINES=$(printf '%s\n' "$LOGS" | grep -E '"level":"(error|fatal)"' || true)
if [ -n "$ERR_LINES" ]; then
  err "engine log has new error/fatal entries:"
  printf '%s\n' "$ERR_LINES" | head -20 >&2
  exit 1
fi
ok "engine log clean (no error/fatal frames in last 2m)"

ok "verify complete — $DEPLOY_URL is live on $VERSION"
