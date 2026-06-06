-- Add endpoint_key to skill_candidates so connector-scoped repair candidates
-- carry their interface identity.
--
-- #202 made the repair detector emit one Skill Candidate per
-- (connector_id, endpoint_key, kind) — fingerprint repair:conn:endpoint:kind.
-- But upsertFromSignal's supersede step only matched on
-- (scope, pattern_kind, connector_id), with no endpoint discriminator, so a
-- connector with recurring drift on two endpoints had the second proposal
-- silently supersede the first every analysis pass — data loss of a valid,
-- evidence-backed candidate. The column lets the supersede WHERE include
-- endpoint_key (match the same value, or both NULL for patterns that aren't
-- endpoint-specific), restoring "one skill per interface = connector+endpoint".
--
-- Additive nullable column; IF NOT EXISTS keeps it idempotent. Existing rows
-- get NULL (correct: pre-#202 candidates were workflow-scoped).

ALTER TABLE "skill_candidates"
  ADD COLUMN IF NOT EXISTS "endpoint_key" text;
