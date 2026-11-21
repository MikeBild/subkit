CREATE TABLE IF NOT EXISTS "workflow_authority_pair_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"execution_environment" text NOT NULL,
	"expected_manifest_digest" text NOT NULL,
	"grant" jsonb NOT NULL,
	"first_approver_id" uuid NOT NULL,
	"second_approver_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"stale_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"authority_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_authority_pair_requests_state_check" CHECK ("workflow_authority_pair_requests"."state" IN ('pending', 'approved', 'declined', 'withdrawn', 'expired', 'stale')),
	CONSTRAINT "workflow_authority_pair_requests_environment_check" CHECK ("workflow_authority_pair_requests"."execution_environment" IN ('dev', 'prod')),
	CONSTRAINT "workflow_authority_pair_requests_digest_check" CHECK ("workflow_authority_pair_requests"."expected_manifest_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "workflow_authority_pair_requests_two_people_check" CHECK ("workflow_authority_pair_requests"."second_approver_id" IS NULL OR "workflow_authority_pair_requests"."second_approver_id" <> "workflow_authority_pair_requests"."first_approver_id"),
	CONSTRAINT "workflow_authority_pair_requests_approved_check" CHECK (("workflow_authority_pair_requests"."state" = 'approved') = ("workflow_authority_pair_requests"."authority_id" IS NOT NULL AND "workflow_authority_pair_requests"."second_approver_id" IS NOT NULL)),
	CONSTRAINT "workflow_authority_pair_requests_stale_check" CHECK (("workflow_authority_pair_requests"."state" = 'stale') = ("workflow_authority_pair_requests"."stale_reason" IS NOT NULL)),
	CONSTRAINT "workflow_authority_pair_requests_grant_check" CHECK (jsonb_typeof("workflow_authority_pair_requests"."grant") = 'object' AND octet_length("workflow_authority_pair_requests"."grant"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "workflow_approval_policy" text DEFAULT 'single' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "workflow_approval_policy_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "workflow_approval_policy_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN IF NOT EXISTS "notifications_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD COLUMN IF NOT EXISTS "notifications_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" DROP CONSTRAINT IF EXISTS "workflow_authority_pair_requests_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" ADD CONSTRAINT "workflow_authority_pair_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" DROP CONSTRAINT IF EXISTS "workflow_authority_pair_requests_first_approver_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" ADD CONSTRAINT "workflow_authority_pair_requests_first_approver_id_users_id_fk" FOREIGN KEY ("first_approver_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" DROP CONSTRAINT IF EXISTS "workflow_authority_pair_requests_second_approver_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workflow_authority_pair_requests" ADD CONSTRAINT "workflow_authority_pair_requests_second_approver_id_users_id_fk" FOREIGN KEY ("second_approver_id") REFERENCES "subkit"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_authority_pair_requests_state_idx" ON "workflow_authority_pair_requests" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_authority_pair_requests_workflow_idx" ON "workflow_authority_pair_requests" USING btree ("tenant_id","workflow_id");--> statement-breakpoint
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_workflow_approval_policy_check";--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_workflow_approval_policy_check" CHECK ("tenants"."workflow_approval_policy" IN ('single', 'pair'));--> statement-breakpoint
ALTER TABLE "user_setup_preferences" DROP CONSTRAINT IF EXISTS "user_setup_preferences_pause_check";--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD CONSTRAINT "user_setup_preferences_pause_check" CHECK ("user_setup_preferences"."notifications_paused_until" IS NULL OR ("user_setup_preferences"."notifications_paused_at" IS NOT NULL AND "user_setup_preferences"."notifications_paused_until" > "user_setup_preferences"."notifications_paused_at"));--> statement-breakpoint
ALTER TABLE "user_setup_preferences" DROP CONSTRAINT IF EXISTS "user_setup_preferences_approver_check";--> statement-breakpoint
ALTER TABLE "user_setup_preferences" ADD CONSTRAINT "user_setup_preferences_approver_check" CHECK (("user_setup_preferences"."approver_kind" IS NULL AND "user_setup_preferences"."approver_email" IS NULL AND "user_setup_preferences"."approver_user_id" IS NULL AND "user_setup_preferences"."approver_invite_id" IS NULL) OR ("user_setup_preferences"."approver_kind" = 'self' AND "user_setup_preferences"."approver_email" IS NULL AND "user_setup_preferences"."approver_user_id" IS NULL AND "user_setup_preferences"."approver_invite_id" IS NULL) OR ("user_setup_preferences"."approver_kind" IN ('teammate', 'pair') AND char_length("user_setup_preferences"."approver_email") BETWEEN 3 AND 254));