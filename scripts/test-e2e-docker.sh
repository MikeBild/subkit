#!/usr/bin/env sh
set -eu

owned_stack=0

cleanup() {
  if [ "$owned_stack" = "1" ] && [ "${SUBKIT_DOCKER_KEEP_STACK:-0}" != "1" ]; then
    bun run compose:down >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

bun run build:sk

if [ "${SUBKIT_DOCKER_SKIP_COMPOSE:-0}" != "1" ]; then
  bun run compose:up
  owned_stack=1
fi

bun run tests/e2e/docker-local.acceptance.ts
