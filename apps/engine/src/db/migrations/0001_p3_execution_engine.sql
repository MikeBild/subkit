-- P3: execution engine core schema additions.
--
-- 1. execution_steps: add columns required for runtime telemetry, payload
--    offload pointers, retry/duration metadata, and the per-step request
--    metadata blob (status / headers / latency for `request` steps).
-- 2. execution_fixtures: relax NOT NULL on connector_id / endpoint_key /
--    request / response and add a `kind` discriminator + `body` blob so the
--    table can hold both connector dry-run fixtures and large-payload
--    offloads without introducing a parallel table.

ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "step_index" integer;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "result_storage_uri" text;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "result_preview" text;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN IF NOT EXISTS "request_meta" jsonb;--> statement-breakpoint

ALTER TABLE "execution_fixtures" ALTER COLUMN "connector_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "endpoint_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "request" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ALTER COLUMN "response" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'fixture' NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN IF NOT EXISTS "execution_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN IF NOT EXISTS "step_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN IF NOT EXISTS "body" jsonb;--> statement-breakpoint
ALTER TABLE "execution_fixtures" ADD COLUMN IF NOT EXISTS "byte_size" integer;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "execution_fixtures_kind_idx" ON "execution_fixtures" USING btree ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_fixtures_execution_idx" ON "execution_fixtures" USING btree ("execution_id");
