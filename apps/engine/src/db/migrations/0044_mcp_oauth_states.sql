-- Pending interactive-OAuth (2.1) flow state for the external-MCP CLIENT
-- direction (#171 follow-up). One row = one in-flight browser
-- authorization-code + PKCE round-trip against an external MCP server
-- that requires OAuth before its tools can be consumed.
--
-- Mirrors `connector_oauth_states` (migration that created it) but the FK
-- points at `mcp_servers` (ON DELETE CASCADE) instead of `connectors`.
-- No token / secret material is ever stored on this row — the callback
-- handler writes the resulting credential to the `credentials` table
-- (secret-by-reference). `code_verifier` may be empty on INSERT and is
-- UPDATEd once PKCE generates it, so it is NOT NULL DEFAULT ''.
-- `authorization_url` / `as_issuer` start NULL and are filled in by the
-- headless provider's redirect callback (`as_issuer` is the origin of the
-- authorization endpoint, re-checked against RFC 9207 `iss` at callback).
-- `started_by_actor_id` carries the principal that began the flow so the
-- unauthenticated callback can attribute the authorized / failed audit
-- rows to the flow's originator.

CREATE TABLE "mcp_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "mcp_server_id" uuid NOT NULL,
  "state" text NOT NULL,
  "code_verifier" text DEFAULT '' NOT NULL,
  "redirect_uri" text NOT NULL,
  "authorization_url" text,
  "as_issuer" text,
  "requested_scopes" text,
  "started_by_actor_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_oauth_states"
  ADD CONSTRAINT "mcp_oauth_states_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "mcp_oauth_states"
  ADD CONSTRAINT "mcp_oauth_states_mcp_server_id_mcp_servers_id_fk"
  FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_states_state_key" ON "mcp_oauth_states" ("state");
--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_tenant_server_idx"
  ON "mcp_oauth_states" ("tenant_id", "mcp_server_id");
