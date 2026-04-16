-- H2.5: Discovery — one-shot LLM analysis of uploaded enterprise files.
--
-- Three tables:
--   - discovery_runs: one batch of analyzed files
--   - discovery_files: per-file tracking
--   - discovery_artifacts: inferred domain objects for human review

DO $$ BEGIN
  CREATE TYPE "discovery_run_status" AS ENUM ('pending', 'analyzing', 'synthesizing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "discovery_artifact_kind" AS ENUM ('connector', 'skill', 'knowledge_source');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "discovery_artifact_status" AS ENUM ('proposed', 'approved', 'rejected', 'superseded');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discovery_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "conversation_id" uuid,
  "status" "discovery_run_status" NOT NULL DEFAULT 'pending',
  "label" text,
  "file_count" integer NOT NULL DEFAULT 0,
  "files_analyzed" integer NOT NULL DEFAULT 0,
  "artifact_count" integer NOT NULL DEFAULT 0,
  "token_usage" jsonb DEFAULT '{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}'::jsonb,
  "error" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "discovery_runs"
  ADD CONSTRAINT "discovery_runs_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "discovery_runs_tenant_status_idx"
  ON "discovery_runs" USING btree ("tenant_id", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discovery_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "mime_type" text,
  "byte_size" integer NOT NULL,
  "format" text NOT NULL,
  "content" text,
  "chunk_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'pending',
  "error" text,
  "fingerprint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "discovery_files"
  ADD CONSTRAINT "discovery_files_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "discovery_files"
  ADD CONSTRAINT "discovery_files_run_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "discovery_files_run_idx"
  ON "discovery_files" USING btree ("run_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "discovery_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "kind" "discovery_artifact_kind" NOT NULL,
  "status" "discovery_artifact_status" NOT NULL DEFAULT 'proposed',
  "title" text NOT NULL,
  "description" text,
  "draft" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "confidence" integer,
  "materialized_id" text,
  "materialized_type" text,
  "rejection_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "discovery_artifacts"
  ADD CONSTRAINT "discovery_artifacts_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "discovery_artifacts"
  ADD CONSTRAINT "discovery_artifacts_run_id_fk"
  FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "discovery_artifacts_run_kind_idx"
  ON "discovery_artifacts" USING btree ("run_id", "kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_artifacts_tenant_status_idx"
  ON "discovery_artifacts" USING btree ("tenant_id", "status");
