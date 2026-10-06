ALTER TABLE "connectors" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "description_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "category_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "catalog_input_hash" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "catalog_described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "description_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "category_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "catalog_input_hash" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "catalog_described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "description_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "category_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "catalog_input_hash" text;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "catalog_described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "description_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "category_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "catalog_input_hash" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "catalog_described_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "category" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "description_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "category_source" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "catalog_input_hash" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "catalog_described_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "connectors_tenant_category_idx" ON "connectors" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "files_tenant_category_idx" ON "files" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "knowledge_sources_tenant_category_idx" ON "knowledge_sources" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "skills_tenant_category_idx" ON "skills" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "workflows_tenant_category_idx" ON "workflows" USING btree ("tenant_id","category");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_category_format" CHECK ("connectors"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("connectors"."category") <= 40);--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_catalog_sources" CHECK ("connectors"."description_source" IN ('human', 'llm') AND "connectors"."category_source" IN ('human', 'llm'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_category_format" CHECK ("files"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("files"."category") <= 40);--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_catalog_sources" CHECK ("files"."description_source" IN ('human', 'llm') AND "files"."category_source" IN ('human', 'llm'));--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_category_format" CHECK ("knowledge_sources"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("knowledge_sources"."category") <= 40);--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_catalog_sources" CHECK ("knowledge_sources"."description_source" IN ('human', 'llm') AND "knowledge_sources"."category_source" IN ('human', 'llm'));--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_category_format" CHECK ("skills"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("skills"."category") <= 40);--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_catalog_sources" CHECK ("skills"."description_source" IN ('human', 'llm') AND "skills"."category_source" IN ('human', 'llm'));--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_category_format" CHECK ("workflows"."category" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("workflows"."category") <= 40);--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_catalog_sources" CHECK ("workflows"."description_source" IN ('human', 'llm') AND "workflows"."category_source" IN ('human', 'llm'));--> statement-breakpoint
UPDATE "workflows" AS w SET "description" = v."dag"->>'description' FROM "workflow_versions" AS v WHERE v."id" = w."current_version_id" AND (w."description" IS NULL OR btrim(w."description") = '') AND btrim(coalesce(v."dag"->>'description', '')) <> '';--> statement-breakpoint
WITH segs AS (SELECT "id", "tenant_id", array_remove(string_to_array("slug", '-'), '') AS a FROM "workflows" WHERE "deleted_at" IS NULL), prefixes AS (SELECT s."id", s."tenant_id", i, array_to_string(s.a[1:i], '-') AS p FROM segs s, generate_series(1, cardinality(s.a)) AS i), counts AS (SELECT "tenant_id", p, count(*) AS c FROM prefixes GROUP BY "tenant_id", p), best AS (SELECT DISTINCT ON (x."id") x."id", x.p FROM prefixes x JOIN counts k ON k."tenant_id" = x."tenant_id" AND k.p = x.p WHERE k.c >= 3 AND x.p ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(x.p) <= 40 ORDER BY x."id", k.c DESC, x.i DESC) UPDATE "workflows" AS w SET "category" = best.p, "category_source" = 'human' FROM best WHERE w."id" = best."id";--> statement-breakpoint
WITH resolved AS (SELECT c."id", lower(coalesce(c."template_snapshot"->>'category', t."category", '')) AS cat FROM "connectors" AS c LEFT JOIN "connector_templates" AS t ON t."tenant_id" = c."tenant_id" AND t."slug" = c."template_slug") UPDATE "connectors" AS c SET "category" = resolved.cat FROM resolved WHERE resolved."id" = c."id" AND resolved.cat ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(resolved.cat) <= 40 AND resolved.cat <> 'custom';--> statement-breakpoint
UPDATE "knowledge_sources" SET "category" = lower(sub.tag) FROM (SELECT "id", (SELECT tag FROM unnest("tags") WITH ORDINALITY AS u(tag, n) WHERE position(':' IN tag) = 0 AND lower(tag) ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(tag) <= 40 ORDER BY n LIMIT 1) AS tag FROM "knowledge_sources") AS sub WHERE sub."id" = "knowledge_sources"."id" AND sub.tag IS NOT NULL;--> statement-breakpoint
UPDATE "workflows" SET "description_source" = 'human' WHERE btrim(coalesce("description", '')) <> '';--> statement-breakpoint
UPDATE "connectors" SET "description_source" = 'human' WHERE btrim(coalesce("description", '')) <> '';--> statement-breakpoint
UPDATE "knowledge_sources" SET "description_source" = 'human' WHERE btrim(coalesce("description", '')) <> '' AND "description" NOT LIKE 'Endpoint index discovered from %';
