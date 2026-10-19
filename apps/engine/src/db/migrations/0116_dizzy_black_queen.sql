CREATE TYPE "public"."tenant_origin" AS ENUM('self_hosted', 'self_service');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'pending_deletion');--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer_url" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "origin" "tenant_origin" DEFAULT 'self_hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" "tenant_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "owner_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_identity_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_issuer_subject_key" ON "auth_identities" USING btree ("issuer_url","subject");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_owner_identity_id_auth_identities_id_fk" FOREIGN KEY ("owner_identity_id") REFERENCES "subkit"."auth_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "subkit"."auth_identities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_owner_identity_key" ON "tenants" USING btree ("owner_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_auth_identity_key" ON "users" USING btree ("tenant_id","auth_identity_id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_origin_owner_check" CHECK (("tenants"."origin" = 'self_hosted' AND "tenants"."owner_identity_id" IS NULL) OR ("tenants"."origin" = 'self_service' AND "tenants"."owner_identity_id" IS NOT NULL AND NOT "tenants"."is_operator"));