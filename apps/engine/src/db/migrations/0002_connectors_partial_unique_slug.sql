-- Partial unique index on (tenant_id, slug, environment) for
-- connectors so soft-deleted rows free up their slug. Mirrors the
-- pattern already in place on `workflows`.
--
-- Pre-fix session abeefb33: user soft-deleted `digitalocean`,
-- recreated it with the same slug → 23505 unique_violation, the LLM
-- saw "database error" and emitted cannot_help with no actionable
-- recovery path. Post-fix the dead row no longer occupies the slug
-- namespace; recreate succeeds cleanly.

DROP INDEX IF EXISTS "connectors_tenant_slug_env_key";

CREATE UNIQUE INDEX "connectors_tenant_slug_env_key"
  ON "connectors" ("tenant_id", "slug", "environment")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
