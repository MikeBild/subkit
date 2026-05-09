-- Drop the tunnels subsystem. The tunnel-agent binary, engine WS server,
-- registry, RBAC permissions, and CLI commands have all been removed in
-- this release; the schema follows.

-- Schema: tables, FK column, enum.
ALTER TABLE "connectors" DROP COLUMN IF EXISTS "tunnel_id";
DROP TABLE IF EXISTS "tunnel_targets" CASCADE;
DROP TABLE IF EXISTS "tunnels" CASCADE;
DROP TYPE IF EXISTS "public"."tunnel_state";

-- RBAC cleanup. The seeder is upsert-only — without this block, an
-- upgraded DB keeps `roles.tunnel_agent` and `permissions.tunnel:*`
-- as ghost rows that `GET /v1/rbac/{roles,permissions}` would surface.
-- Order matters: clear FK references before deleting the rows.
DELETE FROM "role_permissions"
  WHERE permission_id IN (SELECT id FROM "permissions" WHERE name LIKE 'tunnel:%');
DELETE FROM "permissions" WHERE name LIKE 'tunnel:%';
UPDATE "system_accounts"
  SET role_id = NULL
  WHERE role_id IN (SELECT id FROM "roles" WHERE name = 'tunnel_agent' AND tenant_id IS NULL);
DELETE FROM "roles" WHERE name = 'tunnel_agent' AND tenant_id IS NULL;
