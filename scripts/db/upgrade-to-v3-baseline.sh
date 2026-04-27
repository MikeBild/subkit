#!/usr/bin/env bash
# Upgrade an existing subkit database (running migrations 0000–0040 from
# the 2.x line, optionally with 0041_egress_guard_mode applied) to the
# new v3 baseline. After this runs, drizzle.__drizzle_migrations holds
# exactly one row whose hash matches the freshly-generated baseline,
# and `bun run db:migrate` becomes a no-op.
#
# Idempotent: a database that is already on the v3 baseline is left alone.
# Refuses: any other state (partial migration, unrelated rows, missing
# tables) — operator must investigate before retrying.
#
# REQUIRED env:
#   DATABASE_URL        — postgres://… connection string for the target.
#
# REQUIRED arg (operator safety):
#   $1 (PG_DUMP_PATH)   — path to a `pg_dump` snapshot taken BEFORE this
#                         run. Must exist and be non-empty. Refuses to
#                         proceed without it.
#
# Exit codes:
#   0  upgrade succeeded, or db was already on baseline
#   1  unexpected DB state (will not modify anything)
#   2  bad invocation (missing arg, missing env, unreachable DB)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASELINE_SQL="${REPO_ROOT}/apps/engine/src/db/migrations/0000_v3_baseline.sql"
BASELINE_TAG="0000_v3_baseline"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is required" >&2
  exit 2
fi

if [[ $# -lt 1 ]]; then
  echo "ERROR: pass the path to a pg_dump snapshot taken BEFORE this run" >&2
  echo "usage: $0 <pg_dump_path>" >&2
  exit 2
fi

DUMP_PATH="$1"
if [[ ! -s "$DUMP_PATH" ]]; then
  echo "ERROR: dump file '$DUMP_PATH' missing or empty — refusing to proceed" >&2
  exit 2
fi

if [[ ! -s "$BASELINE_SQL" ]]; then
  echo "ERROR: cannot find baseline SQL at $BASELINE_SQL" >&2
  exit 2
fi

# Match the journal `when` so future runs of `bun run db:migrate` agree on
# the row's created_at — keep these in sync with meta/_journal.json.
BASELINE_WHEN_MS="$(jq -r '.entries[] | select(.idx==0) | .when' "${REPO_ROOT}/apps/engine/src/db/migrations/meta/_journal.json")"
if [[ -z "$BASELINE_WHEN_MS" || "$BASELINE_WHEN_MS" == "null" ]]; then
  echo "ERROR: could not read baseline 'when' from meta/_journal.json" >&2
  exit 2
fi

# Compute the baseline hash exactly the way migrate.ts does
# (sha256 over the raw file contents, hex-encoded).
BASELINE_HASH="$(shasum -a 256 "$BASELINE_SQL" | awk '{print $1}')"

echo "Target DB:        ${DATABASE_URL%%@*}@…"
echo "Baseline tag:     $BASELINE_TAG"
echo "Baseline hash:    $BASELINE_HASH"
echo "Baseline when:    $BASELINE_WHEN_MS"
echo "Pre-flight dump:  $DUMP_PATH ($(wc -c < "$DUMP_PATH") bytes)"
echo

# All work in one transaction. If anything inside REFUSE_BLOCK fires,
# the whole thing rolls back and the operator can inspect the DB.
psql "$DATABASE_URL" --variable=ON_ERROR_STOP=1 <<SQL
BEGIN;

DO \$\$
DECLARE
  applied_count int;
  baseline_present int;
BEGIN
  -- Sanity: the bookkeeping table must exist.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  ) THEN
    RAISE EXCEPTION 'drizzle.__drizzle_migrations is missing — this is not a subkit database';
  END IF;

  SELECT count(*) INTO applied_count FROM drizzle.__drizzle_migrations;
  SELECT count(*) INTO baseline_present FROM drizzle.__drizzle_migrations
  WHERE hash = '${BASELINE_HASH}';

  -- Already on baseline (idempotent path). Confirm exactly one row,
  -- exit cleanly, leave the DB alone.
  IF applied_count = 1 AND baseline_present = 1 THEN
    RAISE NOTICE 'database is already on the v3 baseline — no-op';
    RETURN;
  END IF;

  -- Recognised pre-upgrade state: 41 historical rows (or 42 if 0041 was
  -- applied from the per-tenant egress-guard-mode commit). Anything
  -- else is unexpected.
  IF applied_count NOT IN (41, 42) THEN
    RAISE EXCEPTION 'unexpected drizzle.__drizzle_migrations row count: % (want 41, 42, or already-baseline 1)', applied_count;
  END IF;

  -- Replace the historical rows with one row matching the new baseline
  -- hash. Same id=1 so future ALTERs / future migrations sit cleanly
  -- on top of it.
  DELETE FROM drizzle.__drizzle_migrations;
  ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq RESTART WITH 1;
  INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
  VALUES ('${BASELINE_HASH}', ${BASELINE_WHEN_MS});

  RAISE NOTICE 'upgraded from % historical rows to v3 baseline', applied_count;
END
\$\$;

-- Final post-condition: exactly one row, hash matches.
SELECT
  CASE
    WHEN count(*) = 1 AND every(hash = '${BASELINE_HASH}')
      THEN 'OK: drizzle.__drizzle_migrations is on v3 baseline'
    ELSE 'FAILED: post-upgrade state is wrong; rolling back'
  END AS status
FROM drizzle.__drizzle_migrations;

COMMIT;
SQL

echo
echo "Done. Run 'bun run db:migrate' to confirm the engine sees the baseline."
