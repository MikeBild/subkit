import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Idempotency markers for CODE data-backfills that run in the
 * migrations boot phase (`db/migrate.ts` → after the embedded SQL set).
 *
 * SQL backfills carry their own marker implicitly — the drizzle journal
 * row (`subkit.__drizzle_migrations`) guarantees once-only execution
 * of the DO $$ block (precedent: 0019_files_unify). A backfill written
 * in TypeScript (because it needs engine logic, e.g. the jsonata AST
 * rewriter of the item_var migration) cannot ride that journal: it runs
 * AFTER its schema migration and its completion is independent of the
 * SQL apply. The equivalent marker is one row here, inserted in the
 * same transaction-batch that finishes the backfill; a present row
 * makes the next boot a no-op.
 *
 * Deliberately minimal — name + timestamp, no framework.
 */
export const dataMigrations = pgTable("data_migrations", {
  name: text("name").primaryKey(),
  applied_at: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});
