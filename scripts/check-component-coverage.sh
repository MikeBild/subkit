#!/usr/bin/env bash
# Component-coverage gate — fails when a new component file under
# apps/sk/src/shell/, apps/sk/src/domain/, apps/sk/src/repl/transcript/,
# apps/sk/src/repl/slash/, or apps/sk/src/repl/status-line/ ships
# without a paired test.
#
# Heuristic: every `.tsx` (component) and every `.ts` module that
# re-exports a component-like surface should have a matching test
# file in apps/sk/src/tests/ or co-located alongside the source.
#
# The check matches the basename (no extension) against any of:
#   - apps/sk/src/tests/<basename>.test.ts(x)
#   - apps/sk/src/tests/<basename>.component.test.tsx
#   - apps/sk/src/tests/<basename-snake>.test.ts(x)
#   - <dir>/<basename>.test.ts(x)
#
# Hook into the local quality gate (bun run verify) and CI.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WATCH_DIRS=(
  "apps/sk/src/shell"
  "apps/sk/src/domain"
  "apps/sk/src/repl/transcript"
  "apps/sk/src/repl/slash"
  "apps/sk/src/repl/status-line"
)

# Files explicitly excluded from the gate — barrel files, type-only
# modules, and per-tree index pages don't ship UI behavior.
EXCLUDES_REGEX='/index\.(ts|tsx)$|/types\.ts$'

snake_case() {
  # ToastQueue -> toast-queue, OAuthWaitView -> oauth-wait-view
  echo "$1" \
    | sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' \
    | tr '[:upper:]' '[:lower:]'
}

missing=()
total=0

for dir in "${WATCH_DIRS[@]}"; do
  [ -d "$dir" ] || continue
  while IFS= read -r file; do
    if echo "$file" | grep -E "$EXCLUDES_REGEX" >/dev/null; then continue; fi
    base="$(basename "$file")"
    # Strip the trailing extension.
    name="${base%.*}"
    snake="$(snake_case "$name")"
    total=$((total + 1))
    if grep -RIl --include="*.test.ts*" \
        -E "(from \"\\.\\.?/.*${name}|from \"\\.\\.?/.*${snake}|describe\\(.*${name})" \
        apps/sk/src/tests "$dir" >/dev/null 2>&1; then
      continue
    fi
    # Fallback: file-name based heuristics.
    if [ -f "apps/sk/src/tests/${name}.test.ts" ] \
      || [ -f "apps/sk/src/tests/${name}.test.tsx" ] \
      || [ -f "apps/sk/src/tests/${name}.component.test.tsx" ] \
      || [ -f "apps/sk/src/tests/${snake}.test.ts" ] \
      || [ -f "apps/sk/src/tests/${snake}.test.tsx" ] \
      || [ -f "apps/sk/src/tests/${snake}.component.test.tsx" ]; then
      continue
    fi
    missing+=("$file")
  done < <(find "$dir" -type f \( -name "*.tsx" -o -name "*.ts" \) | sort)
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "Component-coverage gate: ${#missing[@]} of $total files lack a paired test:" >&2
  for m in "${missing[@]}"; do
    echo "  - $m" >&2
  done
  echo "" >&2
  echo "Add a *.test.ts(x) or *.component.test.tsx referencing the file" >&2
  echo "(by import or describe block) before merging." >&2
  exit 1
fi

echo "Component-coverage gate: $total files OK"
