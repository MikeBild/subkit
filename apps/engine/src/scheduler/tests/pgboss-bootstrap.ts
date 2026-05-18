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
 *  unlike `createBoss(...)`'s full `schemaInstall()`. */
export async function bootstrapMinimalPgbossSchema(db: Db): Promise<void> {
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS pgboss`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pgboss.job (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      state text NOT NULL,
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
      state text NOT NULL,
      data jsonb
    )
  `);
}
