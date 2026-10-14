CREATE TABLE "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_unknown_grants" (
	"tenant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"unknown_since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_actor_type_check";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "creator_kind" "audit_actor_kind";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "creator_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_unknown_grants" ADD CONSTRAINT "mcp_oauth_unknown_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_identity_key" ON "mcp_oauth_grants" USING btree ("id","tenant_id","client_id","user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_client_idx" ON "mcp_oauth_grants" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_tenant_client_user_idx" ON "mcp_oauth_grants" USING btree ("tenant_id","client_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_unknown_grants_tenant_client_key" ON "mcp_oauth_unknown_grants" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_unknown_grants_client_idx" ON "mcp_oauth_unknown_grants" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "mcp_oauth_access_tokens" ADD CONSTRAINT "mcp_oauth_access_tokens_grant_identity_fk" FOREIGN KEY ("grant_id","tenant_id","client_id","user_id") REFERENCES "subkit"."mcp_oauth_grants"("id","tenant_id","client_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_refresh_tokens" ADD CONSTRAINT "mcp_oauth_refresh_tokens_grant_identity_fk" FOREIGN KEY ("grant_id","tenant_id","client_id","user_id") REFERENCES "subkit"."mcp_oauth_grants"("id","tenant_id","client_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_access_tokens_unknown_grant_idx" ON "mcp_oauth_access_tokens" USING btree ("client_id") WHERE "mcp_oauth_access_tokens"."grant_id" IS NULL;--> statement-breakpoint
CREATE INDEX "mcp_oauth_refresh_tokens_unknown_grant_idx" ON "mcp_oauth_refresh_tokens" USING btree ("client_id") WHERE "mcp_oauth_refresh_tokens"."grant_id" IS NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_unknown_actor_id_check" CHECK ("audit_log"."actor_type" <> 'unknown' OR "audit_log"."actor_id" IS NULL);--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" IN ('user','system_account','system','unknown'));--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_creator_identity_check" CHECK (("api_keys"."creator_kind" is null and "api_keys"."creator_id" is null) or ("api_keys"."creator_kind" = 'system' and "api_keys"."creator_id" is null) or ("api_keys"."creator_kind" in ('user', 'system_account') and "api_keys"."creator_id" is not null));