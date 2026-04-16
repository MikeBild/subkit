-- P5: connector + credential surface
--
-- 1. `connectors` gains env scoping, auth_type, config blob, and dsn for
--    non-HTTP drivers (postgres, etc.). The tenant+slug uniqueness widens
--    to include environment so a `dev` and `prod` connector can share a
--    name. Existing rows default to `dev` + `none`.
-- 2. `connector_oauth_states` is a short-lived table that stores PKCE
--    code_verifier + state between /oauth/start and /oauth/callback.

ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "environment" "environment" NOT NULL DEFAULT 'dev';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "auth_type" "credential_mode" NOT NULL DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "config" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "dsn" text;--> statement-breakpoint

DROP INDEX IF EXISTS "connectors_tenant_slug_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_tenant_slug_env_key" ON "connectors" USING btree ("tenant_id","slug","environment");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "connector_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_oauth_states_state_key" ON "connector_oauth_states" USING btree ("state");--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;
