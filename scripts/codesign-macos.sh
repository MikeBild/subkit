#!/usr/bin/env sh
set -e
[ "$(uname)" = "Darwin" ] || { echo "codesign-macos: ad-hoc signing needs a macOS host; use rcodesign via scripts/stage-cli-binaries.ts elsewhere" >&2; exit 1; }
[ -n "$1" ] || { echo "usage: $0 <binary> [<identity> [<entitlements>]]" >&2; exit 1; }
[ -f "$1" ] || { echo "codesign-macos: $1 not found" >&2; exit 1; }
if [ -z "$2" ]; then
  codesign --remove-signature "$1" >/dev/null 2>&1 || true
  codesign --sign - --force "$1"
  exit 0
fi
name=$(basename "$1")
if [ -n "$3" ]; then
  [ -f "$3" ] || { echo "codesign-macos: entitlements file $3 not found" >&2; exit 1; }
  codesign --force --sign "$2" --options runtime --timestamp --identifier "dev.mikebild.subkit.${name%.*}" --entitlements "$3" "$1"
else
  codesign --force --sign "$2" --options runtime --timestamp --identifier "dev.mikebild.subkit.${name%.*}" "$1"
fi
codesign --verify --strict "$1"
