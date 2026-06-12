-- Single-use browser-openable OAuth2 start grants.
--
-- A skog_… token (sha256 stored at rest, portal-token discipline) lets
-- the LLM hand the operator a URL they can open in a browser to begin
-- the OAuth2 authorization-code dance without needing an API key.
-- The token is minted by mintOAuthStartGrantUrl and atomically claimed
-- (DELETE … RETURNING) by GET /v1/connectors/{id}/oauth/start?grant=….

CREATE TABLE "connector_oauth_start_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connector_id" uuid NOT NULL REFERENCES "connectors"("id") ON DELETE CASCADE,
  "token_sha256" text NOT NULL,
  "created_by_actor_id" uuid,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "connector_oauth_start_grants_token_sha256_key" ON "connector_oauth_start_grants" ("token_sha256");
