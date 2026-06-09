-- sk CLI notification inbox.
--
-- Durable, pull-based notification channel for the `sk` CLI. The default
-- rule (`_cli` / `_inbox`) routes every matching event into this table via
-- the `SkCliAdapter` — a local INSERT, no chat platform involved. The CLI
-- polls `GET /v1/notifications/inbox?since=<cursor>` and acknowledges
-- (deletes) consumed rows via `POST /v1/notifications/inbox/ack`. The
-- `(tenant_id, id)` index serves the monotonic cursor walk.
CREATE TABLE IF NOT EXISTS "cli_notification_inbox" (
  "id"             bigserial PRIMARY KEY,
  "tenant_id"      uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "delivery_id"    uuid REFERENCES "notification_deliveries"("id") ON DELETE SET NULL,
  "severity"       text NOT NULL,
  "event_type"     text NOT NULL,
  "event_payload"  jsonb,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cli_notification_inbox_tenant_cursor_idx"
  ON "cli_notification_inbox" ("tenant_id", "id");
--> statement-breakpoint
-- Backfill the default sk CLI inbox rule for every existing tenant.
-- Idempotent: guarded by the `(_cli, _inbox)` target so re-running the
-- migration (or seeding a tenant that already has it) is a no-op.
INSERT INTO notification_rules
  (tenant_id, name, event_pattern, workflow_pattern, severity,
   request_source_filter, target_workspace_id, target_channel_id, active)
SELECT t.id, 'sk CLI inbox (default)', '*', '*', 'info', NULL, '_cli', '_inbox', true
FROM tenants t
WHERE NOT EXISTS (SELECT 1 FROM notification_rules r
  WHERE r.tenant_id = t.id AND r.target_workspace_id = '_cli' AND r.target_channel_id = '_inbox');
