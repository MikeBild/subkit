-- Connector operator notes — free-form text the operator writes about a
-- specific connector ("rate-limited to 5 rps after 9pm UTC", "always
-- include `?api-version=2025-01-01`", "treat 422 as success on the
-- /upsert endpoint"). The LLM context assembler inlines this verbatim
-- as a stable cache block whenever the connector is in scope, so the
-- value sits in the prompt cache and is essentially free per turn.
--
-- Nullable on purpose: only operators who care set it. A sibling
-- connector-scoped Skill remains the right home for longer multi-line
-- guidance with examples; this column is for short, imperative hints.

ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS operator_notes text;
