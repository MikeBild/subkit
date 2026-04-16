-- P11: Webhooks in/out.
--
--   * webhooks_inbound gains `native_verifier_config` jsonb for
--     provider-specific verifier options (GitHub/Stripe/custom).
--   * subscriptions gains a secondary secret triple (for rotation) and
--     `circuit_open_until` / `consecutive_failures` breaker state.
--   * deliveries grows full per-attempt history columns.
--   * webhook_replay_seen is a new table that dedups Standard Webhooks
--     `webhook-id` values per (tenant, inbound binding).

ALTER TABLE "webhooks_inbound"
  ADD COLUMN IF NOT EXISTS "native_verifier_config" jsonb;--> statement-breakpoint

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "rotating_secret_ciphertext" bytea;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "rotating_secret_iv" bytea;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "rotating_secret_auth_tag" bytea;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "circuit_open_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "consecutive_failures" integer NOT NULL DEFAULT 0;--> statement-breakpoint

ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "outbox_event_id" bigint;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "attempt_number" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "error" text;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "request_hash" text;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "event_type" text;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "target_url" text;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "response_body" text;--> statement-breakpoint
ALTER TABLE "deliveries"
  ADD COLUMN IF NOT EXISTS "duration_ms" integer;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "webhook_replay_seen" (
  "tenant_id" uuid NOT NULL,
  "webhook_id" uuid NOT NULL,
  "standard_webhook_id" text NOT NULL,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "webhook_replay_seen"
  ADD CONSTRAINT "webhook_replay_seen_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "webhook_replay_seen"
  ADD CONSTRAINT "webhook_replay_seen_webhook_id_webhooks_inbound_id_fk"
  FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks_inbound"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_replay_seen_key"
  ON "webhook_replay_seen" USING btree ("tenant_id", "webhook_id", "standard_webhook_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_replay_seen_seen_at_idx"
  ON "webhook_replay_seen" USING btree ("seen_at");
