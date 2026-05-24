-- GLOBAL uniqueness on chat_workspaces(platform, workspace_id).
--
-- A real-world Slack `team_id` (and Teams/Google equivalents) belongs
-- to exactly ONE organisation. The original per-tenant unique key
-- (tenant_id, platform, workspace_id) let two tenants both install
-- the same workspace; the dispatcher / queue worker /
-- handleSyncInteraction all do `select ... where platform=? and
-- workspace_id=? limit 1` (they don't yet know the tenant when the
-- inbound event arrives), and the .limit(1) pick is non-deterministic
-- across the two rows — inbound events for the real Slack workspace
-- could be routed to whichever tenant Postgres returns first. Every
-- conversation, audit actor_id, run-as principal, credential scope,
-- and approval would move with it.
--
-- The new global unique index makes that scenario impossible at the
-- DB layer. The install route additionally short-circuits with 409
-- + a denied audit row before reaching this constraint so operators
-- get a clear error.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_workspaces_platform_workspace_global_key"
  ON "chat_workspaces" ("platform", "workspace_id");
