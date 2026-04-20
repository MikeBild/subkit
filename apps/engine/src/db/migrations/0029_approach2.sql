-- Approach 2: Pre-analyzed Multi-Step Workflow — schema additions.
-- Additive only: new columns with defaults, new table. Zero-downtime.
-- Each ALTER adds a column with a server-side default — no backfill needed.

-- ----- connectors: circuit breaker state ---------------------------------
ALTER TABLE "connectors" ADD COLUMN "circuit_state" text NOT NULL DEFAULT 'closed';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "circuit_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "circuit_failure_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "circuit_threshold" integer NOT NULL DEFAULT 5;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "circuit_reset_ms" integer NOT NULL DEFAULT 300000;--> statement-breakpoint

-- ----- skills: intent-based auto-load ------------------------------------
ALTER TABLE "skills" ADD COLUMN "trigger_keywords" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "auto_load" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- ----- conversation_attachments: Files API reference --------------------
ALTER TABLE "conversation_attachments" ADD COLUMN "files_api_id" text;--> statement-breakpoint

-- ----- connector_endpoint_schemas: extracted endpoint registry ----------
CREATE TABLE "connector_endpoint_schemas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connector_id" uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "method" text NOT NULL,
  "request_schema" jsonb,
  "query_schema" jsonb,
  "response_schema" jsonb,
  "expected_statuses" integer[] NOT NULL DEFAULT '{}',
  "idempotent" boolean NOT NULL DEFAULT false,
  "description" text,
  "source" text NOT NULL DEFAULT 'openapi',
  "confidence" integer NOT NULL DEFAULT 0,
  "extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "conn_ep_schemas_tenant_connector_idx" ON "connector_endpoint_schemas" ("tenant_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conn_ep_schemas_method_path_uq" ON "connector_endpoint_schemas" ("connector_id","method","path");--> statement-breakpoint
