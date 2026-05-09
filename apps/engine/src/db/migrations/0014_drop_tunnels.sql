-- Drop the tunnels subsystem. The tunnel-agent binary, engine WS server,
-- registry, RBAC permissions, and CLI commands have all been removed in
-- this release; the schema follows.
ALTER TABLE "connectors" DROP COLUMN IF EXISTS "tunnel_id";
DROP TABLE IF EXISTS "tunnel_targets" CASCADE;
DROP TABLE IF EXISTS "tunnels" CASCADE;
DROP TYPE IF EXISTS "public"."tunnel_state";
