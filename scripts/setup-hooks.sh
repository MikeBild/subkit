#!/usr/bin/env sh

set -e

if [ ! -d .git ] && [ ! -f .git ]; then
  exit 0
fi

for f in .githooks/*; do
  [ -f "$f" ] && chmod +x "$f" || true
done

current=$(git config --get core.hooksPath || true)
if [ "$current" = ".githooks" ]; then
  exit 0
fi
git config core.hooksPath .githooks
printf '[setup-hooks] core.hooksPath → .githooks (pre-commit now runs biome + tsc)\n'
