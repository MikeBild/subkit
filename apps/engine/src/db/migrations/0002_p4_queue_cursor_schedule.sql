-- P4: queue + cron + pub/sub.
--
-- 1. outbox_cursors needs a composite (listener_id, channel) primary key so
--    a single listener can track per-channel catch-up watermarks.
-- 2. workflows_schedules gains an `input` jsonb column so the reconciler can
--    hand a canned input to execution.run when the cron fires.

ALTER TABLE "outbox_cursors" DROP CONSTRAINT IF EXISTS "outbox_cursors_pkey";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "outbox_cursors" ADD CONSTRAINT "outbox_cursors_pkey" PRIMARY KEY ("listener_id","channel");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "input" jsonb;
