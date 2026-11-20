CREATE TABLE IF NOT EXISTS "tool_approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"scope_hash" text NOT NULL,
	"scope" jsonb NOT NULL,
	"state" text DEFAULT 'observed' NOT NULL,
	"approvals_count" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"offered_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_approval_rules_state_check" CHECK ("tool_approval_rules"."state" IN ('observed', 'offered', 'active', 'dismissed', 'revoked')),
	CONSTRAINT "tool_approval_rules_scope_hash_check" CHECK ("tool_approval_rules"."scope_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tool_approval_rules_tool_check" CHECK (char_length("tool_approval_rules"."tool") BETWEEN 1 AND 200),
	CONSTRAINT "tool_approval_rules_scope_check" CHECK (jsonb_typeof("tool_approval_rules"."scope") = 'object' AND octet_length("tool_approval_rules"."scope"::text) <= 4096),
	CONSTRAINT "tool_approval_rules_counters_check" CHECK ("tool_approval_rules"."approvals_count" >= 1 AND "tool_approval_rules"."use_count" >= 0),
	CONSTRAINT "tool_approval_rules_revocation_check" CHECK (("tool_approval_rules"."state" = 'revoked') = ("tool_approval_rules"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_setup_preferences" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"default_chat_mode" text,
	"default_environment" text,
	"approver_kind" text,
	"approver_email" text,
	"approver_user_id" uuid,
	"approver_invite_id" uuid,
	"notification_schedule" jsonb,
	"first_job" text,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_setup_preferences_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "user_setup_preferences_chat_mode_check" CHECK ("user_setup_preferences"."default_chat_mode" IS NULL OR "user_setup_preferences"."default_chat_mode" IN ('ask', 'auto', 'plan')),
	CONSTRAINT "user_setup_preferences_environment_check" CHECK ("user_setup_preferences"."default_environment" IS NULL OR "user_setup_preferences"."default_environment" IN ('dev', 'prod')),
	CONSTRAINT "user_setup_preferences_approver_check" CHECK (("user_setup_preferences"."approver_kind" IS NULL AND "user_setup_preferences"."approver_email" IS NULL AND "user_setup_preferences"."approver_user_id" IS NULL AND "user_setup_preferences"."approver_invite_id" IS NULL) OR ("user_setup_preferences"."approver_kind" = 'self' AND "user_setup_preferences"."approver_email" IS NULL AND "user_setup_preferences"."approver_user_id" IS NULL AND "user_setup_preferences"."approver_invite_id" IS NULL) OR ("user_setup_preferences"."approver_kind" = 'teammate' AND char_length("user_setup_preferences"."approver_email") BETWEEN 3 AND 254)),
	CONSTRAINT "user_setup_preferences_schedule_check" CHECK ("user_setup_preferences"."notification_schedule" IS NULL OR (jsonb_typeof("user_setup_preferences"."notification_schedule") = 'object' AND octet_length("user_setup_preferences"."notification_schedule"::text) <= 256)),
	CONSTRAINT "user_setup_preferences_first_job_check" CHECK ("user_setup_preferences"."first_job" IS NULL OR char_length("user_setup_preferences"."first_job") BETWEEN 1 AND 120),
	CONSTRAINT "user_setup_preferences_services_check" CHECK (jsonb_typeof("user_setup_preferences"."services") = 'array' AND jsonb_array_length("user_setup_preferences"."services") <= 50 AND octet_length("user_setup_preferences"."services"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "tool_approval_rules" DROP CONSTRAINT IF EXISTS "tool_approval_rules_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_approval_rules" DROP CONSTRAINT IF EXISTS "tool_approval_rules_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tool_approval_rules" ADD CONSTRAINT "tool_approval_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" DROP CONSTRAINT IF EXISTS "user_setup_preferences_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD CONSTRAINT "user_setup_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" DROP CONSTRAINT IF EXISTS "user_setup_preferences_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD CONSTRAINT "user_setup_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_approval_rules_scope_key" ON "tool_approval_rules" USING btree ("tenant_id","user_id","scope_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_approval_rules_owner_state_idx" ON "tool_approval_rules" USING btree ("tenant_id","user_id","state");