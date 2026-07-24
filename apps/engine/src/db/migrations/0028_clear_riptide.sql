CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"subject" text NOT NULL,
	"email" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "users_tenant_oidc_key";--> statement-breakpoint
DROP INDEX "users_tenant_external_subject_key";--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_tenant_provider_subject_key" ON "user_identities" USING btree ("tenant_id","provider_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identities_tenant_user_provider_key" ON "user_identities" USING btree ("tenant_id","user_id","provider_id");--> statement-breakpoint
CREATE INDEX "user_identities_tenant_user_idx" ON "user_identities" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "oidc_subject";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "external_subject";