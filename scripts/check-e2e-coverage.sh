#!/usr/bin/env bash
# Coverage guard — fails when a CLI surface (slash command or `sk`
# subcommand group) is registered without a covering reference in
# tests/e2e/.
#
# Heuristic, not a proof of coverage. The point is to nudge — every
# new surface gets one e2e mention before it ships. If the grep finds
# the name in any e2e test (matrix entry, full test, or the COVERAGE
# matrix), the surface is considered tracked.
#
# Hook this in a pre-push (or pre-commit) and CI:
#   bash scripts/check-e2e-coverage.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

E2E_GLOB='tests/e2e/*.e2e.test.ts tests/e2e/COVERAGE.md tests/e2e/remote-health.smoke.ts'

extract_slash_names() {
  # Only the SLASH_COMMANDS array literal — stops at the closing
  # `] as const;` so the Fuse.js keys block at the bottom of slash.ts
  # (which has `name: "name"`, `name: "aliases"`) doesn't leak in.
  awk '/SLASH_COMMANDS/{f=1} f{print} /^\] as const;/{exit}' apps/sk/src/slash.ts \
    | grep -E 'name: *"[a-z][a-z0-9-]*"' \
    | sed -E 's/.*name: *"([^"]+)".*/\1/' \
    | sort -u
}

extract_sk_subcommands() {
  awk '/const SUB_COMMANDS: Record<string, SubEntry> = \{/{f=1; next} f{print} /^\};/{if(f) exit}' apps/sk/src/index.ts \
    | grep -E '^[[:space:]]+("[a-z][a-z-]*"|[a-z][a-z-]*): *\{' \
    | sed -E 's/^[[:space:]]+"?([a-z][a-z-]*)"?:.*/\1/' \
    | sort -u
}

missing=0

echo "==> Slash commands"
for name in $(extract_slash_names); do
  if ! grep -RIE "/${name}\b|\"${name}\"" $E2E_GLOB >/dev/null 2>&1; then
    echo "  ✘ /${name} — no e2e reference"
    missing=$((missing + 1))
  fi
done

echo "==> sk subcommands"
for name in $(extract_sk_subcommands); do
  if ! grep -RIE "\b${name}\b" $E2E_GLOB >/dev/null 2>&1; then
    echo "  ✘ sk ${name} — no e2e reference"
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo
  echo "$missing CLI surface(s) lack an e2e reference. Add a test under"
  echo "tests/e2e/ AND an entry in tests/e2e/COVERAGE.md before pushing."
  exit 1
fi

echo
echo "✓ All registered CLI surfaces are mentioned in tests/e2e/."
