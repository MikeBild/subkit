-- One-shot schema reconciliation for production (or any droplet whose
-- DB came from the legacy migration lineage that pre-dates the v3
-- baseline embedded in the engine binary).
--
-- Why this exists
-- ---------------
-- v4.0.x onwards bundle a 14-migration set into the engine binary
-- (apps/engine/src/db/migrations/embedded.ts). On a fresh DB those 14
-- migrations apply cleanly. On a DB that previously ran an OLDER
-- lineage with different file hashes, runMigrations()'s positional
-- fallback (apps/engine/src/db/migrate.ts:140) silently treats every
-- embedded migration as "already applied" and just rewrites the hash
-- column — without ever running the SQL. The drizzle TS schema then
-- references columns / tables that don't exist on disk, and every
-- query against the affected tables fails with the actual pg error
-- buried in `err.cause` (now surfaced via the `errorFields` helper).
--
-- This script applies the SQL bodies of migrations 0001 through 0013
-- against such a drifted DB. Migration 0000 (v3_baseline) is
-- intentionally skipped because the legacy lineage already produced
-- an equivalent base table set; running v3_baseline's CREATE TABLEs
-- would fail. Every statement below is wrapped in IF EXISTS / IF NOT
-- EXISTS / DO-block guards so re-running is a no-op.
--
-- Apply with:
--   ssh <droplet> 'docker exec -i subkit-postgres-1 psql -U subkit -d subkit' \
--     < scripts/db/reconcile-prod-schema-4.1.0.sql
--
-- After this completes, re-deploying the engine binary will see
-- queries succeed against the now-converged schema. The
-- __drizzle_migrations table will still report drift via
-- /v1/diagnostics/drift (the rows from the legacy lineage are still
-- present); a separate journal cleanup is tracked for 4.1.1.

\set ON_ERROR_STOP on

-- No outer BEGIN/COMMIT: ALTER TYPE ADD VALUE (0004, 0013) cannot run
-- inside a transaction block. Each DDL statement is atomic on its own.
-- ON_ERROR_STOP halts the script on the first failure so a partial
-- run is observable rather than silently continuing.

-- ------------------------------------------------------------------
-- 0001 — settings tables
-- ------------------------------------------------------------------
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS "engine_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by" uuid
);

-- ------------------------------------------------------------------
-- 0002 — partial unique on connectors(tenant_id, slug, environment)
-- ------------------------------------------------------------------
DROP INDEX IF EXISTS "connectors_tenant_slug_env_key";
CREATE UNIQUE INDEX "connectors_tenant_slug_env_key"
  ON "connectors" ("tenant_id", "slug", "environment")
  WHERE "deleted_at" IS NULL;

-- ------------------------------------------------------------------
-- 0003 — workflow_versions.scope_index
-- ------------------------------------------------------------------
ALTER TABLE "workflow_versions"
  ADD COLUMN IF NOT EXISTS "scope_index" jsonb;

-- ------------------------------------------------------------------
-- 0004 — credential_mode.aws_sigv4
-- ------------------------------------------------------------------
ALTER TYPE "credential_mode" ADD VALUE IF NOT EXISTS 'aws_sigv4';

-- ------------------------------------------------------------------
-- 0005 — tenant_llm_settings.enable_prompt_cache default true
-- ------------------------------------------------------------------
ALTER TABLE "tenant_llm_settings"
  ALTER COLUMN "enable_prompt_cache" SET DEFAULT true;
UPDATE "tenant_llm_settings"
SET "enable_prompt_cache" = true
WHERE "enable_prompt_cache" = false;

-- ------------------------------------------------------------------
-- 0006 — skill metadata overhaul + connectors operator_quirks rename
-- (DO blocks added vs. the source migration so re-running is safe;
--  the source migration uses raw DROP/ADD COLUMN + ADD CONSTRAINT).
-- ------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'skills' AND column_name = 'trigger_keywords'
  ) THEN
    ALTER TABLE "skills" DROP COLUMN "trigger_keywords";
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'skills' AND column_name = 'auto_load'
  ) THEN
    ALTER TABLE "skills" DROP COLUMN "auto_load";
  END IF;
END $$;

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "activates_when" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "input_schema"   jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "output_schema"  jsonb;
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "side_effects"   text NOT NULL DEFAULT 'read';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "idempotency"    text NOT NULL DEFAULT 'none';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "maturity"       text NOT NULL DEFAULT 'stable';
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "tags"           jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_side_effects_chk'
  ) THEN
    ALTER TABLE "skills"
      ADD CONSTRAINT "skills_side_effects_chk"
        CHECK ("side_effects" IN ('none', 'read', 'write', 'destructive'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_idempotency_chk'
  ) THEN
    ALTER TABLE "skills"
      ADD CONSTRAINT "skills_idempotency_chk"
        CHECK ("idempotency"  IN ('none', 'naturally', 'key_required'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.skills'::regclass AND conname = 'skills_maturity_chk'
  ) THEN
    ALTER TABLE "skills"
      ADD CONSTRAINT "skills_maturity_chk"
        CHECK ("maturity"     IN ('experimental', 'stable'));
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'connectors' AND column_name = 'operator_notes'
  ) THEN
    ALTER TABLE "connectors" DROP COLUMN "operator_notes";
  END IF;
END $$;

ALTER TABLE "connectors"
  ADD COLUMN IF NOT EXISTS "operator_quirks" jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE "connectors"
SET "template_snapshot" =
  ("template_snapshot" - 'operator_notes')
    || jsonb_build_object(
         'operator_quirks',
         COALESCE("template_snapshot" -> 'operator_quirks', '{}'::jsonb),
         'recipes',
         COALESCE("template_snapshot" -> 'recipes', '[]'::jsonb)
       )
WHERE "template_snapshot" IS NOT NULL
  AND ("template_snapshot" ? 'operator_notes'
       OR NOT ("template_snapshot" ? 'operator_quirks')
       OR NOT ("template_snapshot" ? 'recipes'));

-- ------------------------------------------------------------------
-- 0007 — webhooks_inbound.origin
-- ------------------------------------------------------------------
ALTER TABLE "webhooks_inbound"
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'crud';

-- ------------------------------------------------------------------
-- 0008 — drop chat_link_tokens
-- ------------------------------------------------------------------
DROP TABLE IF EXISTS "chat_link_tokens" CASCADE;

-- ------------------------------------------------------------------
-- 0009 — drop tenants.settings (added by 0001, removed by 0009)
-- ------------------------------------------------------------------
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "settings";

-- ------------------------------------------------------------------
-- 0010 — workflow_run_state
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workflow_run_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "ciphertext" bytea NOT NULL,
  "iv" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "value_kind" text,
  "note" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_state_tenant_workflow_key_uniq"
  ON "workflow_run_state" ("tenant_id", "workflow_id", "key");

CREATE INDEX IF NOT EXISTS "workflow_run_state_tenant_workflow_idx"
  ON "workflow_run_state" ("tenant_id", "workflow_id");

-- ------------------------------------------------------------------
-- 0011 — workflow_waits
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workflow_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "step_id" text NOT NULL,
  "sleep_until_ts" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_waits_tenant_execution_step_uniq"
  ON "workflow_waits" ("tenant_id", "execution_id", "step_id");

CREATE INDEX IF NOT EXISTS "workflow_waits_sleep_until_idx"
  ON "workflow_waits" ("sleep_until_ts");

-- ------------------------------------------------------------------
-- 0012 — workflow_signals
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "workflow_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_signals_match_idx"
  ON "workflow_signals" ("tenant_id", "execution_id", "event_name");

CREATE INDEX IF NOT EXISTS "workflow_signals_received_at_idx"
  ON "workflow_signals" ("received_at");

-- ------------------------------------------------------------------
-- 0013 — credential_mode.token_mint
-- ------------------------------------------------------------------
ALTER TYPE "credential_mode" ADD VALUE IF NOT EXISTS 'token_mint';

\echo 'reconciliation complete — verify with: SELECT column_name FROM information_schema.columns WHERE table_name=''connectors'' AND column_name=''operator_quirks'';'
