-- Phase 8: connector_templates schema enrichment.
--
-- Breaks out setup_hint → setup_instructions, adds version for schema
-- versioning, url_pattern for URL-based template matching, and rich
-- authoring metadata (keywords, inline_schema, probe_endpoint,
-- credential_hints, base_url_options, pagination_defaults, capabilities).
--
-- Existing tenant overrides default to empty / null values; a follow-up
-- UPDATE synthesises url_pattern from base_url so existing rows don't
-- regress on URL matching.

ALTER TABLE connector_templates
  ADD COLUMN IF NOT EXISTS setup_instructions text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS url_pattern text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS inline_schema jsonb,
  ADD COLUMN IF NOT EXISTS probe_endpoint jsonb,
  ADD COLUMN IF NOT EXISTS credential_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS base_url_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pagination_defaults jsonb,
  ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL
    DEFAULT '{"webhooks":false,"webhook_events":[],"rate_limits":null}'::jsonb;

-- Migrate existing setup_hint values if the old column still exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'connector_templates' AND column_name = 'setup_hint'
  ) THEN
    UPDATE connector_templates
      SET setup_instructions = COALESCE(setup_hint, setup_instructions)
      WHERE (setup_instructions IS NULL OR setup_instructions = '')
        AND setup_hint IS NOT NULL;
    ALTER TABLE connector_templates DROP COLUMN setup_hint;
  END IF;
END $$;

-- Back-fill url_pattern from base_url for legacy rows.
UPDATE connector_templates
  SET url_pattern = '^' || regexp_replace(base_url, '([.\\\/+?()\\[\\]{}|^$])', '\\\\\\1', 'g') || '(/|$)'
  WHERE url_pattern = '';
