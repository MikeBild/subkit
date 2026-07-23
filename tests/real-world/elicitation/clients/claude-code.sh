#!/bin/bash
# Claude Code cell: fresh `claude` in tmux against the local engine's /mcp
# (streamable HTTP, bearer key). Claude Code renders the elicitation form
# at END of its agent turn — the cell waits for the turn to finish, then
# answers the rendered form via keystrokes.
# Usage: claude-code.sh <scenario: accept|timeout|cancel> <api_key>
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/engine.sh"
source "$HERE/../lib/tmux.sh"

SCENARIO="${1:?scenario}" ; KEY="${2:?api key}"
CELL="cc-$SCENARIO"
OUT="$SHOTS_DIR/claude-code-$SCENARIO"
WORKDIR="$(mktemp -d /tmp/sk-elicit-cc.XXXXXX)"

PROMPT="Use MCP server sk-elicit-matrix: call conversation_start with message 'Build a workflow to list users from an API'. Then poll conversation_get with the conversation_id until status is input_required or completed, then STOP and tell me the status. Do not answer any form yourself."

verdict() { echo "$1" | tee "$SHOTS_DIR/claude-code-$SCENARIO.verdict"; }

cleanup() { tmux_kill "$CELL"; rm -rf "$WORKDIR"; }
trap cleanup EXIT

( cd "$WORKDIR" && claude mcp add --transport http --scope local sk-elicit-matrix \
    http://localhost:3000/mcp --header "Authorization: Bearer $KEY" >/dev/null )

MARK="$(engine_log_mark)"
tmux_fresh "$CELL" "$WORKDIR"
tmux send-keys -t "$CELL" 'claude' Enter
tmux_wait "$CELL" "trust this folder|shortcuts|❯" 45 || { verdict "FAIL: claude did not start"; exit 1; }
if tmux capture-pane -p -t "$CELL" | grep -q "trust this folder"; then
  tmux send-keys -t "$CELL" Enter; sleep 4
fi
tmux_submit "$CELL" "$PROMPT"

# The agent turn must END (that is when Claude Code renders the form).
tmux_wait "$CELL" "requests your input" 240 \
  || { tmux_snap "$CELL" "$OUT-no-form"; verdict "FAIL: form never rendered"; exit 1; }
tmux_snap "$CELL" "$OUT-form"

case "$SCENARIO" in
  accept)
    sleep 65   # deliberately beat the OLD 60s timeout before answering
    tmux send-keys -t "$CELL" Space; sleep 1          # toggle confirmed
    tmux send-keys -t "$CELL" Down Down Down; sleep 1 # focus Accept
    tmux send-keys -t "$CELL" Enter; sleep 2
    tmux send-keys -t "$CELL" Enter; sleep 5          # settle double-focus variants
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
    sleep 30   # leave the form unanswered well past the old failure window
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
