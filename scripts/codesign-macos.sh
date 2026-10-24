#!/usr/bin/env sh
set -e
[ "$(uname)" = "Darwin" ] || { echo "codesign-macos: ad-hoc signing needs a macOS host; use rcodesign via scripts/stage-cli-binaries.ts elsewhere" >&2; exit 1; }
[ -n "$1" ] || { echo "usage: $0 <binary>" >&2; exit 1; }
[ -f "$1" ] || { echo "codesign-macos: $1 not found" >&2; exit 1; }
codesign --remove-signature "$1" >/dev/null 2>&1 || true
codesign --sign - --force "$1"
