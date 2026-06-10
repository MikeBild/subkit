-- Let `credentials` rows be owned by an external MCP server instead of a
-- connector. Foundational for the external-MCP-client feature (#171):
-- external MCP servers reference encrypted bearer / OAuth tokens from
-- `mcp_servers.auth_config.token_ref`, and those secrets live here.
--
-- Ownership is XOR: every credential row belongs to EXACTLY ONE of a
-- connector or an MCP server. `connector_id` becomes nullable; a new
-- nullable `mcp_server_id` FK (ON DELETE CASCADE) is added; the
-- `credentials_owner_xor_check` enforces the exclusivity. The existing
-- connector slot-uniqueness index is rebuilt as a partial index so it no
-- longer spans MCP-server rows, and a mirrored partial index governs the
-- MCP-server slot.

ALTER TABLE "credentials" ALTER COLUMN "connector_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "mcp_server_id" uuid;
--> statement-breakpoint
ALTER TABLE "credentials"
  ADD CONSTRAINT "credentials_mcp_server_id_mcp_servers_id_fk"
  FOREIGN KEY ("mcp_server_id") REFERENCES "mcp_servers"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "credentials"
  ADD CONSTRAINT "credentials_owner_xor_check"
  CHECK (("connector_id" IS NOT NULL) <> ("mcp_server_id" IS NOT NULL));
--> statement-breakpoint
DROP INDEX IF EXISTS "credentials_connector_env_mode_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_connector_env_mode_key"
  ON "credentials" ("connector_id", "environment", "mode")
  WHERE "connector_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_mcp_server_env_mode_key"
  ON "credentials" ("mcp_server_id", "environment", "mode")
  WHERE "mcp_server_id" IS NOT NULL;
