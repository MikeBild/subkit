-- Settings subsystem.
--
-- Adds two storage surfaces for runtime-configurable values that used
-- to live in process env:
--
--   tenants.settings       JSONB per-tenant override map. Keys absent
--                          here fall through to `engine_settings`,
--                          then to the registry default.
--   engine_settings        Global key/value store; values are JSONB so
--                          nested config (OAuth client tuples, LLM
--                          model arrays) round-trips without extra
--                          serialisation. `updated_by` carries the
--                          user id for audit lineage.
--
-- Schema and types for each key are declared in
-- apps/engine/src/settings/registry.ts. Cache invalidation is broadcast
-- through the existing pubsub plumbing on the `event.emitted` channel
-- with type `settings.changed` — see settings/service.ts.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "engine_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid
);
