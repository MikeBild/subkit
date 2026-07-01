ALTER TABLE "mcp_tasks" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "last_action" text;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "progress_step" text;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "heartbeat_at" timestamp with time zone;
