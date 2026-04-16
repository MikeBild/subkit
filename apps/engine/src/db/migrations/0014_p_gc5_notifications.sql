-- P-GC5: notification channels + rules + deliveries.
--
-- Independent notification delivery path that runs alongside the
-- outbound webhook fanout. A `notification_rule` matches events by
-- type glob, workflow glob, severity floor, and request-source list
-- and routes them to a `notification_channel`. The service layer
-- applies a token-bucket rate limit and a persistent circuit breaker
-- before handing off to the chat adapter. `notification_deliveries`
-- records one row per dispatch attempt (sent / rate_limited /
-- breaker_open / failed) for observability.

CREATE TABLE IF NOT EXISTS "notification_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workspace_id" text NOT NULL,
  "channel_id" text NOT NULL,
  "platform" text NOT NULL,
  "default_severity" text NOT NULL DEFAULT 'info',
  "rate_limit_per_minute" integer NOT NULL DEFAULT 60,
  "circuit_state" text NOT NULL DEFAULT 'closed',
  "circuit_open_until" timestamp with time zone,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_channels"
    ADD CONSTRAINT "notification_channels_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_channels_tenant_ws_channel_idx"
  ON "notification_channels" ("tenant_id", "workspace_id", "channel_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "event_pattern" text NOT NULL,
  "workflow_pattern" text NOT NULL DEFAULT '*',
  "severity" text NOT NULL DEFAULT 'info',
  "request_source_filter" jsonb,
  "target_workspace_id" text NOT NULL,
  "target_channel_id" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_rules"
    ADD CONSTRAINT "notification_rules_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_rules_tenant_event_idx"
  ON "notification_rules" ("tenant_id", "event_pattern");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_rules_tenant_target_idx"
  ON "notification_rules" ("tenant_id", "target_workspace_id", "target_channel_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "rule_id" uuid,
  "channel_id" uuid,
  "event_type" text NOT NULL,
  "event_payload" jsonb,
  "severity" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_rule_fk"
    FOREIGN KEY ("rule_id") REFERENCES "notification_rules"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_channel_fk"
    FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_deliveries_tenant_status_idx"
  ON "notification_deliveries" ("tenant_id", "status", "created_at");
