#!/usr/bin/env bash
#
# Version helper — single source of truth for the subkit semver.
#
# Reads from `.release-please-manifest.json` (what release-please
# updates on CI) and mirrors writes to `package.json` so compiled
# binaries (`bun build --define BUILD_VERSION=...`) stamp the same
# string the engine prints via `/v1/health`.
#
# Sourceable:
#   source scripts/release/version.sh
#   ver=$(current_version)
#   next=$(bump_version patch)
#   tag=$(tag_name "$next")

set -euo pipefail

# Resolve repo root from this file's location so calls work regardless
# of the operator's cwd. Prefixed names so sourcing this into another
# script (deploy.sh) doesn't clobber the caller's own `_SCRIPT_DIR`.
_VERSION_SH_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
_VERSION_SH_REPO=$(cd "$_VERSION_SH_DIR/../.." && pwd)
MANIFEST="$_VERSION_SH_REPO/.release-please-manifest.json"
PKG="$_VERSION_SH_REPO/package.json"

current_version() {
  # `.` is the release-please package name for this repo.
  node -e "process.stdout.write(require('$MANIFEST')['.'])"
}

tag_name() {
  local ver="$1"
  printf 'subkit-v%s\n' "$ver"
}

# Usage: bump_version <patch|minor|major|X.Y.Z>
# Prints the new version to stdout. Writes both files atomically
# (tmp + mv so an interrupted run never leaves a half-written JSON).
bump_version() {
  local level="$1"
  local cur
  cur=$(current_version)
  local next

  case "$level" in
    patch|minor|major)
      next=$(node -e "
        const [maj, min, pat] = '$cur'.split('.').map(Number);
        const lvl = '$level';
        const [M, m, p] =
          lvl === 'major' ? [maj + 1, 0, 0]
          : lvl === 'minor' ? [maj, min + 1, 0]
          : [maj, min, pat + 1];
        process.stdout.write(\`\${M}.\${m}.\${p}\`);
      ")
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      next="$level"
      ;;
    *)
      echo "bump_version: expected patch|minor|major|X.Y.Z, got: $level" >&2
      return 2
      ;;
  esac

  # Manifest: { ".": "X.Y.Z" }
  node -e "
    const fs = require('fs');
    const m = require('$MANIFEST');
    m['.'] = '$next';
    fs.writeFileSync('$MANIFEST.tmp', JSON.stringify(m, null, 2) + '\n');
    fs.renameSync('$MANIFEST.tmp', '$MANIFEST');
  "

  # package.json: preserves every other field, just rewrites version.
  node -e "
    const fs = require('fs');
    const p = require('$PKG');
    p.version = '$next';
    fs.writeFileSync('$PKG.tmp', JSON.stringify(p, null, 2) + '\n');
    fs.renameSync('$PKG.tmp', '$PKG');
  "

  printf '%s\n' "$next"
}

# If invoked directly (not sourced), treat argv as a subcommand.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    current) current_version ;;
    tag)     tag_name "${2:-$(current_version)}" ;;
    bump)    bump_version "${2:?usage: version.sh bump <patch|minor|major|X.Y.Z>}" ;;
    *)
      cat >&2 <<USAGE
usage: version.sh <command>

  current                       print current version from manifest
  tag [<ver>]                   print tag name for <ver> (default: current)
  bump <patch|minor|major|ver>  bump manifest + package.json, print new version
USAGE
      exit 2
      ;;
  esac
fi
