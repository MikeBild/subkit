-- Chat-bridge inbound event dedup. Slack retries every Events API post
-- up to 3× with the same `event_id`; without this table the dispatcher
-- would run the same turn multiple times.
--
-- Mirrors `webhook_replay_seen` for inbound webhooks. The chat.event
-- queue handler INSERTs at the start of every job and treats a
-- unique-violation as "drop — replay". The row must commit *before*
-- the dispatcher runs, or a retry that arrives mid-turn can
-- double-dispatch.
--
-- `workspace_id` is the `chat_workspaces.id` UUID (not the
-- platform-native team/workspace id). `platform_event_id` is the
-- platform-native id: Slack `event_id` (Events API), `view.id`
-- (view_submission), `trigger_id` (block_actions), or a stable hash
-- of (command+text+trigger_id) for slash commands.
CREATE TABLE IF NOT EXISTS "chat_events_seen" (
  "tenant_id"          uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id"       uuid NOT NULL REFERENCES "chat_workspaces"("id") ON DELETE CASCADE,
  "platform_event_id"  text NOT NULL,
  "seen_at"            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_events_seen_key"
  ON "chat_events_seen" ("workspace_id", "platform_event_id");

CREATE INDEX IF NOT EXISTS "chat_events_seen_seen_at_idx"
  ON "chat_events_seen" ("seen_at");
