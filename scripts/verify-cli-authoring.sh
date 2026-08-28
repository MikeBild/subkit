#!/usr/bin/env bash
#
# verify-cli-authoring.sh — sk-cli equivalent of the claude.ai browser
# verification flow under [[reference-claude-ai-browser-verification-flow]].
#
# What it does:
#   1. Sends the canonical authoring prompt to the active engine via
#      `sk -p "..." --output json`.
#   2. Parses the returned JSON payload — committed_workflow_id is the
#      success signal (set when the inner loop auto-committed the draft).
#   3. Reads the workflow row back via /v1/workflows/<id> and asserts
#      the slug matches.
#   4. Deletes the workflow so reruns are idempotent.
#
# Exit codes:
#   0 — workflow created, verified, cleaned up.
#   1 — sk run returned no committed_workflow_id (the authoring loop
#       did not produce a workflow; see stdout / engine logs).
#   2 — auth / config / pre-flight problem.
#
# Configuration: by default, the script reads engine_url + api_key from
# the active profile in ~/.sk/config.json. Override with env:
#
#   SUBKIT_ENGINE_URL=... SUBKIT_API_KEY=... scripts/verify-cli-authoring.sh
#
# A custom slug can be passed as the first positional argument; otherwise
# the script picks "sk-cli-verify-$(date +%s)".

set -euo pipefail

SK_BIN="${SK_BIN:-dist/sk}"
CONFIG="${SK_CONFIG:-$HOME/.sk/config.json}"
SLUG="${1:-sk-cli-verify-$(date +%s)}"

if ! command -v jq >/dev/null 2>&1; then
  echo "sk-cli-verify: jq is required" >&2
  exit 2
fi

if [ -n "${SUBKIT_ENGINE_URL:-}" ] && [ -n "${SUBKIT_API_KEY:-}" ]; then
  ENGINE_URL="${SUBKIT_ENGINE_URL%/}"
  API_KEY="${SUBKIT_API_KEY}"
else
  if [ ! -r "$CONFIG" ]; then
    echo "sk-cli-verify: cannot read $CONFIG (export SUBKIT_ENGINE_URL + SUBKIT_API_KEY to override)" >&2
    exit 2
  fi
  ACTIVE=$(jq -r '.active_profile' "$CONFIG")
  ENGINE_URL=$(jq -r --arg p "$ACTIVE" '.profiles[$p].engine_url' "$CONFIG" | sed 's:/*$::')
  API_KEY=$(jq -r --arg p "$ACTIVE" '.profiles[$p].api_key' "$CONFIG")
fi

if [ -z "$ENGINE_URL" ] || [ "$ENGINE_URL" = "null" ] || [ -z "$API_KEY" ] || [ "$API_KEY" = "null" ]; then
  echo "sk-cli-verify: engine_url or api_key missing in active profile" >&2
  exit 2
fi

if [ ! -x "$SK_BIN" ]; then
  echo "sk-cli-verify: sk binary not found at $SK_BIN — build with 'bun run build:sk' or set SK_BIN" >&2
  exit 2
fi

PROMPT="Create a new workflow named ${SLUG} in SubKit that lists my private GitHub repositories."

printf '▶ engine_url   %s\n' "$ENGINE_URL"
printf '▶ slug         %s\n' "$SLUG"
printf '▶ sk version   '
"$SK_BIN" --help 2>/dev/null | head -1 | sed -E 's/.*sk v([0-9.]+).*/\1/'

printf '▶ engine /health '
HEALTH=$(curl -fsS "$ENGINE_URL/health" || true)
if [ -z "$HEALTH" ]; then
  echo "unreachable" >&2
  exit 2
fi
if ! echo "$HEALTH" | jq -e '
  .status == "ok" and .service == "subkit" and (.version | type == "string" and length > 0) and
  (keys | sort) == ["service", "status", "version"]
' >/dev/null; then
  echo "invalid family liveness response: $HEALTH" >&2
  exit 2
fi
echo "$HEALTH" | jq -r '"service=\(.service) version=\(.version)"'

echo
echo "▶ sk -p \"<authoring prompt>\" --output json"
TMP_OUT=$(mktemp -t sk-verify-stdout.XXXXXX.json)
TMP_ERR=$(mktemp -t sk-verify-stderr.XXXXXX.log)
trap 'rm -f "$TMP_OUT" "$TMP_ERR"' EXIT

# Tempfile capture: if the prompt run partial-writes, jq's "parse error
# at line N" pinpoints the exact line in $TMP_OUT so we can read it.
if ! "$SK_BIN" -p "$PROMPT" --output json >"$TMP_OUT" 2>"$TMP_ERR"; then
  echo "sk-cli-verify: sk -p exited non-zero — see $TMP_OUT / $TMP_ERR" >&2
  tail -20 "$TMP_ERR" >&2
  exit 1
fi

if ! jq empty "$TMP_OUT" 2>/dev/null; then
  echo "sk-cli-verify: sk -p produced non-JSON output (see $TMP_OUT)" >&2
  echo "  bytes        $(wc -c <"$TMP_OUT")" >&2
  echo "  first line   $(head -1 "$TMP_OUT" | cut -c1-200)" >&2
  echo "  last line    $(tail -1 "$TMP_OUT" | cut -c1-200)" >&2
  echo "  stderr tail  ↓" >&2
  tail -20 "$TMP_ERR" >&2
  exit 1
fi

STATUS=$(jq -r '.status' "$TMP_OUT")
CONVO_ID=$(jq -r '.session_id // empty' "$TMP_OUT")
WORKFLOW_ID=$(jq -r '.committed_workflow_id // empty' "$TMP_OUT")

echo "  status        $STATUS"
echo "  conversation  ${CONVO_ID:-<none>}"
echo "  workflow      ${WORKFLOW_ID:-<none>}"

if [ -z "$WORKFLOW_ID" ]; then
  echo "FAIL — no committed_workflow_id; the authoring loop did not produce a workflow" >&2
  jq '{assistant_text, validation_errors, pending_elicitation}' "$TMP_OUT" >&2
  exit 1
fi

echo
echo "▶ GET /v1/workflows/$WORKFLOW_ID"
WF_JSON=$(curl -fsS -H "Authorization: Bearer $API_KEY" \
  "$ENGINE_URL/v1/workflows/$WORKFLOW_ID" || true)
if [ -z "$WF_JSON" ]; then
  echo "FAIL — workflow not readable via API" >&2
  exit 1
fi

ROW_SLUG=$(echo "$WF_JSON" | jq -r '.slug // .workflow.slug // empty')
ROW_STATUS=$(echo "$WF_JSON" | jq -r '.status // .workflow.status // empty')
echo "  slug          $ROW_SLUG"
echo "  status        $ROW_STATUS"

if [ "$ROW_SLUG" != "$SLUG" ]; then
  echo "FAIL — committed workflow slug='$ROW_SLUG' does not match requested '$SLUG'" >&2
  exit 1
fi

echo
echo "▶ DELETE /v1/workflows/$WORKFLOW_ID (cleanup)"
DELETE_HTTP=$(curl -s -o /dev/null -w '%{http_code}' \
  -X DELETE -H "Authorization: Bearer $API_KEY" \
  "$ENGINE_URL/v1/workflows/$WORKFLOW_ID" || true)
echo "  http          $DELETE_HTTP"
if [ "$DELETE_HTTP" != "204" ] && [ "$DELETE_HTTP" != "200" ]; then
  echo "WARN — cleanup DELETE returned $DELETE_HTTP (workflow row may linger)" >&2
fi

echo
echo "PASS — sk-cli authoring flow produced a committed workflow end-to-end."
