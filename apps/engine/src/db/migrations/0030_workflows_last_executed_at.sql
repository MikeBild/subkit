-- LRU signal for the `wf_<slug>` tool catalog. The chat + MCP catalogs
-- ship the 40 most-recently-used workflows to the LLM palette; the rest
-- stay reachable via the always-available `run_workflow(workflow=<slug>)`
-- fallback. Populated by `runExecution` on every saved-source run.
--
-- Nullable so existing rows survive unchanged; the catalog selector
-- treats NULL as "older than every dated row" via `ORDER BY
-- last_executed_at DESC NULLS LAST`.

ALTER TABLE workflows ADD COLUMN last_executed_at timestamptz;
