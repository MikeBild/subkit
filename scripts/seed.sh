#!/usr/bin/env sh
# Seed a default tenant + admin + personal API key.
#
# NOTE: The seed service now runs automatically on `docker compose up`.
# This script is a convenience for re-running the seed manually, e.g. after
# a `docker compose down -v` reset.
#
# Usage: sh scripts/seed.sh
#
# Prints the generated API key on stdout. Save it — it will not be shown
# again.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE="docker compose -p subkit --env-file .env"

if ! $COMPOSE ps --status running postgres | grep -q postgres; then
  echo "postgres is not running — start the stack first:"
  echo "  docker compose up -d --build"
  exit 1
fi

exec $COMPOSE run --rm \
  --entrypoint /bin/sh \
  migrate -c 'bun run apps/engine/src/db/seed.ts'
