-- One-shot cleanup for the repair-pattern detector rescope (see #202).
--
-- The repair-pattern detector used to emit `scope='workflow'` Skill
-- Candidates; it now emits `scope='connector'` (the repair is an
-- interface-level convention, not a per-workflow one). The supersede
-- predicate in skill-candidates/service.ts matches on `scope`, so a
-- pre-existing proposed workflow-scoped repair candidate would never be
-- superseded by the new connector-scoped one and would linger forever in
-- `GET /v1/skill-candidates?status=proposed`.
--
-- Flip any such lingering rows to `superseded`. Idempotent: re-running
-- only touches rows still in `proposed`. In practice this matches zero
-- rows (the old detector never produced signals against production-shaped
-- diffs), but the statement makes the rescope contract explicit and safe
-- for any environment that did accumulate them.
--
-- Audit non-negotiable: this mutates tenant-visible state, so it writes a
-- `skill_candidate.superseded` audit_log row per flipped candidate FIRST
-- (same action the in-flow supersede path emits). Both statements run in the
-- migration runner's per-file transaction, so the audit rows and the status
-- flip commit atomically. If zero candidates match, zero audit rows are
-- written.

INSERT INTO "audit_log"
  ("id", "tenant_id", "actor_type", "action", "resource_type", "resource_id", "result", "metadata")
SELECT
  gen_random_uuid(),
  "tenant_id",
  'system',
  'skill_candidate.superseded',
  'skill_candidate',
  "id"::text,
  'success',
  jsonb_build_object('superseded_reason', 'detector_rescope_0037', 'scope', 'workflow')
FROM "skill_candidates"
WHERE "status" = 'proposed'
  AND "pattern_kind" = 'repair_pattern'
  AND "scope" = 'workflow';

UPDATE "skill_candidates"
  SET "status" = 'superseded', "updated_at" = now()
  WHERE "status" = 'proposed'
    AND "pattern_kind" = 'repair_pattern'
    AND "scope" = 'workflow';
