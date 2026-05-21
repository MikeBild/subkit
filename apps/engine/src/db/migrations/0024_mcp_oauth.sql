-- MCP OAuth 2.1 authorization server + resource server tables.
-- Four tenant-scoped tables enabling ChatGPT / Claude.ai / Cursor to connect
-- via OAuth to the /mcp endpoint. Uses SHA-256 hashing consistent with
-- api_keys and portal_tokens — plaintext secrets never persist.

-- ── mcp_oauth_clients ────────────────────────────────────────────────────────
-- One row per dynamically-registered OAuth client (RFC 7591). tenant_id is
-- null at DCR time; it binds at consent time (see mcp_oauth_authorization_codes).
CREATE TABLE IF NOT EXISTS "mcp_oauth_clients" (
  "id"                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_id"                  text NOT NULL,
  "redirect_uris"              jsonb NOT NULL DEFAULT '[]',
  "grant_types"                jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  "token_endpoint_auth_method" text NOT NULL DEFAULT 'none' CHECK ("token_endpoint_auth_method" = 'none'),
  "scope"                      text NOT NULL DEFAULT 'mcp:read',
  "client_name"                text,
  "software_id"                text,
  "registration_source"        text NOT NULL DEFAULT 'dcr' CHECK ("registration_source" IN ('dcr', 'manual')),
  "disabled_at"                timestamptz,
  "created_at"                 timestamptz NOT NULL DEFAULT now(),
  "updated_at"                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_clients_client_id_key"
  ON "mcp_oauth_clients" ("client_id");

-- ── mcp_oauth_authorization_codes ────────────────────────────────────────────
-- Single-use, ~60s TTL authorization codes (PKCE S256 only).
-- code_sha256 is the SHA-256 of the opaque plaintext code.
CREATE TABLE IF NOT EXISTS "mcp_oauth_authorization_codes" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"            uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id"            text NOT NULL,
  "user_id"              uuid NOT NULL,
  "code_sha256"          text NOT NULL,
  "code_challenge"       text NOT NULL,
  "code_challenge_method" text NOT NULL CHECK ("code_challenge_method" = 'S256'),
  "redirect_uri"         text NOT NULL,
  "scope"                text NOT NULL,
  "resource"             text,
  "state"                text,
  "expires_at"           timestamptz NOT NULL,
  "consumed_at"          timestamptz,
  "created_at"           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_authorization_codes_sha256_key"
  ON "mcp_oauth_authorization_codes" ("code_sha256");

CREATE INDEX IF NOT EXISTS "mcp_oauth_authorization_codes_expires_idx"
  ON "mcp_oauth_authorization_codes" ("expires_at");

-- ── mcp_oauth_refresh_tokens ─────────────────────────────────────────────────
-- Refresh tokens with rotation chain. rotated_to_id points forward to the
-- replacement token; reusing a rotated token revokes the whole chain.
CREATE TABLE IF NOT EXISTS "mcp_oauth_refresh_tokens" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id"      text NOT NULL,
  "user_id"        uuid NOT NULL,
  "prefix"         text NOT NULL,
  "token_sha256"   text NOT NULL,
  "scope"          text NOT NULL,
  "rotated_to_id"  uuid REFERENCES "mcp_oauth_refresh_tokens" ("id"),
  "expires_at"     timestamptz NOT NULL,
  "revoked_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_refresh_tokens_sha256_key"
  ON "mcp_oauth_refresh_tokens" ("token_sha256");

CREATE INDEX IF NOT EXISTS "mcp_oauth_refresh_tokens_prefix_idx"
  ON "mcp_oauth_refresh_tokens" ("prefix");

CREATE INDEX IF NOT EXISTS "mcp_oauth_refresh_tokens_tenant_idx"
  ON "mcp_oauth_refresh_tokens" ("tenant_id");

-- ── mcp_oauth_access_tokens ──────────────────────────────────────────────────
-- Short-lived access tokens (default 3600s). prefix is a 12-char indexed
-- lookup key; token_sha256 is the full SHA-256. refresh_token_id is nullable
-- for tokens issued without a refresh token (future grant types).
CREATE TABLE IF NOT EXISTS "mcp_oauth_access_tokens" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "client_id"        text NOT NULL,
  "user_id"          uuid NOT NULL,
  "prefix"           text NOT NULL,
  "token_sha256"     text NOT NULL,
  "scope"            text NOT NULL,
  "resource"         text,
  "refresh_token_id" uuid REFERENCES "mcp_oauth_refresh_tokens" ("id"),
  "expires_at"       timestamptz NOT NULL,
  "revoked_at"       timestamptz,
  "last_used_at"     timestamptz,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "mcp_oauth_access_tokens_sha256_key"
  ON "mcp_oauth_access_tokens" ("token_sha256");

CREATE INDEX IF NOT EXISTS "mcp_oauth_access_tokens_prefix_idx"
  ON "mcp_oauth_access_tokens" ("prefix");

CREATE INDEX IF NOT EXISTS "mcp_oauth_access_tokens_tenant_idx"
  ON "mcp_oauth_access_tokens" ("tenant_id");
