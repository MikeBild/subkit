#!/usr/bin/env bash
#
# Deploy a subkit engine release onto the production host.
#
# This is the single authoritative deploy body: both GitHub Actions
# (`release.yml`) and the laptop orchestrator (`scripts/deploy.sh`)
# pipe this over SSH to the host and execute it. Keeping one file
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
#     against /v1/health on the host.
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
#
# BOOTSTRAP_ONLY=1 — re-runs the post-health PUT /v1/settings/* phase
# without re-shipping a binary. Useful when the operator added a
# BOOTSTRAP_LLM_* secret after the first deploy and wants the engine
# to pick it up without a full release cycle. Skips the binary swap,
# the systemctl restart, and the health-poll; goes straight to the
# settings PUTs against the live engine.

set -euo pipefail

: "${ENGINE_VERSION:?ENGINE_VERSION must be set (e.g. export ENGINE_VERSION=4.2.0)}"

ENGINE_BIN="/usr/local/bin/engine"
ENGINE_NEXT="${ENGINE_BIN}.next"
ENGINE_PREV="${ENGINE_BIN}.prev"
HEALTH_URL="http://127.0.0.1:3000/v1/health"
SERVICE_UNIT="subkit-engine.service"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-150}"
# BOOTSTRAP_ONLY=1 — re-run the post-health PUT /v1/settings/* phase
# without re-shipping a binary. Useful when the operator added a
# BOOTSTRAP_LLM_* secret after the first deploy and wants the engine
# to pick it up without a full release cycle.
BOOTSTRAP_ONLY="${BOOTSTRAP_ONLY:-0}"

# Hard preflight — these are required by every code path below.
command -v jq >/dev/null || {
  echo "FATAL: jq missing on host — re-run scripts/do-bootstrap.sh"
  exit 1
}
command -v curl >/dev/null || {
  echo "FATAL: curl missing on host — re-run scripts/do-bootstrap.sh"
  exit 1
}

if [ "$BOOTSTRAP_ONLY" != "1" ] && [ ! -f "$ENGINE_NEXT" ]; then
  echo "FATAL: $ENGINE_NEXT missing — caller must scp the new binary first (or set BOOTSTRAP_ONLY=1 to skip the binary swap)"
  exit 1
fi

read_running_version() {
  # `jq` is installed by `do-bootstrap.sh` step 6 alongside postgres +
  # caddy. Don't reach for `node -e` here — the host image is
  # ubuntu-24-04 with no nodejs package; the curl|node pipe was a
  # silent failure mode that returned "" forever and burned the full
  # HEALTH_TIMEOUT_SECS clock before rolling back.
  curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null \
    | jq -r '.version // empty' 2>/dev/null \
    || true
}

PREV_VERSION=$(read_running_version)
echo "previously running: ${PREV_VERSION:-<none>}"

if [ "$BOOTSTRAP_ONLY" = "1" ]; then
  echo "BOOTSTRAP_ONLY=1 — skipping binary swap, going straight to PUT /v1/settings/*"
  if [ -n "${PREV_VERSION:-}" ]; then
    ENGINE_VERSION="$PREV_VERSION"
  fi
else
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
fi

# Reload caddy in case the Caddyfile was updated by the caller's scp.
# `caddy reload` is the systemd-managed way; it picks up the on-disk
# Caddyfile without dropping connections (graceful — no "terminating
# connection" log noise that the old compose flow caused).
if [ "$BOOTSTRAP_ONLY" != "1" ] && systemctl is-active --quiet caddy.service; then
  systemctl reload caddy.service || true
fi

# 4.2.0 zero-conf bootstrap. Eat-own-dog-food: instead of editing
# /etc/subkit/.env to seed LLM provider + key, the deploy reaches
# the engine over HTTP and PUTs `/v1/settings/*` — the same path the
# `sk settings set` CLI takes. Idempotent (re-PUT with the same value
# is a no-op for the audit log). All four bootstrap vars optional;
# absent vars skip their PUT.
#
# Inputs (all optional, set in .env.deploy):
#   BOOTSTRAP_LLM_PROVIDER      → llm.provider
#   BOOTSTRAP_LLM_API_KEY       → llm.providers.<provider>.api_key
#   BOOTSTRAP_LLM_MODEL         → llm.providers.<provider>.model
#   BOOTSTRAP_LLM_FALLBACK_PROVIDER → llm.fallback_provider
#   BOOTSTRAP_LLM_FALLBACK_MODEL    → llm.fallback_model
#   VERIFY_API_KEY              → bearer token for the PUT calls
if [ -n "${VERIFY_API_KEY:-}" ] && [ -n "${BOOTSTRAP_LLM_PROVIDER:-}" ]; then
  echo "bootstrap LLM config via /v1/settings/* (eat-own-dog-food)"
  # Status-coded handler: 5xx fails the deploy (engine misbehaving),
  # 4xx is a soft-skip (operator typo / scope mismatch — fixable later
  # via `sk settings set`), 2xx logs success. Without this split a
  # 422 "invalid value" silently passed and the deploy looked green
  # while /v1/diagnostics/llm reported `inferred_provider=mock`.
  #
  # JSON encoding: pipe the raw string through `jq -Rs .` so embedded
  # quotes / backslashes / control chars in a credential never blow up
  # the request body. (Anthropic and Vertex keys haven't carried such
  # chars historically; OpenAI org strings have.) jq is a hard
  # preflight at line 53–60 so this can't reach unbounded input.
  #
  # Response handling: we only echo the HTTP status code on 4xx/5xx,
  # never the response body — defense-in-depth so a future Zod-issue
  # formatter that echoes the offending value can't leak the bootstrap
  # credential into CI deploy logs.
  put_setting() {
    local path="$1"
    local raw_value="$2"
    local json_value
    json_value=$(printf '%s' "$raw_value" | jq -Rs .)
    local body_file
    body_file=$(mktemp)
    local code
    code=$(curl -sS -o "$body_file" -w '%{http_code}' -X PUT \
      -H "authorization: Bearer ${VERIFY_API_KEY}" \
      -H "content-type: application/json" \
      -d "{\"value\":${json_value}}" \
      "${HEALTH_URL%/v1/health}/v1/settings/${path}" 2>/dev/null || echo "000")
    case "$code" in
      2*)
        echo "  PUT /v1/settings/${path} ok ($code)"
        ;;
      4*)
        echo "  PUT /v1/settings/${path} skipped: HTTP ${code}"
        ;;
      *)
        echo "  PUT /v1/settings/${path} FAILED: HTTP ${code}"
        rm -f "$body_file"
        return 1
        ;;
    esac
    rm -f "$body_file"
    return 0
  }
  put_setting "llm.provider" "${BOOTSTRAP_LLM_PROVIDER}"
  if [ -n "${BOOTSTRAP_LLM_API_KEY:-}" ]; then
    put_setting "llm.providers.${BOOTSTRAP_LLM_PROVIDER}.api_key" "${BOOTSTRAP_LLM_API_KEY}"
  fi
  if [ -n "${BOOTSTRAP_LLM_MODEL:-}" ]; then
    put_setting "llm.providers.${BOOTSTRAP_LLM_PROVIDER}.model" "${BOOTSTRAP_LLM_MODEL}"
  fi
  if [ -n "${BOOTSTRAP_LLM_FALLBACK_PROVIDER:-}" ]; then
    put_setting "llm.fallback_provider" "${BOOTSTRAP_LLM_FALLBACK_PROVIDER}"
  fi
  if [ -n "${BOOTSTRAP_LLM_FALLBACK_MODEL:-}" ]; then
    put_setting "llm.fallback_model" "${BOOTSTRAP_LLM_FALLBACK_MODEL}"
  fi
fi

echo "deploy complete: engine ${PREV_VERSION:-<none>} → ${ENGINE_VERSION}"
