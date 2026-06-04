-- Add the `stats:read` RBAC permission to the catalog.
--
-- Gates the entire `/v1/stats/*` surface (executions / connectors /
-- events / llm). Distinct from the `metrics:read` *scope* used by
-- `/metrics` (Prometheus): that is infra-monitoring, this is the
-- tenant-scoped, time-bucketed product UX surface.
--
-- Admins win automatically via the evaluator's `builtin_admin`
-- short-circuit, so no role-grant backfill is needed here. Members are
-- intentionally NOT granted it (see rbac/seed.ts memberPermissionFilter)
-- because stats reveal cross-workflow operational posture; tenants who
-- want every member to see stats add it to a custom role.
--
-- Idempotent: ON CONFLICT DO NOTHING against the unique `name` index so
-- a re-run (or a fresh tenant whose bootstrap seed already upserted the
-- catalog) is a no-op.

INSERT INTO "permissions" ("name", "description", "resource_type")
VALUES (
  'stats:read',
  'Read tenant-scoped runtime statistics: workflow runs, connector calls, audit-class events, LLM usage',
  'tenant'
)
ON CONFLICT ("name") DO NOTHING;
