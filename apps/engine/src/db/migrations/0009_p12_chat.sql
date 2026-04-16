-- P12: chat adapters (Slack / Teams / Google Chat).
--
-- The core chat_* tables (workspaces, identities, sessions, deliveries)
-- were already created in 0000. P12 only needs one new table — the
-- `chat_link_tokens` used by the `/subkit link` deeplink flow. The
-- install-time OAuth `chat_oauth_states` table is punted to a later
-- phase (see plan).

CREATE TABLE IF NOT EXISTS "chat_link_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "platform" text NOT NULL,
  "workspace_id" text NOT NULL,
  "token" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_link_tokens"
    ADD CONSTRAINT "chat_link_tokens_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "chat_link_tokens"
    ADD CONSTRAINT "chat_link_tokens_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_link_tokens_token_key"
  ON "chat_link_tokens" ("token");
