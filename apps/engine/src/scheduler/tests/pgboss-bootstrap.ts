import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";

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
}
