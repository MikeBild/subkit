-- Drop the per-tenant `tenants.settings` JSONB column. Per-tenant runtime
-- configuration moved to a `tenants:` section in `subkit.config.json`
-- (see `apps/engine/src/config/schema.ts`) in v3.5.
--
-- The `engine_settings` table stays — it now holds boot-path sentinel state
-- (`onboarding.bootstrap.completed`, the bootstrap-token envelope) and is
-- no longer exposed as a user-facing settings store. Rows for the v3.4.x
-- registry keys (`llm.api_key`, `observability.langfuse_host`, etc.) are
-- ignored at runtime; operators can delete them by hand.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "settings";
