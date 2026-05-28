-- Partial index supporting the `wf_<slug>` tool catalog's LRU pick.
-- `listWorkflowToolsForTenant` reads workflows where
-- `tenant_id = $1 AND deleted_at IS NULL AND is_tool = TRUE` ordered by
-- `last_executed_at DESC NULLS LAST, created_at ASC` and capped at 40.
-- For tenants with thousands of workflows the planner would otherwise
-- fall back to a scan; this partial index keeps the LRU pick index-only.

CREATE INDEX IF NOT EXISTS workflows_tool_catalog_lru_idx
  ON workflows (tenant_id, last_executed_at DESC NULLS LAST, created_at ASC)
  WHERE is_tool = TRUE AND deleted_at IS NULL;
