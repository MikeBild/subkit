#!/usr/bin/env sh
set -eu
[ "$(uname)" = "Darwin" ] || { echo "codesign-macos-folder: signing needs a macOS host" >&2; exit 1; }
[ -n "${1:-}" ] && [ -n "${2:-}" ] || { echo "usage: $0 <folder> <identity> [<entitlements>]" >&2; exit 1; }
[ -d "$1" ] || { echo "codesign-macos-folder: $1 is not a folder" >&2; exit 1; }
script_dir=$(dirname "$0")
list=$(mktemp)
trap 'rm -f "$list"' EXIT
find "$1" -type f | LC_ALL=C sort > "$list"
signed=0
while IFS= read -r file; do
  case "$(file -b "$file")" in
    Mach-O*)
      sh "$script_dir/codesign-macos.sh" "$file" "$2" "${3:-}"
      signed=$((signed + 1))
      ;;
  esac
done < "$list"
[ "$signed" -gt 0 ] || { echo "codesign-macos-folder: no Mach-O file in $1" >&2; exit 1; }
echo "codesign-macos-folder: signed $signed Mach-O files in $1"
