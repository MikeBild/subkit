-- Per-tenant CAS-stamp for the scheduler's skill-candidate pattern
-- analysis sweep.
--
-- The repair-pattern (and sibling) detectors run inside the
-- `skill-candidate.analyze` pg-boss job, but until now nothing enqueued
-- that job — the worker was registered yet never fired, so the detectors
-- never ran in normal operation. The scheduler reconciler now sweeps
-- tenants and enqueues the job per cadence; it compare-and-sets this
-- column (mirroring `last_proactive_scan_at`) so a multi-instance
-- deployment fires exactly once per cadence per tenant.
--
-- NULL means "never analysed" → the next reconciler pass fires
-- immediately. IF NOT EXISTS keeps the migration idempotent.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "last_skill_candidate_analyze_at" timestamptz;
