ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "content_class" text DEFAULT 'no_content' NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "daily_limit" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "uses_day" date;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD COLUMN IF NOT EXISTS "uses_on_day" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN IF NOT EXISTS "timezone" text;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN IF NOT EXISTS "critical_breakthrough" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN IF NOT EXISTS "last_digest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" DROP CONSTRAINT IF EXISTS "tool_approval_rules_content_class_check";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_content_class_check" CHECK ("tool_approval_rules"."content_class" IN ('no_content', 'same_content', 'person_given'));--> statement-breakpoint
ALTER TABLE "tool_approval_rules" DROP CONSTRAINT IF EXISTS "tool_approval_rules_content_hash_check";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_content_hash_check" CHECK ("tool_approval_rules"."content_hash" IS NULL OR "tool_approval_rules"."content_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "tool_approval_rules" DROP CONSTRAINT IF EXISTS "tool_approval_rules_daily_check";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_daily_check" CHECK ("tool_approval_rules"."daily_limit" BETWEEN 1 AND 500 AND "tool_approval_rules"."uses_on_day" >= 0);--> statement-breakpoint
ALTER TABLE "user_setup_preferences" DROP CONSTRAINT IF EXISTS "user_setup_preferences_timezone_check";--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD CONSTRAINT "user_setup_preferences_timezone_check" CHECK ("user_setup_preferences"."timezone" IS NULL OR char_length("user_setup_preferences"."timezone") BETWEEN 1 AND 64);