// Bootstrap a minimal `pgboss` schema for tests that exercise code
// paths which query the queue substrate (e.g. the files cleanup cron's
// in-flight fid scan).
//
// `createBoss` performs a full pg-boss `schemaInstall()` which creates
// every queue table + indexes + functions. That is overkill (and slow)
// for tests that don't actually enqueue jobs — they just need the
// SELECTs against `pgboss.job` / `pgboss.schedule` / `pgboss.archive`
// to return zero rows instead of throwing `relation does not exist`.
//
// W5: the files-cleanup runner now treats a failed pg-boss scan as a
// deploy regression (not a benign warning) and skips the unlinked-TTL
// soft-delete pass for the tick. Tests that genuinely want to exercise
// the soft-delete behaviour MUST bootstrap a pgboss schema so the
// in-flight scan can succeed and the soft-delete proceeds.

import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";

/** Install the minimal `pgboss` schema needed for the files-cleanup
 *  cron's in-flight scan to succeed (with zero rows). Just schema +
 *  the three tables the cleanup runner queries with the columns it
 *  references (`name`, `state`, `data`). Idempotent — `IF NOT EXISTS`
 *  on every statement. Cheap: no indexes, no functions, no triggers,
 *  unlike `createBoss(...)`'s full `schemaInstall()`.
 *
 *  The `state` column is the real `pgboss.job_state` ENUM, mirrored
 *  from `node_modules/pg-boss/dist/plans.js` JOB_STATES:
 *  `created | retry | active | completed | cancelled | failed`. Tests
 *  that query against it then fail-fast when a query references a
 *  state pg-boss does not have. Pre-fix the column was plain `text`
 *  and the `'scheduled'` regression in `loadInFlightFidStrings` only
 *  surfaced in production (`invalid input value for enum
 *  pgboss.job_state: "scheduled"`). Don't widen this enum without
 *  also widening pg-boss's own definition. */
export async function bootstrapMinimalPgbossSchema(db: Db): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS pgboss`);
  await db.execute(sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'pgboss' AND t.typname = 'job_state'
      ) THEN
        CREATE TYPE pgboss.job_state AS ENUM (
          'created', 'retry', 'active', 'completed', 'cancelled', 'failed'
        );
      END IF;
    END
    $$
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pgboss.job (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      state pgboss.job_state NOT NULL,
      data jsonb
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pgboss.schedule (
      name text PRIMARY KEY,
      data jsonb
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pgboss.archive (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      state pgboss.job_state NOT NULL,
      data jsonb
    )
  `);
}
