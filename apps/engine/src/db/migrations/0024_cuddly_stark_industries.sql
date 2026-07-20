ALTER TABLE "schema_versions" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD COLUMN "step_id" text;--> statement-breakpoint
ALTER TABLE "schema_versions" ADD COLUMN "observed_schema" jsonb;--> statement-breakpoint
CREATE INDEX "schema_versions_provenance_seen_idx" ON "schema_versions" USING btree ("tenant_id","connector_id","endpoint_key","workflow_id","step_id","seen_at");