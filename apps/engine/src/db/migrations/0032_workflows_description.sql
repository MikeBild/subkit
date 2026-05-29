-- First-class, editable workflow description column.
--
-- A workflow's description previously lived only inside the DAG
-- (`WorkflowDef.description`), with no metadata-level edit path: the
-- `update_workflow` tool (slug / name / lifecycle) rejected a `description`
-- key outright, so the LLM's natural "set the description" action failed
-- and the surface text stayed empty.
--
-- This column is the canonical source for the LLM-facing `wf_<slug>` tool
-- description. The catalog selector prefers it, then falls back to the
-- DAG's `description`, then to `name` (apps/engine/src/workflows/catalog.ts).
-- Editing it via `update_workflow` is a metadata patch — no new version.
--
-- Nullable so existing rows survive unchanged and fall through to the
-- DAG/name fallback.

ALTER TABLE workflows ADD COLUMN description text;
