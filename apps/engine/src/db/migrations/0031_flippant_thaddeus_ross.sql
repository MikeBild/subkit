ALTER TABLE "mcp_tasks" ADD COLUMN "parked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "parked_reason" text;