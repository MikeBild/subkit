ALTER TABLE "task_runs" ADD COLUMN IF NOT EXISTS "progress_marks" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_progress_marks_check";--> statement-breakpoint
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_progress_marks_check" CHECK (jsonb_typeof("task_runs"."progress_marks") = 'array');