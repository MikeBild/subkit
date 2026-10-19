CREATE TABLE "identity_recovery_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_identity_id" uuid NOT NULL,
	"token_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "deletion_scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_recovery_sessions" ADD CONSTRAINT "identity_recovery_sessions_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "subkit"."auth_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_recovery_expiry_idx" ON "identity_recovery_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_deletion_schedule_check" CHECK (("tenants"."status" <> 'pending_deletion' AND "tenants"."deletion_requested_at" IS NULL AND "tenants"."deletion_scheduled_for" IS NULL) OR ("tenants"."status" = 'pending_deletion' AND "tenants"."origin" = 'self_service' AND "tenants"."deletion_requested_at" IS NOT NULL AND "tenants"."deletion_scheduled_for" IS NOT NULL AND "tenants"."deletion_requested_at" < "tenants"."deletion_scheduled_for"));