#!/usr/bin/env bash
#
# E2E smoke test for a deployed subkit-engine.
#
# Usage:
#   scripts/smoke.sh https://subkit-api.mikebild.dev 0.1.0   # with version check
#   scripts/smoke.sh http://localhost:3000                     # local, skip version
#
# Checks:
#   1. /v1/health returns {"status":"ok","db_connected":true}
#   2. /openapi.json is reachable (version check if arg provided)
#   3. /v1/identity/providers returns a providers array
#   4. /docs (Scalar API docs) is reachable
#   5. HTTPS cert chain valid (when URL is https)

set -euo pipefail

URL="${1:?usage: smoke.sh <base-url> [expected-version]}"
EXPECTED="${2:-}"

command -v jq >/dev/null || { echo "FAIL: jq is required"; exit 1; }

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# --- 1. Health check ---------------------------------------------------------
echo "Smoke: waiting for $URL/v1/health"
for i in $(seq 1 60); do
  body=$(curl -fsS --max-time 5 "$URL/v1/health" 2>/dev/null || true)
  if [[ -n "$body" ]]; then
    status=$(jq -r '.status // empty' <<<"$body")
    db=$(jq -r '.db_connected // empty' <<<"$body")
    version=$(jq -r '.version // empty' <<<"$body")
    if [[ "$status" == "ok" && "$db" == "true" ]]; then
      pass "/v1/health status=ok db_connected=true version=$version"
      break
    fi
    printf "  attempt %2d: status=%s db=%s\n" "$i" "$status" "$db"
  else
    printf "  attempt %2d: no response yet\n" "$i"
  fi
  if [[ $i -eq 60 ]]; then
    fail "/v1/health never responded after 5 minutes"
  fi
  sleep 5
done

# --- 2. OpenAPI spec ---------------------------------------------------------
# Bounded poll for info.version == EXPECTED. Without polling, a single-shot
# check races the host's container-recreation: /v1/health flips green
# (engine listening) seconds before /openapi.json swaps in the new spec
# (caddy reload completes). A real instance was caught where the host
# served 3.5.1 seconds after 4.0.0 was tagged.
# Tries up to 30× over 60s when EXPECTED is set; single-shot when not.
echo "Smoke: checking /openapi.json"
attempts=1
[[ -n "$EXPECTED" ]] && attempts=30
spec_version=""
spec_body=""
for i in $(seq 1 "$attempts"); do
  spec_body=$(curl -fsS --max-time 10 "$URL/openapi.json" 2>/dev/null || true)
  if [[ -n "$spec_body" ]]; then
    spec_version=$(jq -r '.info.version // empty' <<<"$spec_body")
    if [[ -z "$EXPECTED" || "$spec_version" == "$EXPECTED" ]]; then
      break
    fi
    if [[ "$attempts" -gt 1 && $i -lt $attempts ]]; then
      printf "  attempt %2d/%d: info.version=%s expected=%s — retrying\n" "$i" "$attempts" "$spec_version" "$EXPECTED"
      sleep 2
    fi
  elif [[ "$attempts" -gt 1 && $i -lt $attempts ]]; then
    printf "  attempt %2d/%d: /openapi.json unreachable — retrying\n" "$i" "$attempts"
    sleep 2
  fi
done
if [[ -z "$spec_body" ]]; then
  fail "/openapi.json unreachable"
elif [[ -n "$EXPECTED" && "$spec_version" != "$EXPECTED" ]]; then
  fail "/openapi.json info.version=$spec_version expected=$EXPECTED (after $attempts attempts)"
else
  pass "/openapi.json reachable version=$spec_version"
fi

# --- 3. Auth providers discovery ---------------------------------------------
echo "Smoke: checking /v1/identity/providers"
providers_body=$(curl -fsS --max-time 5 "$URL/v1/identity/providers" 2>/dev/null || true)
if [[ -n "$providers_body" ]]; then
  provider_count=$(jq -r '.providers | length' <<<"$providers_body" 2>/dev/null || echo "0")
  provider_types=$(jq -r '[.providers[].type] | join(", ")' <<<"$providers_body" 2>/dev/null || echo "")
  if [[ "$provider_count" -ge 1 ]]; then
    pass "/v1/identity/providers count=$provider_count types=[$provider_types]"
  else
    fail "/v1/identity/providers returned empty array"
  fi
else
  fail "/v1/identity/providers unreachable"
fi

# --- 4. API docs (Scalar UI) ------------------------------------------------
echo "Smoke: checking /docs"
docs_status=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 10 "$URL/docs" 2>/dev/null || echo "000")
if [[ "$docs_status" == "200" ]]; then
  pass "/docs reachable (Scalar UI)"
else
  fail "/docs returned HTTP $docs_status"
fi

# --- 5. TLS cert (https only) -----------------------------------------------
if [[ "$URL" == https://* ]]; then
  echo "Smoke: validating HTTPS cert chain"
  if curl -fsS -o /dev/null "$URL/v1/health" 2>/dev/null; then
    pass "HTTPS cert chain valid"
  else
    fail "HTTPS cert chain validation failed"
  fi
fi

# --- Summary -----------------------------------------------------------------
echo ""
echo "SMOKE RESULTS: $PASS passed, $FAIL failed against $URL"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
