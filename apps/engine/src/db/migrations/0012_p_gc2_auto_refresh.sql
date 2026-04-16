-- P-GC2: docs ingestion auto-refresh + new source types.
--
-- 1. Extend the `doc_source_type` enum so the orchestrator can persist
--    chunks coming from the new graphql / postgres / file-upload sources.
-- 2. Add `connectors.auto_refresh_cron` so a connector owner can ask the
--    scheduler to re-run `connector.ingest-docs` on a cadence.
-- 3. Add `connectors.last_ingested_at` so the cron reconciler knows when
--    the next refresh is due.

ALTER TYPE "doc_source_type" ADD VALUE IF NOT EXISTS 'graphql';--> statement-breakpoint
ALTER TYPE "doc_source_type" ADD VALUE IF NOT EXISTS 'postgres';--> statement-breakpoint
ALTER TYPE "doc_source_type" ADD VALUE IF NOT EXISTS 'file_upload';--> statement-breakpoint

ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "auto_refresh_cron" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "last_ingested_at" timestamptz;
