#!/bin/bash
# Codex cell: fresh `codex` in tmux against the local engine (streamable
# HTTP via a temporary `sk-elicit-matrix` server entry, removed on exit).
# Codex renders the elicitation form INLINE while the poll call is live.
# Usage: codex.sh <scenario: accept|timeout|cancel> <api_key>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/engine.sh"
source "$HERE/../lib/tmux.sh"

SCENARIO="${1:?scenario}" ; KEY="${2:?api key}"
CELL="codex-$SCENARIO"
OUT="$SHOTS_DIR/codex-$SCENARIO"
WORKDIR="$(mktemp -d /tmp/sk-elicit-codex.XXXXXX)"

PROMPT="Use MCP server sk-elicit-matrix: call conversation_start with message 'Build a workflow to list users from an API'. Then poll conversation_get until status is input_required or completed, then STOP and report the status. Do not answer any form yourself."

verdict() { echo "$1" | tee "$SHOTS_DIR/codex-$SCENARIO.verdict"; }

cleanup() { tmux_kill "$CELL"; rm -rf "$WORKDIR"; codex mcp remove sk-elicit-matrix >/dev/null 2>&1 || true; }
trap cleanup EXIT

codex mcp add sk-elicit-matrix --url http://localhost:3000/mcp \
  --bearer-token-env-var SK_ELICIT_MATRIX_KEY >/dev/null

MARK="$(engine_log_mark)"
tmux_fresh "$CELL" "$WORKDIR"
tmux send-keys -t "$CELL" "export SK_ELICIT_MATRIX_KEY=$KEY && codex" Enter
tmux_wait "$CELL" "trust the contents|model:" 45 || { verdict "FAIL: codex did not start"; exit 1; }
if tmux capture-pane -p -t "$CELL" | grep -q "trust the contents"; then
  tmux send-keys -t "$CELL" Enter; sleep 5
fi
tmux_submit "$CELL" "$PROMPT"

# Codex shows the form inline during the poll call.
tmux_wait "$CELL" "Field 1/2" 240 \
  || { tmux_snap "$CELL" "$OUT-no-form"; verdict "FAIL: form never rendered"; exit 1; }
tmux_snap "$CELL" "$OUT-form"

case "$SCENARIO" in
  accept)
    sleep 65   # deliberately beat the OLD 60s timeout before answering
    tmux send-keys -t "$CELL" Enter; sleep 2   # field 1: True
    tmux send-keys -t "$CELL" "ok"; sleep 1    # field 2: Enter on an EMPTY
    tmux send-keys -t "$CELL" Enter; sleep 8   # optional field won't submit
    tmux_snap "$CELL" "$OUT-answered"
    sleep 5
    if [ -n "$(engine_log_since "$MARK" 'native_answer_staged')" ] \
       && [ -n "$(engine_log_since "$MARK" 'approval.approved')" ]; then
      verdict "PASS: answer >65s staged + approved ($(engine_log_since "$MARK" 'native_answer_staged' | head -1))"
    else
      verdict "FAIL: no native_answer_staged/approval.approved in engine log"
      exit 1
    fi
    ;;
  timeout)
    sleep 30
    tmux_snap "$CELL" "$OUT-unanswered"
    if [ -z "$(engine_log_since "$MARK" 'native_transport_failed|form_fast_cancel')" ]; then
      verdict "PASS: form still pending after 30s, no transport failure recorded"
    else
      verdict "FAIL: transport failure/fast-cancel recorded while form was healthy"
      exit 1
    fi
    ;;
  cancel)
    sleep 5
    tmux send-keys -t "$CELL" Escape; sleep 5
    tmux_snap "$CELL" "$OUT-cancelled"
    if [ -n "$(engine_log_since "$MARK" 'native_answer_staged')" ]; then
      verdict "PASS: >2s cancel staged as a genuine user cancellation"
    else
      verdict "FAIL: cancel not staged"
      exit 1
    fi
    ;;
  *) verdict "FAIL: unknown scenario $SCENARIO"; exit 1 ;;
esac
