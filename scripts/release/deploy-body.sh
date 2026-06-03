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
# 300s (not 150s): the engine is a ~131 MB single compiled binary that is
# demand-faulted into RAM as its module graph executes on boot. On a cold or
# memory-pressured page cache (e.g. a redeploy right after the prior process
# freed a multi-GB footprint) that fault-in can stall well past 150s — once
# observed at 2h22m, which timed this gate out on an engine that was merely
# booting slowly, not broken. The pre-warm below shrinks the common case; this
# ceiling covers the contended tail.
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-300}"
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

# Stale-rollback safety net: if a previous deploy crashed AFTER the
# scp but BEFORE the swap, $ENGINE_NEXT might be from the run before
# this one. The mtime-vs-now check is generous (24h) — just enough to
# reject a many-days-old artifact while accepting a normal back-to-back
# deploy. (The atomic `mv` happens within seconds of scp; a stale
# engine.next is always a sign of a botched run, not a slow caller.)
if [ "$BOOTSTRAP_ONLY" != "1" ] && [ -f "$ENGINE_NEXT" ]; then
  if [ "$(find "$ENGINE_NEXT" -mmin +1440 2>/dev/null)" ]; then
    echo "WARN: $ENGINE_NEXT older than 24h (likely a botched prior deploy); proceeding with swap, but inspect /var/log/subkit if anything looks off"
  fi
fi

read_running_version() {
  # `jq` is installed by `do-bootstrap.sh` step 6 alongside postgres +
  # caddy. Don't reach for `node -e` here — the host image is
  # ubuntu-24-04 with no nodejs package; the curl|node pipe was a
  # silent failure mode that returned "" forever and burned the full
  # HEALTH_TIMEOUT_SECS clock before rolling back.
  #
  # Distinguish three failure modes so the deploy log surfaces the
  # actual cause within the 5 s curl timeout instead of the full
  # 150 s health-poll budget:
  #   (a) connect failure (curl exit !=0) → empty
  #   (b) non-JSON response (jq exit !=0) → "<non-json>"
  #   (c) JSON without .version            → empty (jq // empty)
  # Callers compare to ENGINE_VERSION; "<non-json>" never matches
  # the bumped semver, so it surfaces immediately in the polling
  # loop's mismatch echo.
  local body
  body=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null) || return 0
  if ! printf '%s' "$body" | jq -e . >/dev/null 2>&1; then
    echo "<non-json>"
    return 0
  fi
  printf '%s' "$body" | jq -r '.version // empty' 2>/dev/null || true
}

PREV_VERSION=$(read_running_version)
echo "previously running: ${PREV_VERSION:-<none>}"

if [ "$BOOTSTRAP_ONLY" = "1" ]; then
  echo "BOOTSTRAP_ONLY=1 — skipping binary swap, going straight to PUT /v1/settings/*"
  if [ -n "${PREV_VERSION:-}" ]; then
    ENGINE_VERSION="$PREV_VERSION"
  fi
  # Clean up any stale engine.next from a prior deploy. Without this,
  # a non-bootstrap deploy that follows would happily move the orphan
  # binary into place even if the operator didn't ship a fresh build.
  if [ -f "$ENGINE_NEXT" ]; then
    rm -f "$ENGINE_NEXT"
    echo "removed orphan $ENGINE_NEXT (BOOTSTRAP_ONLY skipped its swap)"
  fi
else
  # Atomic cutover: rename the running binary to .prev, the new binary
  # into place. systemd `Type=exec` keeps the running process pinned to
  # the old inode until restart, so the rename is safe.
  if [ -f "$ENGINE_BIN" ]; then
    cp -p "$ENGINE_BIN" "$ENGINE_PREV"
    # Record the prev binary's reported version so the rollback path
    # below can refuse a chained-rollback cycle (deploy A fails →
    # rollback to B; deploy A' also fails → would rollback to A again
    # without this sentinel, cycling between two broken versions).
    if [ -n "${PREV_VERSION:-}" ]; then
      printf '%s\n' "$PREV_VERSION" > "${ENGINE_BIN}.prev.version"
    else
      rm -f "${ENGINE_BIN}.prev.version"
    fi
  fi
  chmod 755 "$ENGINE_NEXT"
  mv "$ENGINE_NEXT" "$ENGINE_BIN"

  # Pre-warm the binary into the page cache BEFORE restart. The dominant
  # boot cost is the kernel demand-faulting this ~131 MB binary's code
  # pages off disk as the module graph executes (a silent ~50s phase that
  # has ballooned to hours under memory/IO contention). Reading the whole
  # file front-loads that IO while the old process is still serving, so the
  # new process starts against a warm cache. `cat >/dev/null` is the
  # no-extra-deps form (ubuntu-24-04 host, no vmtouch); best-effort.
  echo "pre-warming $ENGINE_BIN into page cache ($(stat -c%s "$ENGINE_BIN" 2>/dev/null || echo '?') bytes)"
  cat "$ENGINE_BIN" >/dev/null 2>&1 || true

  # Restart the unit. systemd will re-exec the binary; engine boot runs
  # embedded migrations in-process before the HTTP listener starts, so
  # /v1/health == ENGINE_VERSION implies migrations succeeded.
  systemctl restart "$SERVICE_UNIT"

  # Health-poll loop: up to HEALTH_TIMEOUT_SECS waiting for the new
  # version to surface. systemd Restart=on-failure means a crashing
  # binary cycles forever within StartLimitBurst before unit-fail; we
  # don't wait on the unit, only the version flip.
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  non_json_seen=0
  while :; do
    live=$(read_running_version)
    if [ "$live" = "$ENGINE_VERSION" ]; then
      echo "Engine v${ENGINE_VERSION} healthy"
      break
    fi
    # Surface a non-JSON response IMMEDIATELY (don't burn the full
    # HEALTH_TIMEOUT_SECS waiting for a version flip that can't
    # happen). Common cause: caddy is up but the engine crashed and
    # caddy is serving its own error page — operator needs the hint.
    if [ "$live" = "<non-json>" ] && [ "$non_json_seen" = "0" ]; then
      echo "WARN: /v1/health returned a non-JSON response — engine likely crashed before serving;"
      echo "      run 'journalctl -u subkit-engine -n 200' on the host to see why."
      non_json_seen=1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      # Final authoritative re-probe before declaring failure. A slow but
      # successful boot can cross the deadline just before it starts serving;
      # rolling back — or fataling on a rollback-cycle (prev==target) — a
      # healthy engine is worse than honouring one last probe. If it now
      # reports the target version, the deploy succeeded.
      live=$(read_running_version)
      if [ "$live" = "$ENGINE_VERSION" ]; then
        echo "Engine v${ENGINE_VERSION} healthy (surfaced at the ${HEALTH_TIMEOUT_SECS}s deadline)"
        break
      fi
      echo "FATAL: health timeout after ${HEALTH_TIMEOUT_SECS}s (live='${live:-<unreachable>}', want=${ENGINE_VERSION})"
      if [ -f "$ENGINE_PREV" ]; then
        # Refuse a chained-rollback cycle: if the prev binary's
        # recorded version equals the version we just tried to ship,
        # rolling back would just put us at the same spot. Surface
        # the cycle and exit — operator must investigate.
        prev_recorded=""
        if [ -f "${ENGINE_BIN}.prev.version" ]; then
          prev_recorded=$(cat "${ENGINE_BIN}.prev.version" 2>/dev/null || echo "")
        fi
        if [ -n "$prev_recorded" ] && [ "$prev_recorded" = "$ENGINE_VERSION" ]; then
          echo "FATAL: rollback would cycle (engine.prev.version=${prev_recorded} == ENGINE_VERSION=${ENGINE_VERSION}). Refusing — investigate before redeploying."
          exit 1
        fi
        echo "Rolling back to ${prev_recorded:-${PREV_VERSION:-prev binary}}"
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
  # NB: put_setting writes the GLOBAL scope only — no `?tenant=` query
  # is ever appended. Today every BOOTSTRAP_LLM_* leaf is global per
  # apps/engine/src/config/schema.ts, so this is correct. If a future
  # operator adds a tenant-scoped LLM override leaf, this helper must
  # grow an optional 3rd argument (tenant id) before being called for
  # that leaf — otherwise the deploy would silently write a tenant
  # override into the global scope.
  put_setting() {
    local path="$1"
    local raw_value="$2"
    local json_value
    # `printf '%s'` (not `printf "$raw_value"`): the latter would treat
    # the value as a format string and a `%` or `\` in a credential
    # would mangle the body. `printf '%s'` is also safe with embedded
    # `$` and backticks — none get interpreted.
    json_value=$(printf '%s' "$raw_value" | jq -Rs .)
    local body_file
    body_file=$(mktemp)
    local code
    # X-Subkit-Audit-Source + X-Subkit-Deploy-Version tag the audit row
    # so compliance review can answer:
    #   1. "Was this a deploy bootstrap or operator-typed write?"
    #      → metadata.audit_source: deploy_bootstrap | sk_cli
    #   2. "Which release SHA flipped this LLM key?"
    #      → metadata.deploy_version: ENGINE_VERSION (semver)
    # The route validates both via Zod-typed headers before stamping
    # them on the audit metadata.
    #
    # Defense-in-depth on argv exposure: VERIFY_API_KEY (admin bearer)
    # and the JSON body (which carries BOOTSTRAP_LLM_API_KEY under
    # `value`) are passed via `--config` (read from a transient file)
    # and stdin (`--data-binary @-`) respectively — neither lands in
    # /proc/<pid>/cmdline, where any local user with PROCFS read could
    # otherwise pick them up for the lifetime of the curl process.
    local cfg_file
    cfg_file=$(mktemp)
    chmod 600 "$cfg_file"
    # `--config` option lines: one option/value per line, quotes
    # mandatory on multi-word values. See `man curl` /CONFIG/.
    {
      printf 'header = "authorization: Bearer %s"\n' "$VERIFY_API_KEY"
      printf 'header = "content-type: application/json"\n'
      printf 'header = "x-subkit-audit-source: deploy_bootstrap"\n'
      printf 'header = "x-subkit-deploy-version: %s"\n' "$ENGINE_VERSION"
    } > "$cfg_file"
    code=$(printf '{"value":%s}' "$json_value" \
      | curl -sS -o "$body_file" -w '%{http_code}' -X PUT \
        --config "$cfg_file" \
        --data-binary @- \
        "${HEALTH_URL%/v1/health}/v1/settings/${path}" 2>/dev/null \
      || echo "000")
    rm -f "$cfg_file"
    # 2xx: applied. Anything else (4xx / 5xx / curl-emitted "000"
    # for connection failure): fail the deploy. Earlier the 4xx
    # branch returned 0 ("skipped") to absorb operator typos in
    # BOOTSTRAP_LLM_* values, but verify.sh only re-reads
    # llm.provider — every other field (api_key, model, fallback_*)
    # would 422 silently and the engine would quietly stay on the
    # prior value. Better to fail loudly: the operator fixes the env
    # and re-runs with BOOTSTRAP_ONLY=1, no binary swap needed.
    #
    # Numeric range comparison (not `2*` glob) so a malformed `code`
    # ("ok", "2", an empty string) routes to the failure branch —
    # `case 2*` would silently match "2" or any short string starting
    # with "2".
    if [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 300 ] 2>/dev/null; then
      echo "  PUT /v1/settings/${path} ok ($code)"
    else
      echo "  PUT /v1/settings/${path} FAILED: HTTP ${code}"
      # Common-mode hints so the operator doesn't have to guess. The
      # hint is one line per known status; unrecognized codes get only
      # the FAILED line above (no false-positive guidance).
      case "$code" in
        401)
          echo "    hint: VERIFY_API_KEY may be stale. Mint a new admin key on the host:"
          echo "          ssh root@<host> \"sudo -u subkit -H bash -c 'set -a; . /etc/subkit/.env; set +a; cd /etc/subkit && /usr/local/bin/engine --issue-admin-key'\""
          echo "          then re-run the deploy with VERIFY_API_KEY set to the printed wf_live_… value."
          ;;
        422)
          echo "    hint: the value failed Zod validation on the route. Check that BOOTSTRAP_LLM_PROVIDER matches one of the engine's supported provider names (anthropic|openai|gemini|azure|bedrock|vertex|ai_gateway|mock) and that BOOTSTRAP_LLM_MODEL is a non-empty string for the chosen provider."
          ;;
        403)
          echo "    hint: VERIFY_API_KEY lacks settings:write OR the cross-tenant guard tripped. Use a system-tenant admin key for global writes."
          ;;
      esac
      rm -f "$body_file"
      return 1
    fi
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
