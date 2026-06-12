-- Idempotency markers for CODE data-backfills that run in the
-- migrations boot phase (db/migrate.ts → after the embedded SQL set).
--
-- SQL backfills are once-only via the drizzle journal row (precedent:
-- 0019_files_unify's DO $$ block). A backfill written in TypeScript —
-- the item_var → $item workflow rewrite needs the engine's jsonata AST
-- rewriter — cannot ride that journal: it runs after its schema
-- migration and completes independently. Its marker is one row here,
-- inserted when the backfill finishes; a present row makes the next
-- boot a no-op. See apps/engine/src/db/migrations/itemvar-backfill.ts.

CREATE TABLE IF NOT EXISTS "data_migrations" (
  "name" text PRIMARY KEY,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now()
);
