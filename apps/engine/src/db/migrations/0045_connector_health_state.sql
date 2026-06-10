-- Rolled-up connector/workflow health state + endpoint-contract scan stamp.
--
-- Why: production diagnosis (Jun 2026) showed the engine learns about broken
-- integrations "too late" — Atlassian removed `/rest/api/3/search` (410 Gone)
-- and the affected Jira workflows silently returned "0 results" for weeks.
-- The classifier verdict existed but nothing persisted it. These columns are
-- the shared health model every detection path (runtime step failures,
-- deprecation headers, the proactive endpoint-contract scan, preflight) rolls
-- up into, and the surface `sk doctor` / list_connectors read from.
--
-- `health_state` domains (text, app-enforced — mirrors needs_reauth's
-- bool-plus-reason discipline rather than a pg enum so states can evolve
-- without migrations):
--   connectors: ok | degraded | needs_update | needs_reauth
--   workflows:  ok | needs_attention | degraded
-- Writes go ONLY through connectors/health-state.ts (atomic edge-guarded
-- transition, one notification + audit row per transition edge).

ALTER TABLE "connectors" ADD COLUMN "health_state" text DEFAULT 'ok' NOT NULL;
ALTER TABLE "connectors" ADD COLUMN "health_reason" text;
ALTER TABLE "connectors" ADD COLUMN "health_error_code" text;
ALTER TABLE "connectors" ADD COLUMN "health_changed_at" timestamp with time zone;
ALTER TABLE "connectors" ADD COLUMN "sunset_at" timestamp with time zone;
ALTER TABLE "connectors" ADD COLUMN "successor_uri" text;

ALTER TABLE "workflows" ADD COLUMN "health_state" text DEFAULT 'ok' NOT NULL;
ALTER TABLE "workflows" ADD COLUMN "health_reason" text;
ALTER TABLE "workflows" ADD COLUMN "health_changed_at" timestamp with time zone;

ALTER TABLE "tenants" ADD COLUMN "last_endpoint_contract_scan_at" timestamp with time zone;
