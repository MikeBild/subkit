-- P6: connector documentation ingestion.
--
-- Two tables:
--   1. connector_documents — one row per ingest source (openapi URL,
--      markdown URL, llms.txt, etc.). Carries a content hash so a
--      re-ingest that finds no changes is a cheap no-op.
--   2. connector_document_chunks — one row per chunk carved out of a
--      document. A generated tsvector powers the `/docs/search` endpoint,
--      and a per-connector GIN index keeps the search cheap.

DO $$ BEGIN
  CREATE TYPE "doc_source_type" AS ENUM ('openapi', 'markdown', 'llms_txt', 'html');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "connector_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "source_type" "doc_source_type" NOT NULL,
  "source_uri" text NOT NULL,
  "version" text NOT NULL,
  "bytes_total" integer NOT NULL DEFAULT 0,
  "chunk_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "connector_documents"
  ADD CONSTRAINT "connector_documents_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_documents"
  ADD CONSTRAINT "connector_documents_connector_id_connectors_id_fk"
  FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "connector_documents_tenant_connector_idx"
  ON "connector_documents" USING btree ("tenant_id", "connector_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "connector_document_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "connector_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "title" text,
  "path" text,
  "content" text NOT NULL,
  "byte_size" integer NOT NULL,
  "fingerprint" text NOT NULL,
  "tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce("title", '') || ' ' || coalesce("path", '') || ' ' || "content")
  ) STORED,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "connector_document_chunks"
  ADD CONSTRAINT "connector_document_chunks_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks"
  ADD CONSTRAINT "connector_document_chunks_connector_id_connectors_id_fk"
  FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_document_chunks"
  ADD CONSTRAINT "connector_document_chunks_document_id_connector_documents_id_fk"
  FOREIGN KEY ("document_id") REFERENCES "public"."connector_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "connector_document_chunks_tenant_connector_ordinal_idx"
  ON "connector_document_chunks" USING btree ("tenant_id", "connector_id", "ordinal");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "connector_document_chunks_tsv_idx"
  ON "connector_document_chunks" USING gin ("tsv");
