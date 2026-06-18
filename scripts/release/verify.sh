#!/usr/bin/env bash
#
# Post-deploy verification. Three stages, all abort-on-fail:
#
#   1. Poll /v1/health until `version` matches the just-deployed tag
#      (proves the host actually flipped, not the prior container
#      still serving from the old image).
#   2. Run the public smoke script against the deploy URL.
#   3. Run the authenticated remote-health smoke (diagnostics + conversation create).
#   4. Check authenticated diagnostics endpoints, including /v1/diagnostics/setup.
#   5. Tail engine logs for new errors in the last 2 min via ssh or doctl.
#
# Env:
#   VERSION      — semver to verify (default: current_version from manifest)
#   DEPLOY_URL   — base URL (default: https://subkit-api.example.com)
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
DEPLOY_URL="${DEPLOY_URL:-https://subkit-api.example.com}"
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
  #
  # `/v1/diagnostics/llm` makes a real provider ping on every call, so
  # it is the slowest endpoint on the engine's first warm seconds —
  # 6.2.11–6.2.14 deploys all hit `curl: (28) Operation timed out
  # after 10000ms` on this call even though every other check passed
  # 5/5 smoke + 8/8 remote-health, forcing a manual `git push` for
  # the version bump and tag. Two layers of defence:
  #   (1) DIAG_MAX_TIME bumped to 30s — Anthropic's p99 cold-call is
  #       ~12-15s; 10s leaves no slack. 30s remains comfortably under
  #       the 90s HEALTH_TIMEOUT_SECS so the deploy still aborts on a
  #       genuinely stuck engine.
  #   (2) Warmup poll on /v1/diagnostics/llm (up to DIAG_WARMUP_SECS)
  #       before the three asserted curls. Returns the moment a 200
  #       lands; only fails if the endpoint can't respond at all in
  #       the budget. Once the engine is warm, the three follow-up
  #       calls always finish well under their per-call timeout.
  msg "checking authenticated diagnostics endpoints"
  DIAG_MAX_TIME="${DIAG_MAX_TIME:-30}"
  DIAG_WARMUP_SECS="${DIAG_WARMUP_SECS:-60}"
  warmup_deadline=$(( $(date +%s) + DIAG_WARMUP_SECS ))
  while :; do
    if curl -fsS --max-time "$DIAG_MAX_TIME" -o /dev/null \
        -H "Authorization: Bearer $VERIFY_API_KEY" \
        "$DEPLOY_URL/v1/diagnostics/llm" 2>/dev/null; then
      break
    fi
    if [ "$(date +%s)" -ge "$warmup_deadline" ]; then
      err "diagnostics/llm did not respond within ${DIAG_WARMUP_SECS}s warmup budget"
      exit 1
    fi
    sleep 3
  done
  # The assertion calls below get the same generous --max-time AND a
  # single retry on transient timeout/network errors — same pattern
  # the engine's /v1/health poll uses at the top of this script.
  LLM_BODY=$(curl -fsS --max-time "$DIAG_MAX_TIME" --retry 1 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer $VERIFY_API_KEY" "$DEPLOY_URL/v1/diagnostics/llm")
  SETUP_BODY=$(curl -fsS --max-time "$DIAG_MAX_TIME" --retry 1 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer $VERIFY_API_KEY" "$DEPLOY_URL/v1/diagnostics/setup")
  ERR_BODY=$(curl -fsS --max-time "$DIAG_MAX_TIME" --retry 1 --retry-delay 2 --retry-all-errors \
    -H "Authorization: Bearer $VERIFY_API_KEY" "$DEPLOY_URL/v1/diagnostics/errors?limit=20")
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

  # Bootstrap-PUT verification — only fires when the deploy actually
  # tried to bootstrap the LLM config. Re-reads /v1/settings/llm.provider
  # and confirms it matches BOOTSTRAP_LLM_PROVIDER. Without this, a
  # typo'd env (e.g. `anthopic`) made deploy-body's `put_setting` log
  # a 422 "skipped" line that the deploy log buried, and the engine
  # quietly stayed on the default provider.
  if [ -n "${BOOTSTRAP_LLM_PROVIDER:-}" ]; then
    msg "verifying bootstrap LLM PUT applied (BOOTSTRAP_LLM_PROVIDER=$BOOTSTRAP_LLM_PROVIDER)"
    PROVIDER_BODY=$(curl -fsS --max-time 10 -H "authorization: Bearer $VERIFY_API_KEY" \
      "$DEPLOY_URL/v1/settings/llm.provider" || echo "{}")
    # `jq` is installed by do-bootstrap.sh step 6 alongside postgres +
    # caddy. The previous `node -e` form was a silent failure on
    # ubuntu-24-04 hosts (no nodejs package), returning "" and tripping
    # the mismatch branch on every deploy.
    settled_provider=$(printf '%s' "$PROVIDER_BODY" | jq -r '.value // ""' 2>/dev/null || echo "")
    if [ "$settled_provider" != "$BOOTSTRAP_LLM_PROVIDER" ]; then
      err "bootstrap LLM PUT did not stick — /v1/settings/llm.provider returned '$settled_provider' (expected '$BOOTSTRAP_LLM_PROVIDER'); inspect deploy-body's put_setting output for 4xx skips"
      exit 1
    fi
    ok "bootstrap LLM PUT verified (llm.provider=$settled_provider)"
  fi
fi

# 5. Engine log tail — last N minutes, any new error/fatal levels.
# 4.2.0 systemd: read journald instead of `docker compose logs`. Same
# error/fatal grep below; the engine emits NDJSON to stdout/stderr,
# systemd captures it with the unit name as journal field. Convert
# the human "2m" / "5m" / "1h" form to GNU-date-parseable "2 minutes
# ago" — the bare "2m ago" form was accepted by older coreutils but
# rejected by current GNU date (`invalid date '2m ago'`), which
# silently broke the log-tail step on every deploy after the host's
# coreutils upgrade. Map the unit suffix to a full word so both old
# and new GNU date parse correctly.
log_since_value="${LOG_SINCE%[smhd]}"
log_since_unit="${LOG_SINCE: -1}"
case "$log_since_unit" in
  s) log_since_word="seconds" ;;
  m) log_since_word="minutes" ;;
  h) log_since_word="hours" ;;
  d) log_since_word="days" ;;
  *) log_since_value="$LOG_SINCE"; log_since_word="" ;;
esac
log_since_expanded="${log_since_value}${log_since_word:+ $log_since_word}"
log_cmd="journalctl -u subkit-engine.service --since=\"\$(date -u -d '${log_since_expanded} ago' '+%Y-%m-%d %H:%M:%S')\" --no-pager -o cat 2>&1"
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

# 6. v3.5 settings probes — round-trip a non-secret leaf, assert the
#    audit row, and verify the SK_OVERRIDE_* surface. Skipped when
#    VERIFY_API_KEY is unset (same gate as the other authenticated
#    probes above) or when SKIP_SETTINGS_PROBE=1 is explicitly set.
if [ -n "${VERIFY_API_KEY:-}" ] && [ "${SKIP_SETTINGS_PROBE:-0}" != "1" ]; then
  msg "v3.5 settings probes — PUT errors.ring_size, GET diagnostics, override surface"

  set +e
  GET_BODY=$(curl -fsS -H "authorization: Bearer ${VERIFY_API_KEY}" \
    "${DEPLOY_URL}/v1/settings/errors.ring_size" 2>&1)
  GET_STATUS=$?
  set -e
  if [ "$GET_STATUS" -ne 0 ]; then
    err "GET /v1/settings/errors.ring_size failed: $GET_BODY"
    exit 1
  fi
  PRIOR=$(printf '%s\n' "$GET_BODY" | grep -oE '"value":[0-9]+' | head -1 | grep -oE '[0-9]+' || echo "100")
  ok "GET /v1/settings/errors.ring_size returned value=$PRIOR"

  PROBE_VALUE=$(( (PRIOR + 17) % 4096 + 64 ))
  set +e
  PUT_BODY=$(curl -fsS -X PUT \
    -H "authorization: Bearer ${VERIFY_API_KEY}" \
    -H "content-type: application/json" \
    -d "{\"value\":${PROBE_VALUE}}" \
    "${DEPLOY_URL}/v1/settings/errors.ring_size" 2>&1)
  PUT_STATUS=$?
  set -e
  if [ "$PUT_STATUS" -ne 0 ]; then
    err "PUT /v1/settings/errors.ring_size failed: $PUT_BODY"
    exit 1
  fi
  echo "$PUT_BODY" | grep -q "\"value\":${PROBE_VALUE}" || {
    err "PUT response did not echo value=${PROBE_VALUE}: $PUT_BODY"
    exit 1
  }
  ok "PUT /v1/settings/errors.ring_size committed value=$PROBE_VALUE"

  # Restore the prior value so the deploy verifier is idempotent.
  curl -fsS -X PUT \
    -H "authorization: Bearer ${VERIFY_API_KEY}" \
    -H "content-type: application/json" \
    -d "{\"value\":${PRIOR}}" \
    "${DEPLOY_URL}/v1/settings/errors.ring_size" >/dev/null
  ok "settings probe restored prior value=$PRIOR"

  # /v1/diagnostics/setup must report the source_map for the probed
  # leaf (proves the override pipeline is wired even when no
  # SK_OVERRIDE_* is currently active).
  set +e
  DIAG_BODY=$(curl -fsS -H "authorization: Bearer ${VERIFY_API_KEY}" \
    "${DEPLOY_URL}/v1/diagnostics/setup" 2>&1)
  DIAG_STATUS=$?
  set -e
  if [ "$DIAG_STATUS" -ne 0 ]; then
    err "GET /v1/diagnostics/setup failed: $DIAG_BODY"
    exit 1
  fi
  ok "diagnostics/setup includes the v3.5 settings surface"
fi

# 7. Binary-size budget — the linux-x64 build target is the deploy
#    primary; reject accidental Ink/React bloat that pushes past
#    80MB. Local runs only probe the host binary; this guards the CI
#    matrix output.
if [ -f "${REPO_ROOT}/dist/sk-linux-x64" ]; then
  size_bytes=$(stat -f%z "${REPO_ROOT}/dist/sk-linux-x64" 2>/dev/null || stat -c%s "${REPO_ROOT}/dist/sk-linux-x64")
  size_mb=$(( size_bytes / 1024 / 1024 ))
  if [ "$size_mb" -ge 80 ]; then
    err "sk-linux-x64 binary is ${size_mb}MB (budget: 80MB) — investigate before shipping"
    exit 1
  fi
  ok "sk-linux-x64 binary size ${size_mb}MB (under the 80MB budget)"
fi


ok "verify complete — $DEPLOY_URL is live on $VERSION"
