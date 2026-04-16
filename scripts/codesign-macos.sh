#!/usr/bin/env sh
# Ad-hoc sign a bun-compiled binary so macOS AMFI will let it run.
# No-op on non-Darwin hosts. Safe to call repeatedly (--force).
#
# Why: `bun build --compile` produces a Mach-O that AMFI refuses to
# launch with "completely unsigned code" and SIGKILLs it before main
# runs. This is distinct from Gatekeeper quarantine — it applies to any
# unsigned binary, including ones you just compiled locally. Ad-hoc
# signing (`codesign --sign -`) satisfies AMFI's "must be signed" check
# without requiring an Apple Developer account.
#
# Bun quirk: `codesign --sign - --force` alone fails with "invalid or
# unsupported format for signature" on a freshly compiled Bun binary,
# even though the Mach-O carries an LC_CODE_SIGNATURE load command.
# Calling `codesign --remove-signature` first resets the signature
# region and lets the subsequent sign succeed. The remove step is a
# no-op on an already-unsigned file (exit 0) so the script stays
# idempotent.
#
# Ad-hoc signing is only enough for local dev and trusted internal
# hosts. Public distribution still requires a real Developer ID
# signature plus notarization.
set -e
[ "$(uname)" = "Darwin" ] || exit 0
[ -n "$1" ] || { echo "usage: $0 <binary>" >&2; exit 1; }
[ -f "$1" ] || { echo "codesign-macos: $1 not found" >&2; exit 1; }
codesign --remove-signature "$1" >/dev/null 2>&1 || true
codesign --sign - --force "$1"
