ALTER TABLE "cockpit_push_subscriptions" ADD COLUMN IF NOT EXISTS "auto_pause_notified_at" timestamp with time zone;--> statement-breakpoint
UPDATE subkit.tool_approval_rules SET expires_at = created_at + interval '90 days' WHERE state = 'active' AND expires_at IS NULL;--> statement-breakpoint
UPDATE subkit.workflows_schedules SET failures_reset_at = now() WHERE failures_reset_at IS NULL;