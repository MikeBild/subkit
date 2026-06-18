-- AI SDK 6 / Tools Registry foundation tables.
--
-- Two additive tables, no existing-data migration:
--
-- 1. external_call_metering — append-only ledger for non-LLM provider
--    costs (Cohere rerank, Firecrawl, Exa, Browserbase, ...). Mirrors
--    `llm_usage` shape with provider-specific `units` instead of
--    weighted tokens. Audit correlation goes through
--    `(tenant_id, created_at)`, identical to llm_usage — no separate
--    audit_id pointer. If a future change adds audit pointers it MUST
--    update both ledgers in the same migration.
--
-- 2. mcp_servers — per-tenant configuration for external MCP servers
--    consumed by subkit's MCP client. `namespace` is a
--    URL-safe slug used as the tool-name prefix in the merged tool
--    palette: `mcp_<namespace>__<remote_tool_name>`. `auth_config` is
--    opaque jsonb because MCP auth_provider shapes (PKCE flows, dynamic
--    client registration) do not match the static credential rows.
--    Audit-action vocabulary documented in the schema header.
--
-- CHECK constraints fence stringly-typed columns server-side
-- (matches the audit_log.actor_type / .result pattern).

CREATE TABLE IF NOT EXISTS "external_call_metering" (
  "id" bigserial PRIMARY KEY,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "operation" text,
  "units" integer NOT NULL DEFAULT 0,
  "cost_usd" numeric(12, 6),
  "latency_ms" integer NOT NULL DEFAULT 0,
  "result" text NOT NULL,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "month_bucket" bigint NOT NULL,
  CONSTRAINT "external_call_metering_result_check"
    CHECK ("result" IN ('ok', 'error'))
);

CREATE INDEX IF NOT EXISTS "external_call_metering_tenant_created_idx"
  ON "external_call_metering" ("tenant_id", "created_at");

CREATE INDEX IF NOT EXISTS "external_call_metering_tenant_provider_month_idx"
  ON "external_call_metering" ("tenant_id", "provider", "month_bucket");

CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "namespace" text NOT NULL,
  "transport" text NOT NULL,
  "url" text NOT NULL,
  "auth_config" jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "last_handshake_at" timestamptz,
  "last_error" text,
  "tools_manifest_hash" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "mcp_servers_transport_check"
    CHECK ("transport" IN ('http', 'sse', 'stdio')),
  CONSTRAINT "mcp_servers_status_check"
    CHECK ("status" IN ('active', 'disabled', 'error')),
  -- Defence-in-depth: HTTP/MCP boundaries Zod-validate this, but
  -- internal writers could bypass that — a malformed slug breaks AI
  -- SDK's tool-name regex silently. Forbids `__` runs so the
  -- `mcp_<namespace>__<tool>` split stays deterministic, and forces
  -- alphanumeric leading/trailing chars. See schema header.
  CONSTRAINT "mcp_servers_namespace_shape_check"
    CHECK ("namespace" ~ '^[a-zA-Z0-9]([a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$' AND "namespace" !~ '__'),
  -- SECRET-BY-REFERENCE: reject root-level secret keys in
  -- auth_config. Writers must persist secrets in the `credentials`
  -- table and reference them via `token_ref` or `credential_id`.
  -- PostgreSQL forbids subqueries in CHECK so we maintain an explicit
  -- allowlist of denied key names. See schema header for the full
  -- contract.
  CONSTRAINT "mcp_servers_auth_config_no_inline_secrets_check"
    CHECK ("auth_config" IS NULL OR NOT (
      "auth_config" ? 'client_secret' OR
      "auth_config" ? 'password' OR
      "auth_config" ? 'passphrase' OR
      "auth_config" ? 'api_key' OR
      "auth_config" ? 'apikey' OR
      "auth_config" ? 'access_token' OR
      "auth_config" ? 'refresh_token' OR
      "auth_config" ? 'bearer_token' OR
      "auth_config" ? 'secret'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_servers_tenant_namespace_uq"
  ON "mcp_servers" ("tenant_id", "namespace");

CREATE INDEX IF NOT EXISTS "mcp_servers_tenant_status_idx"
  ON "mcp_servers" ("tenant_id", "status");
