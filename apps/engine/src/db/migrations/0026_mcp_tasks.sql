-- MCP async Tasks (SEP-1686) — thin correlation index for backgrounded
-- conversation turns. One row per turn that was handed to a
-- `conversation.run-turn` pg-boss worker so the MCP `tools/call` could
-- return immediately. `id` IS the MCP taskId. Task lifecycle state is
-- DERIVED at read time from the owning conversations row + the pg-boss
-- job + pending conversation_elicitations; this table only owns
-- `result`, `failure_reason`, and `cancelled_at` as a source of truth.
-- `user_message_id` is correlation metadata: it pins the exact user
-- row the turn runs on so concurrent turns don't race on created_at.
CREATE TABLE IF NOT EXISTS "mcp_tasks" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "turn_seq"        integer NOT NULL,
  "kind"            text NOT NULL CHECK ("kind" IN ('start', 'append', 'respond_elicitation')),
  "job_id"          text,
  "request_source"  text,
  "actor_id"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- The exact `conversation_messages` user row this turn must run on.
  -- Captured by the MCP handler when it persists the user message, so the
  -- worker reads THAT message by id instead of the most-recent one — two
  -- turns in flight on one conversation otherwise race on MAX(created_at)
  -- and one turn silently runs on the wrong message. Null for
  -- `respond_elicitation` turns (no new user message).
  "user_message_id" uuid REFERENCES "conversation_messages"("id") ON DELETE SET NULL,
  "result"          jsonb,
  "failure_reason"  text,
  "cancelled_at"    timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "mcp_tasks_conv_turn_idx"
  ON "mcp_tasks" ("tenant_id", "conversation_id", "turn_seq");

CREATE INDEX IF NOT EXISTS "mcp_tasks_tenant_created_idx"
  ON "mcp_tasks" ("tenant_id", "created_at");
