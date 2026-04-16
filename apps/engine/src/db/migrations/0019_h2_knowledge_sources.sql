-- H2: Knowledge Sources — persistent tenant-scoped knowledge from uploaded
-- enterprise files (PDF, DOCX, CSV, Excel, Markdown, etc.).
--
-- Two tables: knowledge_sources (metadata) + knowledge_chunks (indexed content).
-- Budgets enforced at service layer.

DO $$ BEGIN
  CREATE TYPE "knowledge_source_scope" AS ENUM ('global', 'workflow');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "knowledge_source_status" AS ENUM ('active', 'inactive', 'processing', 'error');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "knowledge_source_refresh" AS ENUM ('manual', 'scheduled', 'webhook');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "scope" "knowledge_source_scope" NOT NULL DEFAULT 'global',
  "workflow_id" uuid,
  "status" "knowledge_source_status" NOT NULL DEFAULT 'active',
  "source_type" text NOT NULL,
  "source_uri" text NOT NULL,
  "mime_type" text,
  "version" text NOT NULL,
  "bytes_total" integer NOT NULL DEFAULT 0,
  "chunk_count" integer NOT NULL DEFAULT 0,
  "refresh_strategy" "knowledge_source_refresh" NOT NULL DEFAULT 'manual',
  "refresh_cron" text,
  "refresh_webhook_secret" text,
  "last_refreshed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_sources"
  ADD CONSTRAINT "knowledge_sources_workflow_id_workflows_id_fk"
  FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_sources_tenant_slug_key"
  ON "knowledge_sources" USING btree ("tenant_id", "slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_tenant_idx"
  ON "knowledge_sources" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_tenant_scope_idx"
  ON "knowledge_sources" USING btree ("tenant_id", "scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_tenant_workflow_idx"
  ON "knowledge_sources" USING btree ("tenant_id", "workflow_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "knowledge_source_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "title" text,
  "path" text,
  "content" text NOT NULL,
  "byte_size" integer NOT NULL,
  "fingerprint" text NOT NULL,
  "tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("title",'') || ' ' || "content")) STORED,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "knowledge_chunks"
  ADD CONSTRAINT "knowledge_chunks_knowledge_source_id_fk"
  FOREIGN KEY ("knowledge_source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "knowledge_chunks_tenant_source_ordinal_idx"
  ON "knowledge_chunks" USING btree ("tenant_id", "knowledge_source_id", "ordinal");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_tsv_idx"
  ON "knowledge_chunks" USING GIN ("tsv");
