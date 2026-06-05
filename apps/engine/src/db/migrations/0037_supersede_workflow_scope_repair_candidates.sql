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

UPDATE "skill_candidates"
  SET "status" = 'superseded', "updated_at" = now()
  WHERE "status" = 'proposed'
    AND "pattern_kind" = 'repair_pattern'
    AND "scope" = 'workflow';
