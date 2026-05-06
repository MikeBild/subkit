-- In-flight wait checkpoints (#48 SHRUNK). One row per active wait
-- step. Written at step start, deleted at step completion. Restart
-- safety: engine boot reads this table to resume waits whose process
-- died mid-setTimeout (rows in the past resume immediately; future
-- rows re-enqueue an execution.run with sendAfter).
--
-- Cap is 24h via the Zod schema; multi-day patterns use Schedule + State
-- recipes, not durable wait.

CREATE TABLE IF NOT EXISTS "workflow_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "step_id" text NOT NULL,
  "sleep_until_ts" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_waits_tenant_execution_step_uniq"
  ON "workflow_waits" ("tenant_id", "execution_id", "step_id");

CREATE INDEX IF NOT EXISTS "workflow_waits_sleep_until_idx"
  ON "workflow_waits" ("sleep_until_ts");
