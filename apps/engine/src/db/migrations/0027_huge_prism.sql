ALTER TABLE "conversation_tool_calls" ADD COLUMN "confirmation_state" text;--> statement-breakpoint
ALTER TABLE "conversation_tool_calls" ADD COLUMN "confirmation_data" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_tool_calls" ADD COLUMN "interaction_log" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "loaded_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "tool_policies" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "outcome_window_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "outcome_successes_after" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "outcome_failures_after" integer DEFAULT 0 NOT NULL;