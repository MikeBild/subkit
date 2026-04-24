#!/usr/bin/env bash
# Terminology gate: fail the build if banned vocabulary leaks back into
# subkit source code.
#
# The banned-words list lives in scripts/terminology.banned.txt so the
# policy can evolve without editing shell logic. One term per line,
# word-boundary matched, case-insensitive.
#
# Permitted contexts (allow-list):
#  - tests/fixtures (we keep historic fixtures verbatim for replay)
#  - JSON/YAML data files and snapshot files
#  - self-healing/policy.ts explanatory comment about automation breadth
#  - this script itself (mentions the banned words by necessity)
#  - scripts/terminology.banned.txt (the policy itself)

set -euo pipefail

fail=0
BANNED_FILE="${BANNED_FILE:-scripts/terminology.banned.txt}"

if [ ! -f "$BANNED_FILE" ]; then
  echo "ERROR: banned-words file not found: $BANNED_FILE" >&2
  exit 2
fi

# Read non-comment, non-blank lines into an array.
banned=()
while IFS= read -r line; do
  trimmed="${line#"${line%%[![:space:]]*}"}"   # ltrim
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}" # rtrim
  case "$trimmed" in
    ""|"#"*) continue ;;
  esac
  banned+=("$trimmed")
done < "$BANNED_FILE"

if [ "${#banned[@]}" -eq 0 ]; then
  echo "terminology gate: no banned terms configured (banned list empty)"
else
  for word in "${banned[@]}"; do
    # Source trees we police. Docs/skills/seed markdown legitimately use
    # domain vocabulary when contrasting subkit with other categories — the
    # gate enforces TypeScript identifiers and generated API surfaces only.
    if grep -RniE "\\b${word}\\b" \
        apps/engine/src apps/sk/src apps/agent/src packages \
        --include='*.ts' --include='*.tsx' \
        --exclude-dir=tests --exclude-dir=test --exclude-dir=fixtures --exclude-dir=node_modules \
        --exclude-dir=out --exclude-dir=dist --exclude-dir=seed \
        2>/dev/null | grep -vE '(self-healing/policy\.ts)' ; then
      echo "ERROR: banned term '${word}' still appears in engine/sk/agent/packages TypeScript source" >&2
      fail=1
    fi
  done
fi

# OpenAPI-generated types must not carry the dead Automation schemas.
if grep -n 'Automation' packages/cli-core/src/engine-api/openapi.d.ts >/dev/null 2>&1; then
  echo "ERROR: packages/cli-core/src/engine-api/openapi.d.ts still contains 'Automation' — run 'bun run gen:openapi-client'" >&2
  fail=1
fi

# Legacy /v1/automations path must not reappear in generated openapi.
if grep -n '"/v1/automations' packages/cli-core/src/engine-api/openapi.json >/dev/null 2>&1; then
  echo "ERROR: /v1/automations path present in cli-core openapi.json" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "terminology gate failed" >&2
  exit 1
fi

echo "terminology gate: OK (${#banned[@]} term(s) enforced)"
