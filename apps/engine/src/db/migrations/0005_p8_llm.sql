-- P8: LLM routing settings + usage ledger.
--
-- Two tables:
--   1. tenant_llm_settings — normalised per-tenant overrides for primary
--      / fallback model, provider, encrypted provider credentials, and a
--      monthly token budget cap. One row per tenant.
--   2. llm_usage — append-only per-call ledger used for budget accounting,
--      fallback telemetry, and operator debugging. Indexed by tenant +
--      created_at and tenant + month_bucket.
--
-- The P1 `tenants` table stays untouched — the tenant-level llm columns
-- left over from P1 remain as a fallback read path, but new writes land
-- in `tenant_llm_settings`.

CREATE TABLE IF NOT EXISTS "tenant_llm_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "llm_primary_model" text,
  "llm_fallback_model" text,
  "llm_provider" text,
  "llm_provider_credentials_ciphertext" bytea,
  "llm_provider_credentials_iv" bytea,
  "llm_provider_credentials_auth_tag" bytea,
  "llm_monthly_token_budget" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "tenant_llm_settings"
  ADD CONSTRAINT "tenant_llm_settings_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_llm_settings_tenant_key"
  ON "tenant_llm_settings" USING btree ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "tenant_id" uuid NOT NULL,
  "flow" text NOT NULL,
  "model" text NOT NULL,
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "total_tokens" integer NOT NULL DEFAULT 0,
  "latency_ms" integer NOT NULL DEFAULT 0,
  "result" text NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "month_bucket" bigint NOT NULL
);--> statement-breakpoint

ALTER TABLE "llm_usage"
  ADD CONSTRAINT "llm_usage_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "llm_usage_tenant_created_idx"
  ON "llm_usage" USING btree ("tenant_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_usage_tenant_month_idx"
  ON "llm_usage" USING btree ("tenant_id", "month_bucket");
