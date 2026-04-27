-- Skill-candidate pattern: extend the enum with `chained_workflow_pattern`.
--
-- Wave-3 detector emits this when `discover_systems_from_files` returns a
-- non-empty `potential_connections[]` graph — two or more systems linked
-- by a documented data flow. The detector seeds a Skill Candidate that
-- proposes a chained workflow ("source → destination") so the operator
-- can approve it and turn it into a starting point for `propose_step`.
--
-- Postgres enum extensions are non-transactional; the migration runner
-- handles each statement independently.

ALTER TYPE skill_candidate_pattern ADD VALUE IF NOT EXISTS 'chained_workflow_pattern';
