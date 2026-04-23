-- Replace the plain UNIQUE (tenant_id, slug) on workflows with a PARTIAL
-- unique index restricted to rows that are NOT soft-deleted. Without this
-- a soft-deleted workflow blocks its slug forever, and the `commit_draft`
-- tool loops between slug-conflict errors and the LLM's delete+recreate
-- workaround — exactly the failure mode captured in session 46ee7ec8 where
-- six workflows were created in eight minutes trying to save one edit.
--
-- The data column stays the same; we only rebuild the index.

DROP INDEX IF EXISTS "workflows_tenant_slug_key";
--> statement-breakpoint

CREATE UNIQUE INDEX "workflows_tenant_slug_active_key"
  ON "workflows" ("tenant_id", "slug")
  WHERE "deleted_at" IS NULL;
