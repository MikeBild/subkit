-- 0018: web-scraper #144 optimization_candidates table.
--
-- Parallel to `patch_candidates`. Emitted by the post-execution
-- optimisation analyzer rather than the drift detector. Operators
-- review + apply / reject through the same chat surface; no
-- auto-apply path.
--
-- The `kind` column is an enum that names the proposal shape; the
-- `diff` JSONB carries the concrete patch the operator can apply
-- (path-prefix narrowing, max_chars raise, wait_ms bump, etc.).
-- `rationale` is the operator-facing one-liner explaining why the
-- analyzer thinks this is worth applying.

CREATE TYPE optimization_candidate_kind AS ENUM (
  'narrow_path_prefix',
  'raise_max_chars',
  'increase_wait_ms',
  'prefer_llms_txt'
);

CREATE TABLE optimization_candidates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id              uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  kind                     optimization_candidate_kind NOT NULL,
  diff                     jsonb NOT NULL,
  classification           patch_classification NOT NULL,
  status                   patch_status NOT NULL,
  rationale                text NOT NULL,
  estimated_savings_pct    integer,
  outcome_window_ended_at  timestamptz,
  outcome_successes_after  integer NOT NULL DEFAULT 0,
  outcome_failures_after   integer NOT NULL DEFAULT 0,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX optimization_candidates_tenant_workflow_status_idx
  ON optimization_candidates(tenant_id, workflow_id, status);
