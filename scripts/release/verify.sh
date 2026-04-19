#!/usr/bin/env bash
#
# Post-deploy verification. Three stages, all abort-on-fail:
#
#   1. Poll /v1/health until `version` matches the just-deployed tag
#      (proves the droplet actually flipped, not the prior container
#      still serving from the old image).
#   2. Run the public smoke script against the deploy URL.
#   3. Run the authenticated remote-health smoke (diagnostics + conversation create).
#   4. Check authenticated diagnostics endpoints, including /v1/diagnostics/setup.
#   5. Tail engine logs for new errors in the last 2 min via ssh or doctl.
#
# Env:
#   VERSION      — semver to verify (default: current_version from manifest)
#   DEPLOY_URL   — base URL (default: https://subkit-api.mikebild.dev)
#   VERIFY_API_KEY — bearer token for diagnostics + authenticated smoke
#   SSH_HOST      — optional direct SSH target; preferred when set
#   DROPLET_NAME  — doctl fallback target for log tail
#   SKIP_AUTH_DIAGNOSTICS=1 — explicitly skip authenticated smoke/diagnostics
#   SKIP_REMOTE_LOGS=1      — explicitly skip ssh/doctl log verification
#
# Exit 0 = every verification stage green. Exit 1 = any stage failed.

set -euo pipefail

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./version.sh
source "$_SCRIPT_DIR/version.sh"
REPO_ROOT=$(cd "$_SCRIPT_DIR/../.." && pwd)

VERSION="${VERSION:-$(current_version)}"
DEPLOY_URL="${DEPLOY_URL:-https://subkit-api.mikebild.dev}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-90}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"
VERIFY_API_KEY="${VERIFY_API_KEY:-}"
SSH_HOST="${SSH_HOST:-}"
LOG_SINCE="${LOG_SINCE:-2m}"
SKIP_AUTH_DIAGNOSTICS="${SKIP_AUTH_DIAGNOSTICS:-0}"
SKIP_REMOTE_LOGS="${SKIP_REMOTE_LOGS:-0}"

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

# 2. Public smoke script.
msg "running scripts/smoke.sh"
if ! "$REPO_ROOT/scripts/smoke.sh" "$DEPLOY_URL" "$VERSION"; then
  err "smoke.sh failed"
  exit 1
fi
ok "smoke green"

# 3. Authenticated remote-health smoke.
if [ "$SKIP_AUTH_DIAGNOSTICS" = "1" ]; then
  msg "SKIP_AUTH_DIAGNOSTICS=1 — skipping authenticated smoke + diagnostics"
elif [ -z "$VERIFY_API_KEY" ]; then
  err "VERIFY_API_KEY is required for authenticated smoke + diagnostics (or set SKIP_AUTH_DIAGNOSTICS=1)"
  exit 1
else
  msg "running authenticated remote-health smoke"
  if ! DEPLOY_URL="$DEPLOY_URL" SK_SMOKE_API_KEY="$VERIFY_API_KEY" \
    bun run tests/e2e/remote-health.smoke.ts; then
    err "remote-health smoke failed"
    exit 1
  fi
  ok "remote-health smoke green"

  # 4. Diagnostics endpoints.
  msg "checking authenticated diagnostics endpoints"
  LLM_BODY=$(curl -fsS --max-time 10 -H "Authorization: Bearer $VERIFY_API_KEY" \
    "$DEPLOY_URL/v1/diagnostics/llm")
  SETUP_BODY=$(curl -fsS --max-time 10 -H "Authorization: Bearer $VERIFY_API_KEY" \
    "$DEPLOY_URL/v1/diagnostics/setup")
  ERR_BODY=$(curl -fsS --max-time 10 -H "Authorization: Bearer $VERIFY_API_KEY" \
    "$DEPLOY_URL/v1/diagnostics/errors?limit=20")
  inferred_provider=$(printf '%s' "$LLM_BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d); process.stdout.write(String(b.inferred_provider ?? ''))}catch{process.stdout.write('')}})")
  setup_status=$(printf '%s' "$SETUP_BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d); process.stdout.write(String(b.overall_status ?? ''))}catch{process.stdout.write('')}})")
  blocker_count=$(printf '%s' "$SETUP_BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d); const items=Array.isArray(b.issues)?b.issues:[]; process.stdout.write(String(items.filter(i=>i.severity==='blocker').length))}catch{process.stdout.write('0')}})")
  warning_count=$(printf '%s' "$SETUP_BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d); const items=Array.isArray(b.issues)?b.issues:[]; process.stdout.write(String(items.filter(i=>i.severity==='warning').length))}catch{process.stdout.write('0')}})")
  error_count=$(printf '%s' "$ERR_BODY" | node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d); process.stdout.write(String(Array.isArray(b.items) ? b.items.length : 0))}catch{process.stdout.write('0')}})")
  if [ -z "$inferred_provider" ] || [ "$inferred_provider" = "mock" ] || [ "$inferred_provider" = "unconfigured" ]; then
    err "diagnostics/llm reported inferred_provider='$inferred_provider'"
    exit 1
  fi
  if [ "$setup_status" = "blocked" ] || [ "$blocker_count" != "0" ]; then
    err "diagnostics/setup reported overall_status='$setup_status' blockers=$blocker_count"
    printf '%s\n' "$SETUP_BODY" >&2
    exit 1
  fi
  ok "diagnostics/llm reachable (inferred_provider=$inferred_provider)"
  ok "diagnostics/setup reachable (status=$setup_status warnings=$warning_count)"
  ok "diagnostics/errors reachable (${error_count} buffered item(s) in query window)"
fi

# 5. Engine log tail — last N minutes, any new error/fatal levels.
log_cmd="cd /opt/subkit && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs engine --since ${LOG_SINCE} 2>&1"
msg "scanning engine logs for errors in the last ${LOG_SINCE}"
if [ "$SKIP_REMOTE_LOGS" = "1" ]; then
  msg "SKIP_REMOTE_LOGS=1 — skipping ssh/doctl log verification"
  ok "verify complete — $DEPLOY_URL is live on $VERSION"
  exit 0
fi
if [ -n "$SSH_HOST" ]; then
  set +e
  LOGS=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "$log_cmd" 2>&1)
  LOG_STATUS=$?
  set -e
elif command -v doctl >/dev/null 2>&1; then
  set +e
  LOGS=$(doctl compute ssh "$DROPLET_NAME" --ssh-command "$log_cmd" 2>&1)
  LOG_STATUS=$?
  set -e
else
  err "remote log verification requires SSH_HOST or an installed doctl binary (or set SKIP_REMOTE_LOGS=1)"
  exit 1
fi
if [ "${LOG_STATUS:-0}" -ne 0 ]; then
  err "failed to fetch remote logs"
  printf '%s\n' "$LOGS" >&2
  exit 1
fi
ERR_LINES=$(printf '%s\n' "$LOGS" | grep -E '"level":"(error|fatal)"' || true)
if [ -n "$ERR_LINES" ]; then
  err "engine log has new error/fatal entries:"
  printf '%s\n' "$ERR_LINES" | head -20 >&2
  exit 1
fi
ok "engine log clean (no error/fatal frames in last ${LOG_SINCE})"

ok "verify complete — $DEPLOY_URL is live on $VERSION"
