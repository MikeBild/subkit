ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "tags" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_tenant_tags_idx" ON "knowledge_sources" USING gin ("tags");
