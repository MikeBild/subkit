-- Index for time-bucketed execution stats grouped/filtered by status.
--
-- `GET /v1/stats/executions` runs `date_trunc(bucket, started_at)` with
-- a `tenant_id = $1` filter plus optional `status` filter/group and
-- `percentile_cont` over `(finished_at - started_at)`. Today's indexes
-- don't cover that access pattern: `(tenant_id, status)` lacks the time
-- prefix, `(tenant_id, workflow_id, started_at)` lacks status. Without
-- this index, status-grouped percentile queries on busy tenants
-- seq-scan the executions table.
--
-- Plain (non-CONCURRENT) CREATE INDEX: the migration runner wraps every
-- file in a transaction (db/migrate.ts), and CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block. IF NOT EXISTS keeps it
-- idempotent.

CREATE INDEX IF NOT EXISTS "executions_tenant_status_started_idx"
  ON "executions" ("tenant_id", "status", "started_at");
