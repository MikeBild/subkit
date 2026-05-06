-- Inbound runtime signals for wait-for-event steps (#49). External
-- approvers (Slack reaction, ServiceNow ticket close, customer reply)
-- POST to /v1/runs/{id}/signals; the row stays until the wait-for-event
-- step matches + consumes it, or until a retention sweep deletes
-- anything older than `wait_timeout + 24h grace`.
--
-- The `(tenant_id, execution_id, event_name)` index covers the match
-- query the poller runs once a second per active wait-for-event step.

CREATE TABLE IF NOT EXISTS "workflow_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "execution_id" uuid NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_signals_match_idx"
  ON "workflow_signals" ("tenant_id", "execution_id", "event_name");

CREATE INDEX IF NOT EXISTS "workflow_signals_received_at_idx"
  ON "workflow_signals" ("received_at");
