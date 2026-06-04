-- Index for time-bucketed audit-log stats filtered by action.
--
-- `GET /v1/stats/connectors` (action = 'connector.invoked') and
-- `GET /v1/stats/events` (?class= → an action set) both filter
-- `audit_log WHERE tenant_id = $1 AND action IN (...) AND ts >= $from`.
-- Today's only audit index is `(tenant_id, ts)` — there is no index on
-- `action`, so aggregating connector calls scans every audit row in the
-- window for the tenant (login events, drift scans, schedule fires, …).
--
-- One full `(tenant_id, action, ts)` btree covers both routes (the
-- decision in the issue: simpler ops than a connector-specific partial
-- index). Plain CREATE INDEX (the migration runner wraps each file in a
-- transaction, so CONCURRENTLY is unavailable); IF NOT EXISTS keeps it
-- idempotent.

CREATE INDEX IF NOT EXISTS "audit_log_tenant_action_ts_idx"
  ON "audit_log" ("tenant_id", "action", "ts");
