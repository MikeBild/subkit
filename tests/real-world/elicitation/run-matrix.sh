#!/bin/bash
# Real-world MCP elicitation matrix driver. See README.md.
# Usage: run-matrix.sh [client] [scenario]
#   client:   claude-code | codex   (default: both)
#   scenario: accept | timeout | cancel  (default: all)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SHOTS_DIR="$HERE/shots"
source "$HERE/lib/engine.sh"

CLIENTS="${1:-claude-code codex}"
SCENARIOS="${2:-accept timeout cancel}"

mkdir -p "$SHOTS_DIR"
echo "== booting engine (mock LLM, admin MCP mode) =="
engine_start
trap engine_stop EXIT
KEY="$(engine_admin_key)"
[ -n "$KEY" ] || { echo "FATAL: could not mint admin key" >&2; exit 1; }

FAILED=0
for client in $CLIENTS; do
  command -v "${client%%-*}" >/dev/null 2>&1 || command -v claude >/dev/null 2>&1 || {
    echo "-- $client: binary not found, skipping"; continue; }
  for scenario in $SCENARIOS; do
    echo "== cell: $client × $scenario =="
    if "$HERE/clients/$client.sh" "$scenario" "$KEY"; then
      echo "-- $client × $scenario: PASS"
    else
      echo "-- $client × $scenario: FAIL"
      FAILED=1
    fi
  done
done

echo
echo "== verdicts =="
cat "$SHOTS_DIR"/*.verdict 2>/dev/null || true
exit "$FAILED"
