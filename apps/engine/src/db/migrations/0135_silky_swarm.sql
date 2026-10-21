ALTER TABLE "executions" ADD COLUMN "origin_source" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "audit_trace_id" text;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "origin_source" text;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD COLUMN "audit_trace_id" text;