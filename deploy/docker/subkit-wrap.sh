#!/usr/bin/env bash
# Thin wrapper installed as `engine` and `sk` on PATH. A `docker exec`
# starts a fresh process that does NOT inherit the env the entrypoint
# computed for the running engine (notably the dynamic DATABASE_URL and
# MASTER_KEY). This sources the bootstrap env the entrypoint persisted so
# one-off invocations — `docker exec <c> engine --issue-admin-key`,
# `docker exec <c> sk …` — just work without re-supplying secrets.
#
# It dispatches to the real compiled binary by the name it was invoked as
# (engine -> engine.bin, sk -> sk.bin).
set -euo pipefail

RUNTIME_ENV=/data/config/runtime.env
if [ -f "$RUNTIME_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$RUNTIME_ENV"
  set +a
fi

exec "/usr/local/bin/$(basename "$0").bin" "$@"
