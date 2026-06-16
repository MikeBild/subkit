-- Anchor patch candidates to their drift endpoint so the proactive
-- scan can refresh-or-skip an already-active candidate instead of
-- inserting a duplicate every hour.
--
-- Why: the proactive drift scanner re-proposed an identical `safe`
-- patch for the same workflow/endpoint on every cadence tick, and
-- processDriftSignal had no idempotency key — 25+ identical
-- status='proposed' rows accumulated, none reviewed, none applied
-- (the fixture gate is skipped for proactive scans so they never
-- auto-applied). These columns give the scan an endpoint-level
-- identity to dedupe against. Null for workflow-scoped signals
-- (stdlib_version_drift, validation_failed) which carry no endpoint.

ALTER TABLE "patch_candidates" ADD COLUMN "connector_id" uuid;
ALTER TABLE "patch_candidates" ADD COLUMN "endpoint_key" text;

ALTER TABLE "patch_candidates"
  ADD CONSTRAINT "patch_candidates_connector_id_connectors_id_fk"
  FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "patch_candidates_endpoint_idx"
  ON "patch_candidates" ("tenant_id", "workflow_id", "connector_id", "endpoint_key", "status");

-- Clear the pre-existing proactive duplicate backlog. Every row born
-- from a proactive scan that is still 'proposed' is an unreviewed,
-- auto-generated proposal with null endpoint columns (created before
-- this migration). They cannot be deduped against the new endpoint
-- key, so retire them wholesale: the next proactive scan re-proposes a
-- single, correctly-keyed candidate for each live drift (and auto-
-- applies it when safe). Reactive/manual candidates are untouched.
UPDATE "patch_candidates"
SET "status" = 'superseded', "updated_at" = now()
WHERE "status" = 'proposed' AND "diff"->>'source' LIKE 'proactive%';
