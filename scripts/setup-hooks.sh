#!/usr/bin/env sh
# Point git at the checked-in .githooks/ directory. Safe + idempotent.
# Called automatically from `bun install` via the `postinstall` script.

set -e

# Only act when inside a repo clone (postinstall runs inside
# node_modules too, where there's no .git — silently skip).
if [ ! -d .git ] && [ ! -f .git ]; then
  exit 0
fi

# Make the checked-in hooks executable — `chmod` is preserved by git
# but a fresh clone on Windows / CI sometimes loses the bit.
for f in .githooks/*; do
  [ -f "$f" ] && chmod +x "$f" || true
done

current=$(git config --get core.hooksPath || true)
if [ "$current" = ".githooks" ]; then
  exit 0
fi
git config core.hooksPath .githooks
printf '[setup-hooks] core.hooksPath → .githooks (pre-commit now runs biome + tsc)\n'
