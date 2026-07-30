-- One owning table for one concept.
--
-- Migration 0034 copied every `mcp_servers` row into `connectors` with its
-- id preserved and re-owned its credential in place. This migration removes
-- what that copy left behind, so the release does not ship two tables that
-- both claim to answer "what external MCP servers does this tenant have?".
--
-- Ordering is load-bearing and the whole file runs in ONE transaction (the
-- runner wraps it), so a failure anywhere leaves the database untouched:
--
--   1. `mcp_oauth_states` is RE-OWNED BY RENAME, not by drop-and-add. The
--      column already holds the id its connector now has (0034 preserved
--      ids), so a rename is a pure metadata change that keeps every
--      in-flight authorization alive. Dropping and re-adding would strand
--      them — the browser would come back to a callback whose state row no
--      longer names a connector.
--   2. Only then may `mcp_servers` be dropped: both FKs into it are gone.
--   3. The credentials owner collapses from a nullable pair guarded by a
--      XOR check to one NOT NULL column. Its unique index loses the
--      `WHERE connector_id IS NOT NULL` predicate, which is now always true.

--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" DROP CONSTRAINT "mcp_oauth_states_mcp_server_id_mcp_servers_id_fk";--> statement-breakpoint
DROP INDEX "mcp_oauth_states_tenant_server_idx";--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" RENAME COLUMN "mcp_server_id" TO "connector_id";--> statement-breakpoint
ALTER TABLE "mcp_oauth_states" ADD CONSTRAINT "mcp_oauth_states_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_tenant_server_idx" ON "mcp_oauth_states" USING btree ("tenant_id","connector_id");--> statement-breakpoint

-- Credentials: one owner column, no XOR to keep honest.
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_owner_xor_check";--> statement-breakpoint
ALTER TABLE "credentials" DROP CONSTRAINT "credentials_mcp_server_id_mcp_servers_id_fk";--> statement-breakpoint
DROP INDEX "credentials_mcp_server_env_mode_key";--> statement-breakpoint
DROP INDEX "credentials_connector_env_mode_key";--> statement-breakpoint
-- 0034 re-owned every surviving MCP credential onto its connector IN PLACE
-- (the AES-GCM AAD is keyed on the credential id, so a copy would have
-- bricked the ciphertext). Any row still without an owner belongs to no
-- resource at all and can never be decrypted by any caller, so it is
-- removed rather than blocking the NOT NULL below.
DELETE FROM "credentials" WHERE "connector_id" IS NULL;--> statement-breakpoint
ALTER TABLE "credentials" ALTER COLUMN "connector_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_connector_env_mode_key" ON "credentials" USING btree ("connector_id","environment","mode");--> statement-breakpoint
ALTER TABLE "credentials" DROP COLUMN "mcp_server_id";--> statement-breakpoint

-- Stale OAuth client registrations, removed so the next handshake re-registers.
--
-- The interactive callback moved with the routes: /v1/mcp-servers/oauth/callback
-- became /v1/connectors/mcp/oauth/callback. An RFC 7591 registration records the
-- redirect_uri it was created with, and `McpDbOAuthClientProvider.clientInformation()`
-- returns a stored client whenever one exists — so the SDK would skip dynamic
-- registration and present the NEW redirect_uri under a client_id registered for
-- the OLD one. Any authorization server that enforces exact registration answers
-- redirect_uri_mismatch, and the operator sees it long after the upgrade that
-- caused it, with nothing pointing back here.
--
-- Deleting the registration is the only repair that cannot be skipped. The cost
-- is one re-authorization per interactively-authorized MCP connector: the access
-- and refresh tokens were issued to the client being removed, so they go with it.
-- A connector using static credentials (bearer, basic) is untouched.
DELETE FROM "credentials"
WHERE "mode" = 'oauth2_client'
  AND "connector_id" IN (SELECT "id" FROM "connectors" WHERE "driver" = 'mcp');--> statement-breakpoint

-- Last: the table itself. Both FKs into it are gone by now, so CASCADE has
-- nothing left to take with it.
ALTER TABLE "mcp_servers" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mcp_servers" CASCADE;
