-- 0018: proactive self-healing drift scan infrastructure.
--
-- The self-healing loop has historically run only reactively: a step
-- fails -> pg-boss enqueues `workflow.repair` -> `runSelfHealingLoop`
-- produces a Patch Candidate. There has been no way to surface drift
-- between executions, and no audit trail for ad-hoc scans triggered
-- by an operator. This migration adds two pieces that close that gap.
--
--   1) `tenants.last_proactive_scan_at` — stamp written by the
--      scheduler reconciler each cycle it CAS-fires a proactive scan
--      for the tenant. Compare-and-set on this column gives multi-
--      instance deployments exactly-once firing per cadence (same
--      pattern as `workflows_schedules.last_enqueued_at`). NULL means
--      "never scanned" -> the next reconcile pass fires immediately.
--
--   2) `self_healing_scans` table — persisted scan history. One row
--      per `scanForDrift()` invocation, regardless of trigger:
--        * source='scheduler'  — the 1h reconciler tick
--        * source='admin_http' — POST /v1/self-healing/scans
--        * source='mcp'        — the self_healing.scan MCP tool
--      Rows are created in status='running' before the scan starts
--      and updated to 'succeeded' (with counters + duration_ms) or
--      'failed' (with error text) on completion. The unique index on
--      `(tenant_id, idempotency_key)` backs the Idempotency-Key
--      header: a replayed POST within 24h returns the prior scan's
--      result instead of running twice. NULL idempotency_key never
--      collides because Postgres treats NULLs as distinct in unique
--      constraints by default.

ALTER TABLE tenants
  ADD COLUMN last_proactive_scan_at timestamptz;

CREATE TABLE self_healing_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source text NOT NULL,
  filters jsonb NOT NULL,
  actor_id uuid,
  idempotency_key text,
  signals_detected integer NOT NULL DEFAULT 0,
  candidates_created integer NOT NULL DEFAULT 0,
  unanchored_detected integer NOT NULL DEFAULT 0,
  duration_ms integer,
  status text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX self_healing_scans_tenant_created_idx
  ON self_healing_scans (tenant_id, created_at);

CREATE UNIQUE INDEX self_healing_scans_idem_key
  ON self_healing_scans (tenant_id, idempotency_key);
