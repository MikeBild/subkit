#!/usr/bin/env sh
set -eu
[ "$(uname)" = "Darwin" ] || { echo "notarize-macos: notarization needs a macOS host" >&2; exit 1; }
[ -n "${1:-}" ] || { echo "usage: $0 <binary or app>" >&2; exit 1; }
[ -e "$1" ] || { echo "notarize-macos: $1 not found" >&2; exit 1; }
[ -n "${APPLE_API_KEY_ID:-}" ] || { echo "notarize-macos: APPLE_API_KEY_ID is not set" >&2; exit 1; }
[ -n "${APPLE_API_ISSUER:-}" ] || { echo "notarize-macos: APPLE_API_ISSUER is not set" >&2; exit 1; }
[ -f "${APPLE_API_KEY:-}" ] || { echo "notarize-macos: APPLE_API_KEY must be the path of the key file" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive="$work/$(basename "$1").zip"
ditto -c -k --keepParent "$1" "$archive"
submit() {
  xcrun notarytool submit "$archive" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --timeout 45m --output-format json > "$work/result.json"
}
if ! submit; then
  if grep -q '"id"' "$work/result.json" 2>/dev/null; then
    cat "$work/result.json" >&2
    exit 1
  fi
  echo "notarize-macos: the upload of $1 failed, trying once more" >&2
  submit
fi
cat "$work/result.json"
echo
grep -q '"status" *: *"Accepted"' "$work/result.json" || { echo "notarize-macos: Apple did not accept $1" >&2; exit 1; }
