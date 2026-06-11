-- Persist the run input on the execution row.
--
-- Why: rerunning an execution faithfully was impossible — the original
-- input only lived in the transient job payload (and truncated
-- per-step previews), so `sk executions rerun` silently re-ran with no
-- input. POST /v1/executions/{id}/rerun defaults to this column and
-- pins the original workflow_version_id; parent_execution_id carries
-- the lineage.

ALTER TABLE "executions" ADD COLUMN "input" jsonb;
