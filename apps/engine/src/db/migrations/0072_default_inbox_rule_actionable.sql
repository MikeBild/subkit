-- Narrow the seeded sk CLI inbox rule to the events a person may have to act on.
--
-- The default rule used to match every event (`*`). The inbox adapter already
-- dropped non-actionable events, but the dispatcher still logged each one as
-- a sent notification plus a `chat.message.sent` audit row, so every workflow
-- step wrote two rows of noise. The seed now writes the actionable list
-- (`DEFAULT_CLI_INBOX_EVENT_PATTERN` in `db/seed.ts`); this brings existing
-- tenants' default rule to the same value.
--
-- Only the rule still in its exact seeded shape is touched: a rule a user
-- renamed, retargeted or refiltered is theirs and stays as it is.
UPDATE "notification_rules"
SET "event_pattern" = 'execution.failed,connector.oauth.callback_failed,connector.auth_failed,connector.health_changed,patch.proposed',
    "updated_at" = now()
WHERE "name" = 'sk CLI inbox (default)'
  AND "target_workspace_id" = '_cli'
  AND "target_channel_id" = '_inbox'
  AND "event_pattern" = '*'
  AND "workflow_pattern" = '*'
  AND "severity" = 'info'
  AND "request_source_filter" IS NULL;
