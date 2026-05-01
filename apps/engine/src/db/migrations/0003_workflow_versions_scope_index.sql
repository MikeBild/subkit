-- Per-step authoring scope vocabulary on workflow_versions.
--
-- After every successful dry_run / run on a draft, the engine builds
-- a compact `step_id → scope_at_step` map (available_paths +
-- shape_summary + primary_data_path). That map currently lives only
-- on the conversation's `latest_preview` slot — committing the draft
-- discards it.
--
-- A repair / re-author session that opens months later has to re-run
-- the whole workflow before the LLM can see real shapes again. With
-- this column the most recent shape vocabulary lives next to the DAG,
-- so `inspect_workflow` / `suggest_jsonata_paths` can populate from
-- the persisted version without a fresh execution.

ALTER TABLE "workflow_versions"
  ADD COLUMN IF NOT EXISTS "scope_index" jsonb;
--> statement-breakpoint
