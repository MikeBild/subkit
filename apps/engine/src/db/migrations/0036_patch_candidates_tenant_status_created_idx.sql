-- Index for the connector-pattern (repair_pattern) detector scan.
--
-- The reworked repair-pattern detector accumulates recurring self-healing
-- repairs into connector-scoped Skill Candidates. It scans patch_candidates
-- filtered by (tenant_id, status = 'applied', created_at >= cutoff) with NO
-- workflow_id predicate — the whole point is cross-workflow accumulation at the
-- interface (connector + endpoint) altitude.
--
-- The only existing index is `(tenant_id, workflow_id, status)`, which is
-- workflow-scoped and cannot serve a scan that deliberately ignores
-- workflow_id; without a covering index the detector scans every patch row for
-- the tenant each analysis pass. One `(tenant_id, status, created_at)` btree
-- covers the new access path. Plain CREATE INDEX (the migration runner wraps
-- each file in a transaction, so CONCURRENTLY is unavailable); IF NOT EXISTS
-- keeps it idempotent.
--
-- ops: a non-concurrent build takes a SHARE lock on patch_candidates for the
-- duration of the file's transaction. On a tenant with millions of
-- patch_candidates rows this blocks writes briefly — schedule the deploy
-- accordingly or pre-build the index CONCURRENTLY out-of-band before release.

CREATE INDEX IF NOT EXISTS "patch_candidates_tenant_status_created_idx"
  ON "patch_candidates" ("tenant_id", "status", "created_at");
