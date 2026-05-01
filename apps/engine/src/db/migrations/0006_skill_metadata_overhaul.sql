-- Skill + connector metadata overhaul (one bundled phase).
--
-- Folds two skill activation hints (`auto_load`, `trigger_keywords`)
-- into one richer discriminated union (`activates_when`).
-- `gates_tools` is **kept** — it expresses the inverse relationship
-- ("which tools are invisible until this skill is loaded") and is not
-- redundant with `activates_when` (which is "when does this skill
-- auto-load"). Adds capability/safety contract to every skill
-- (`input_schema`, `output_schema`, `side_effects`, `idempotency`,
-- `maturity`, `tags`). Replaces the free-form `operator_notes` blob on
-- `connectors` with categorized `operator_quirks`. Rewrites every
-- `connectors.template_snapshot` jsonb in place to drop the old field
-- and inject the new one so existing connectors stay introspectable
-- without an engine restart loop.
--
-- Per project memory rule "no backwards-compat shims": legacy
-- `auto_load` / `trigger_keywords` columns are DROPPED in this
-- migration. The Zod schemas + the seed parser are updated in the
-- same change. Re-applying the migration on a fresh DB is a no-op for
-- the rewrite step (no rows have the old shape).

------------------------------------------------------------------------
-- skills: drop the auto_load + trigger_keywords legacy columns; add
--         unified `activates_when` plus the capability/safety
--         contract. `gates_tools` stays as-is.
------------------------------------------------------------------------

ALTER TABLE "skills"
  DROP COLUMN "trigger_keywords",
  DROP COLUMN "auto_load";

ALTER TABLE "skills"
  ADD COLUMN "activates_when" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "input_schema"   jsonb,
  ADD COLUMN "output_schema"  jsonb,
  ADD COLUMN "side_effects"   text NOT NULL DEFAULT 'read',
  ADD COLUMN "idempotency"    text NOT NULL DEFAULT 'none',
  ADD COLUMN "maturity"       text NOT NULL DEFAULT 'stable',
  ADD COLUMN "tags"           jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Enum-like check constraints. Cheap to enforce in Postgres and lets
-- the engine trust the column shape without a defensive parse.
ALTER TABLE "skills"
  ADD CONSTRAINT "skills_side_effects_chk"
    CHECK ("side_effects" IN ('none', 'read', 'write', 'destructive')),
  ADD CONSTRAINT "skills_idempotency_chk"
    CHECK ("idempotency"  IN ('none', 'naturally', 'key_required')),
  ADD CONSTRAINT "skills_maturity_chk"
    CHECK ("maturity"     IN ('experimental', 'stable'));

------------------------------------------------------------------------
-- connectors: drop `operator_notes`, add `operator_quirks`.
------------------------------------------------------------------------

ALTER TABLE "connectors"
  DROP COLUMN "operator_notes";

ALTER TABLE "connectors"
  ADD COLUMN "operator_quirks" jsonb NOT NULL DEFAULT '{}'::jsonb;

------------------------------------------------------------------------
-- In-place rewrite of `connectors.template_snapshot` jsonb.
--
-- Existing snapshots carry the legacy `operator_notes` key (one
-- template, github, ships a real value; the other 93 carry null). The
-- rewrite drops the old key and inserts an empty `operator_quirks`
-- object — the next connector created from each template will pick up
-- the categorized quirks from the rebuilt builtin catalog. We do NOT
-- attempt to auto-categorize the github text here; that move lives in
-- `templates.json` (recategorized into `operator_quirks.error_handling`)
-- and propagates the next time the connector is recreated or the
-- template-snapshot is refreshed.
--
-- Idempotent: re-running on a snapshot that has already been rewritten
-- is a no-op because both `?` checks fail.
------------------------------------------------------------------------

UPDATE "connectors"
SET "template_snapshot" =
  ("template_snapshot" - 'operator_notes')
    || jsonb_build_object(
         'operator_quirks',
         COALESCE("template_snapshot" -> 'operator_quirks', '{}'::jsonb),
         'recipes',
         COALESCE("template_snapshot" -> 'recipes', '[]'::jsonb)
       )
WHERE "template_snapshot" IS NOT NULL
  AND ("template_snapshot" ? 'operator_notes'
       OR NOT ("template_snapshot" ? 'operator_quirks')
       OR NOT ("template_snapshot" ? 'recipes'));
