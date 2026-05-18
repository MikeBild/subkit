-- 0020: per-tenant files dedup counter.
--
-- Decouples the `dedup_hits` field on `GET /v1/files/stats` from the
-- audit ledger. The prior implementation read `audit_log` rows with
-- `action='file.created'` and `metadata->>'dedup' = 'true'`; that
-- coupled compliance retention to dashboard accuracy. If audit
-- retention shortens (operator-driven prune, archive-to-cold-store), the
-- stat silently drops without a code change.
--
-- The new table is a single UPSERT-per-hit counter: one row per tenant,
-- bumped on every dedup short-circuit (inline path sha256-match,
-- batch-create sha256-match, finalize sibling-dedup collapse). Storage
-- cost is constant per tenant; the stats query becomes a single
-- indexed lookup.

CREATE TABLE files_dedup_seen (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
