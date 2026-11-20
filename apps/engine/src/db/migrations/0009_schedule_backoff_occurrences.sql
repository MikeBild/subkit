CREATE TABLE IF NOT EXISTS "schedule_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid,
	"task_id" uuid,
	"schedule_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"last_due_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"state" text NOT NULL,
	"reason_code" text,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"execution_id" uuid,
	"task_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_occurrences_subject_check" CHECK (("schedule_occurrences"."workflow_id" IS NULL) <> ("schedule_occurrences"."task_id" IS NULL)),
	CONSTRAINT "schedule_occurrences_state_check" CHECK ("schedule_occurrences"."state" IN ('ran', 'ran_late', 'skipped', 'held')),
	CONSTRAINT "schedule_occurrences_reason_check" CHECK ("schedule_occurrences"."reason_code" IS NULL OR "schedule_occurrences"."reason_code" ~ '^[a-z][a-z0-9_]{0,99}$'),
	CONSTRAINT "schedule_occurrences_window_check" CHECK ("schedule_occurrences"."last_due_at" >= "schedule_occurrences"."due_at" AND "schedule_occurrences"."skipped_count" BETWEEN 0 AND 100000),
	CONSTRAINT "schedule_occurrences_run_check" CHECK (("schedule_occurrences"."state" IN ('ran', 'ran_late')) = ("schedule_occurrences"."started_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task_grants" ADD COLUMN IF NOT EXISTS "expiry_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD COLUMN IF NOT EXISTS "expiry_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "paused_reason" text;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "paused_failure_class" text;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "paused_failure_count" integer;--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD COLUMN IF NOT EXISTS "failures_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" DROP CONSTRAINT IF EXISTS "schedule_occurrences_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" DROP CONSTRAINT IF EXISTS "schedule_occurrences_workflow_id_workflows_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "subkit"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_occurrences" DROP CONSTRAINT IF EXISTS "schedule_occurrences_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "schedule_occurrences" ADD CONSTRAINT "schedule_occurrences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "subkit"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_occurrences_workflow_idx" ON "schedule_occurrences" USING btree ("tenant_id","workflow_id","due_at" DESC NULLS LAST) WHERE "schedule_occurrences"."workflow_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_occurrences_task_idx" ON "schedule_occurrences" USING btree ("tenant_id","task_id","due_at" DESC NULLS LAST) WHERE "schedule_occurrences"."task_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedule_occurrences_retention_idx" ON "schedule_occurrences" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "workflows_schedules" DROP CONSTRAINT IF EXISTS "workflows_schedules_auto_pause_check";--> statement-breakpoint
ALTER TABLE "workflows_schedules" ADD CONSTRAINT "workflows_schedules_auto_pause_check" CHECK (("workflows_schedules"."paused_reason" IS NULL AND "workflows_schedules"."paused_at" IS NULL AND "workflows_schedules"."paused_failure_class" IS NULL AND "workflows_schedules"."paused_failure_count" IS NULL) OR ("workflows_schedules"."paused" AND "workflows_schedules"."paused_at" IS NOT NULL AND "workflows_schedules"."paused_reason" = 'repeated_failures' AND char_length("workflows_schedules"."paused_failure_class") BETWEEN 1 AND 200 AND "workflows_schedules"."paused_failure_count" >= 1));
