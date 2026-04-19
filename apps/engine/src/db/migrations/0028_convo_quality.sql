-- Block A — Conversation Quality foundation.
--
-- Additiv. Zero-downtime: alle ALTERs fügen nur Spalten mit Defaults hinzu,
-- alle neuen Tabellen sind unabhängig. Keine Backfills erforderlich.

-- ----- Skills: seed provenance, tool gating, global slug ------------------

ALTER TABLE "skills" ADD COLUMN "seed_source" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "gates_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tenant_slug_uq" ON "skills" ("tenant_id","slug") WHERE "slug" IS NOT NULL;--> statement-breakpoint

-- Per-tenant overrides for seed-managed skills. Operators can hide or
-- body-override a seed skill without mutating the seed row.
CREATE TABLE "tenant_skill_overrides" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "skill_slug" text NOT NULL,
  "hidden" boolean NOT NULL DEFAULT false,
  "body_override" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("tenant_id", "skill_slug")
);--> statement-breakpoint

-- ----- Conversation attachments ------------------------------------------

CREATE TABLE "conversation_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "original_filename" text NOT NULL,
  "content_type" text,
  "size_bytes" bigint NOT NULL,
  "storage_uri" text NOT NULL,
  "sha256" text NOT NULL,
  "preview" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "conv_attach_conv_slug_uq" ON "conversation_attachments" ("conversation_id","slug");--> statement-breakpoint
CREATE INDEX "conv_attach_tenant_created_idx" ON "conversation_attachments" ("tenant_id","created_at");--> statement-breakpoint

-- ----- Conversation draft snapshots (auto-checkpoint, not auto-commit) ---

CREATE TABLE "conversation_draft_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "turn_index" integer NOT NULL,
  "draft" jsonb NOT NULL,
  "label" text,
  "snapshot_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "conv_draft_snap_conv_snap_idx" ON "conversation_draft_snapshots" ("conversation_id","snapshot_at");--> statement-breakpoint

-- ----- Tenant LLM settings: prompt + confirmation profile ---------------

ALTER TABLE "tenant_llm_settings" ADD COLUMN "system_prompt_additions" text;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD COLUMN "default_environment" text DEFAULT 'dev' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD COLUMN "auto_discovery" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD COLUMN "failure_notification_channels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD COLUMN "confirmation_profile" text DEFAULT 'strict' NOT NULL;--> statement-breakpoint

-- ----- Tenant DLP rules: field-level redaction on step outputs ----------

CREATE TABLE "tenant_dlp_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "path_match" text NOT NULL,
  "pattern_regex" text,
  "action" text NOT NULL,
  "reason" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "tenant_dlp_rules_tenant_enabled_idx" ON "tenant_dlp_rules" ("tenant_id","enabled");--> statement-breakpoint

-- ----- Execution step metadata: persisted placeholder usage + redactions

ALTER TABLE "execution_steps" ADD COLUMN "placeholders_used" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "redacted_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;
