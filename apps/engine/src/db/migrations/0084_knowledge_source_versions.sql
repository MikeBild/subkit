CREATE TABLE "knowledge_source_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"knowledge_source_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"author_user_id" uuid,
	"author_system_account_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_source_versions" ADD CONSTRAINT "knowledge_source_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_source_versions" ADD CONSTRAINT "knowledge_source_versions_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("knowledge_source_id") REFERENCES "subkit"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_source_versions_source_version_key" ON "knowledge_source_versions" USING btree ("knowledge_source_id","version");--> statement-breakpoint
CREATE INDEX "knowledge_source_versions_tenant_source_idx" ON "knowledge_source_versions" USING btree ("tenant_id","knowledge_source_id");--> statement-breakpoint
INSERT INTO "knowledge_source_versions" ("tenant_id", "knowledge_source_id", "version", "content", "content_hash", "created_at")
SELECT
  ks."tenant_id",
  ks."id",
  1,
  CASE
    WHEN ks."source_type" = 'bundle' THEN jsonb_build_object(
      'kind', 'bundle',
      'filename', ks."slug" || '.bundle.json',
      'files', COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object('path', COALESCE(kc."path", '/' || ks."slug" || '.md'), 'content', kc."content")
            ORDER BY kc."ordinal"
          )
          FROM "knowledge_chunks" kc
          WHERE kc."tenant_id" = ks."tenant_id" AND kc."knowledge_source_id" = ks."id"
        ),
        '[]'::jsonb
      )
    )
    ELSE jsonb_build_object(
      'kind', 'document',
      'filename', ks."source_uri",
      'mime', ks."mime_type",
      'text', COALESCE(
        (
          SELECT string_agg(kc."content", E'\n\n' ORDER BY kc."ordinal")
          FROM "knowledge_chunks" kc
          WHERE kc."tenant_id" = ks."tenant_id" AND kc."knowledge_source_id" = ks."id"
        ),
        ''
      )
    )
  END,
  ks."version",
  COALESCE(ks."last_refreshed_at", ks."updated_at")
FROM "knowledge_sources" ks
WHERE ks."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "knowledge_source_versions" v WHERE v."knowledge_source_id" = ks."id"
  );
