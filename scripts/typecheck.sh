#!/usr/bin/env bash

set -eu

slots=${SUBKIT_TYPECHECK_SLOTS:-2}
root="${TMPDIR:-/tmp}/subkit-typecheck"
mkdir -p "$root"
held=""

release() {
  [ -n "$held" ] && rm -rf "$held"
}
trap release EXIT
trap 'exit 130' INT TERM

claim() {
  local slot="$root/slot-$1"
  if mkdir "$slot" 2>/dev/null; then
    echo $$ > "$slot/pid"
    held="$slot"
    return 0
  fi
  local owner
  owner=$(cat "$slot/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf "$slot"
  fi
  return 1
}

waited=0
while [ -z "$held" ]; do
  for i in $(seq 1 "$slots"); do
    claim "$i" && break
  done
  if [ -z "$held" ]; then
    [ "$waited" -eq 0 ] && echo "[typecheck] waiting for a free typecheck slot ($slots machine-wide)" >&2
    waited=1
    sleep 2
  fi
done

if [ "$#" -gt 0 ]; then
  "$@"
else
  tsc --noEmit
  tsc -p apps/cockpit/tsconfig.json
fi
