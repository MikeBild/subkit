-- GC3 + GC4: connector_templates table + skills.arguments column.
--
-- GC3 introduces the `connector_templates` table for tenant-specific
-- overrides on top of the built-in JSON catalogue. GC4 adds a nullable
-- `arguments` jsonb column to `skills` so MCP `completion/complete` can
-- enumerate per-skill argument names + descriptions.

CREATE TABLE IF NOT EXISTS "connector_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "driver" text NOT NULL,
  "base_url" text NOT NULL,
  "auth_type" text NOT NULL,
  "oauth" jsonb,
  "default_skill" text,
  "ingestion_source" text NOT NULL,
  "ingestion_url" text,
  "icon" text NOT NULL DEFAULT '',
  "description" text NOT NULL DEFAULT '',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "connector_templates"
    ADD CONSTRAINT "connector_templates_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_templates_tenant_slug_key"
  ON "connector_templates" ("tenant_id", "slug");
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "arguments" jsonb;
