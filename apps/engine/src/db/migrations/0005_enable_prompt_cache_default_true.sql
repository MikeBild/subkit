-- Default `enable_prompt_cache` to true.
--
-- Anthropic prompt-caching covers the stable head of every converse turn —
-- system prompt, skill pack, tool definitions — which together account for
-- ~50k tokens of identical content turn-over-turn. Cache-block placement and
-- the provider call site have been correct since the feature shipped, but the
-- per-tenant flag defaulted to false, so caching was dormant. Session
-- a2292e7a burned ~948k tokens for one workflow because the same ~50k stable
-- head was re-billed across ~13 turns.
--
-- This migration:
--   1. Flips the column default for newly-inserted rows.
--   2. Backfills existing rows that still carry the old false default.
--      Operators who explicitly disabled the cache (set to false themselves)
--      look identical to never-set rows in the data, so this backfill is
--      a one-shot opt-in. Re-disabling is a single UPDATE.

ALTER TABLE "tenant_llm_settings"
  ALTER COLUMN "enable_prompt_cache" SET DEFAULT true;

UPDATE "tenant_llm_settings"
SET "enable_prompt_cache" = true
WHERE "enable_prompt_cache" = false;
