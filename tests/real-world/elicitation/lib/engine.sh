#!/bin/bash
# Boot a local sk engine for the elicitation matrix: minimal scratch config
# (mock LLM, defaults otherwise), admin MCP mode, log to shots/engine.log.
# Exposes: engine_start, engine_stop, engine_admin_key, ENGINE_LOG.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SHOTS_DIR="${SHOTS_DIR:-$REPO_ROOT/tests/real-world/elicitation/shots}"
ENGINE_LOG="$SHOTS_DIR/engine.log"
ENGINE_CFG="$SHOTS_DIR/subkit.config.json"
ENGINE_PID_FILE="$SHOTS_DIR/engine.pid"

engine_start() {
  mkdir -p "$SHOTS_DIR"
  if curl -sf http://localhost:3000/v1/health >/dev/null 2>&1; then
    echo "FATAL: port 3000 already serves an engine — stop it first (the matrix must own the log)" >&2
    return 1
  fi
  echo '{"llm":{"provider":"mock"}}' > "$ENGINE_CFG"
  (
    cd "$REPO_ROOT"
    SUBKIT_CONFIG="$ENGINE_CFG" SK_MCP_MODE=admin \
      nohup bun run apps/engine/src/index.ts > "$ENGINE_LOG" 2>&1 &
    echo $! > "$ENGINE_PID_FILE"
  )
  for _ in $(seq 1 60); do
    curl -sf http://localhost:3000/v1/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FATAL: engine did not become healthy; tail of log:" >&2
  tail -20 "$ENGINE_LOG" >&2
  return 1
}

engine_admin_key() {
  (cd "$REPO_ROOT" && SUBKIT_CONFIG="$ENGINE_CFG" bun run apps/engine/src/db/issue-admin-key.ts) \
    | sed -n 's/^ key: *//p' | head -1
}

engine_stop() {
  [ -f "$ENGINE_PID_FILE" ] && kill "$(cat "$ENGINE_PID_FILE")" 2>/dev/null || true
  rm -f "$ENGINE_PID_FILE"
}

# Grep the engine log for lines written after a marker (line count taken
# with engine_log_mark) whose action matches $2. Prints matching ts+action.
engine_log_mark() { wc -l < "$ENGINE_LOG" | tr -d ' '; }
engine_log_since() {
  local mark="$1" pattern="$2"
  tail -n +"$((mark + 1))" "$ENGINE_LOG" | grep -E "\"action\":\"[^\"]*(${pattern})[^\"]*\"" || true
}
